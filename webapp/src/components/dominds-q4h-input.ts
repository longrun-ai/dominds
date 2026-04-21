/**
 * Q4H (Questions for Human) Input Component
 *
 * Owns only the input + answer routing (selected question id).
 * The Q4H question list UI is rendered by the bottom-panel Q4H tab
 * (`dominds-q4h-panel`).
 */

import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { Q4HDialogContext } from '@longrun-ai/kernel/types/q4h';
import type { AssignmentFromSup, DialogIdent } from '@longrun-ai/kernel/types/wire';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { getUiStrings } from '../i18n/ui';
import {
  loadViewportScopedNumber,
  saveViewportScopedNumber,
} from '../services/viewport-size-storage';
import { getWebSocketManager } from '../services/websocket.js';
import { dispatchDomindsEvent } from './dom-events';
import { ICON_MASK_BASE_CSS, ICON_MASK_URLS } from './icon-masks';

export interface Q4HQuestion {
  id: string;
  tellaskContent: string;
  askedAt: string;
  dialogContext: Q4HDialogContext;
}

interface Q4HInputProps {
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
}

interface ImageAttachment {
  id: string;
  mimeType: string;
  byteLength: number;
  dataBase64: string;
  objectUrl: string;
  name: string;
}

type DialogContext = DialogIdent & {
  assignmentFromSup?: AssignmentFromSup;
};

const RESIZE_HANDLE_ARIA_LABEL_I18N = {
  zh: '调整输入区高度',
  en: 'Resize input height',
} as const;

const IMAGE_ATTACHMENT_I18N = {
  zh: {
    remove: '移除图片',
    preview: '查看图片',
    close: '关闭图片预览',
    tooMany: '最多只能添加 10 张图片',
    tooLarge: '单张图片不能超过 10 MB',
    unsupported: '只支持 PNG、JPEG、WebP、GIF 图片',
    readFailed: '读取图片失败',
    imageOnlyPrompt: '请看附件图片。',
  },
  en: {
    remove: 'Remove image',
    preview: 'View image',
    close: 'Close image preview',
    tooMany: 'You can attach up to 10 images',
    tooLarge: 'Each image must be 10 MB or smaller',
    unsupported: 'Only PNG, JPEG, WebP, and GIF images are supported',
    readFailed: 'Failed to read image',
    imageOnlyPrompt: 'Please inspect the attached image.',
  },
} as const;

export class DomindsQ4HInput extends HTMLElement {
  private static readonly MIN_HOST_HEIGHT_PX = 100;
  private static readonly AUTO_RESIZE_MAX_VIEWPORT_RATIO = 0.5;
  private static readonly MANUAL_RESIZE_MAX_VIEWPORT_RATIO = 2 / 3;
  private static readonly AUTO_RESIZE_EXTRA_GAP_PX = 0;
  private wsManager = getWebSocketManager();
  private uiLanguage: LanguageCode = 'en';

  private static readonly SEND_ON_ENTER_STORAGE_KEY = 'dominds-send-on-enter';
  private static readonly INPUT_HISTORY_STORAGE_KEY = 'dominds-user-input-history-v1';
  private static readonly INPUT_HISTORY_MAX = 100;
  private static readonly MANUAL_HEIGHT_STORAGE_KEY = 'dominds-q4h-input-height-px-v1';
  private static readonly IMAGE_ATTACHMENT_MAX_COUNT = 10;
  private static readonly IMAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

  private questions: Q4HQuestion[] = [];
  private selectedQuestionId: string | null = null;
  private sendOnEnter = true;
  private isComposing = false;
  private inputUiRafId: number | null = null;
  private escPrimedAtMs: number | null = null;
  private lastQ4HRefreshRequestedAtMs: number | null = null;
  private props: Q4HInputProps = {
    disabled: false,
    placeholder: 'Type your answer...',
    maxLength: 4000,
  };
  private currentDialog: DialogContext | null = null;
  private displayState: DialogDisplayState | null = null;
  private primaryActionMode: 'send' | 'queue_now' | 'stop' | 'stopping' = 'send';

  private inputHistory: string[] = [];
  private inputHistoryCursor: number | null = null; // 0..len, where len means draft/current
  private inputHistoryDraft: string | null = null;
  private imageAttachments: ImageAttachment[] = [];
  private openImageAttachmentId: string | null = null;
  private imageDragDepth = 0;

  private textInput!: HTMLTextAreaElement;
  private measureTextarea!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private declareDeathButton!: HTMLButtonElement;
  private inputWrapper!: HTMLElement;

  private resizeHandle!: HTMLDivElement;
  private manualHeightPx: number | null = null;
  private autoResizeBaseHostHeightPx: number | null = null;
  private autoResizeCaptureArmed = false;
  private manualResizeMinPx: number = 0;
  private manualResizeMaxPx: number = 0;
  private manualResizeStartY: number = 0;
  private manualResizeStartHeight: number = 0;
  private isManualResizing: boolean = false;
  private boundManualMove?: (e: PointerEvent) => void;
  private boundManualUp?: (e: PointerEvent) => void;
  private boundManualLostCapture?: (e: PointerEvent) => void;
  private activePointerId: number | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.restoreSendOnEnterPreference();
    this.restoreInputHistory();
    this.render();
    this.setupEventListeners();
    this.updateUI();
    this.recomputeResizeBounds();
    this.restoreManualHeightForCurrentViewport();
    this.applyHeightConstraints();
    // Ensure initial textarea height is stable (avoid "growing a bit" on first blur).
    this.scheduleInputUiUpdate();
  }

  private restoreSendOnEnterPreference(): void {
    try {
      const raw = localStorage.getItem(DomindsQ4HInput.SEND_ON_ENTER_STORAGE_KEY);
      if (raw === '1') {
        this.sendOnEnter = true;
      } else if (raw === '0') {
        this.sendOnEnter = false;
      }
    } catch {
      // ignore
    }
  }

  private persistSendOnEnterPreference(): void {
    try {
      localStorage.setItem(DomindsQ4HInput.SEND_ON_ENTER_STORAGE_KEY, this.sendOnEnter ? '1' : '0');
    } catch {
      // ignore
    }
  }

  disconnectedCallback(): void {
    if (this.inputUiRafId !== null) {
      window.cancelAnimationFrame(this.inputUiRafId);
      this.inputUiRafId = null;
    }
    this.revokeImageAttachments();
    this.finishManualResize(false);
    if (this.boundOnWindowResize) {
      window.removeEventListener('resize', this.boundOnWindowResize);
    }
  }

  private boundOnWindowResize = (): void => {
    this.recomputeResizeBounds();
    this.restoreManualHeightForCurrentViewport();
    if (this.manualHeightPx === null) {
      this.autoResizeBaseHostHeightPx = null;
      this.autoResizeCaptureArmed = false;
    }
    this.applyHeightConstraints();
    this.scheduleInputUiUpdate();
  };

  private recomputeResizeBounds(): void {
    const maxHost = Math.floor(
      window.innerHeight * DomindsQ4HInput.MANUAL_RESIZE_MAX_VIEWPORT_RATIO,
    );
    this.manualResizeMinPx = DomindsQ4HInput.MIN_HOST_HEIGHT_PX;
    this.manualResizeMaxPx = Math.max(this.manualResizeMinPx, maxHost);
  }

  private getHostChromeHeightPx(): number {
    const container = this.shadowRoot?.querySelector('.q4h-input-container');
    const section = this.shadowRoot?.querySelector('.input-section');
    const wrapper = this.inputWrapper;
    if (!(container instanceof HTMLElement) || !(section instanceof HTMLElement) || !wrapper) {
      return 38;
    }

    const containerStyle = window.getComputedStyle(container);
    const sectionStyle = window.getComputedStyle(section);
    const wrapperStyle = window.getComputedStyle(wrapper);

    const borderBottom = Number.parseFloat(containerStyle.borderBottomWidth) || 0;
    const borderTop = Number.parseFloat(sectionStyle.borderTopWidth) || 0;
    const paddingTop = Number.parseFloat(sectionStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(sectionStyle.paddingBottom) || 0;
    const wrapperBorderTop = Number.parseFloat(wrapperStyle.borderTopWidth) || 0;
    const wrapperBorderBottom = Number.parseFloat(wrapperStyle.borderBottomWidth) || 0;

    return (
      borderBottom + borderTop + paddingTop + paddingBottom + wrapperBorderTop + wrapperBorderBottom
    );
  }

  private applyHeightConstraints(): void {
    const baselineHeightPx = this.getBaselineHostHeightPx();
    if (baselineHeightPx === null) {
      this.style.height = '';
      this.style.maxHeight = '';
      this.style.minHeight = `${this.manualResizeMinPx}px`;
      return;
    }
    this.style.height = `${baselineHeightPx}px`;
    this.style.maxHeight = `${baselineHeightPx}px`;
    this.style.minHeight = `${this.manualResizeMinPx}px`;
  }

  private restoreManualHeightForCurrentViewport(): void {
    const storedHeightPx = loadViewportScopedNumber(DomindsQ4HInput.MANUAL_HEIGHT_STORAGE_KEY);
    this.manualHeightPx = storedHeightPx;
  }

  private persistManualHeightForCurrentViewport(): void {
    if (this.manualHeightPx === null) return;
    saveViewportScopedNumber(DomindsQ4HInput.MANUAL_HEIGHT_STORAGE_KEY, this.manualHeightPx);
  }

  private clampHostHeightPx(heightPx: number): number {
    return Math.max(this.manualResizeMinPx, Math.min(this.manualResizeMaxPx, heightPx));
  }

  private getCurrentHostHeightPx(): number {
    const rect = this.getBoundingClientRect();
    if (rect.height > 0) return rect.height;
    return this.offsetHeight;
  }

  private getBaselineHostHeightPx(): number | null {
    const baselineHeightPx = this.manualHeightPx ?? this.autoResizeBaseHostHeightPx;
    if (baselineHeightPx === null) return null;
    return this.clampHostHeightPx(baselineHeightPx);
  }

  private setHostHeightPx(heightPx: number | null): void {
    if (heightPx === null) {
      this.style.height = '';
      this.style.maxHeight = '';
      this.style.minHeight = `${this.manualResizeMinPx}px`;
      return;
    }
    const clamped = this.clampHostHeightPx(heightPx);
    this.style.height = `${clamped}px`;
    this.style.maxHeight = `${clamped}px`;
    this.style.minHeight = `${this.manualResizeMinPx}px`;
  }

  private finishManualResize(shouldPersist: boolean): void {
    const pointerId = this.activePointerId;

    if (this.boundManualMove) {
      window.removeEventListener('pointermove', this.boundManualMove, true);
    }
    if (this.boundManualUp) {
      window.removeEventListener('pointerup', this.boundManualUp, true);
      window.removeEventListener('pointercancel', this.boundManualUp, true);
      this.resizeHandle?.removeEventListener('pointerup', this.boundManualUp);
      this.resizeHandle?.removeEventListener('pointercancel', this.boundManualUp);
    }
    if (this.boundManualLostCapture) {
      this.resizeHandle?.removeEventListener('lostpointercapture', this.boundManualLostCapture);
    }

    this.isManualResizing = false;
    this.activePointerId = null;
    this.boundManualMove = undefined;
    this.boundManualUp = undefined;
    this.boundManualLostCapture = undefined;

    if (pointerId !== null) {
      try {
        if (this.resizeHandle?.hasPointerCapture(pointerId)) {
          this.resizeHandle.releasePointerCapture(pointerId);
        }
      } catch {
        // ignore
      }
    }

    if (shouldPersist && this.manualHeightPx !== null) {
      this.persistManualHeightForCurrentViewport();
    }
  }

  private getMeasuredTextareaScrollHeightPx(): number {
    const input = this.textInput;
    const measurer = this.measureTextarea;
    if (!input || !measurer) {
      return 0;
    }

    const computed = window.getComputedStyle(input);
    measurer.style.width = `${input.clientWidth}px`;
    measurer.style.paddingTop = computed.paddingTop;
    measurer.style.paddingRight = computed.paddingRight;
    measurer.style.paddingBottom = computed.paddingBottom;
    measurer.style.paddingLeft = computed.paddingLeft;
    measurer.style.font = computed.font;
    measurer.style.lineHeight = computed.lineHeight;
    measurer.style.letterSpacing = computed.letterSpacing;
    measurer.style.textIndent = computed.textIndent;
    measurer.style.textTransform = computed.textTransform;
    measurer.style.wordSpacing = computed.wordSpacing;
    measurer.style.tabSize = computed.tabSize;
    measurer.style.whiteSpace = computed.whiteSpace;
    measurer.style.overflowWrap = computed.overflowWrap;

    const value = input.value.endsWith('\n') ? `${input.value} ` : input.value;
    measurer.value = value.length > 0 ? value : ' ';
    return measurer.scrollHeight;
  }

  private getAttachmentStripHeightPx(): number {
    const strip = this.shadowRoot?.querySelector('.attachment-strip');
    if (!(strip instanceof HTMLElement)) {
      return 0;
    }

    const rect = strip.getBoundingClientRect();
    if (rect.height > 0) {
      return rect.height;
    }
    return strip.offsetHeight;
  }

  private static escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private revokeImageAttachments(): void {
    for (const attachment of this.imageAttachments) {
      URL.revokeObjectURL(attachment.objectUrl);
    }
    this.imageAttachments = [];
    this.openImageAttachmentId = null;
  }

  private isSupportedImageMimeType(mimeType: string): boolean {
    return (
      mimeType === 'image/png' ||
      mimeType === 'image/jpeg' ||
      mimeType === 'image/webp' ||
      mimeType === 'image/gif'
    );
  }

  private makeAttachmentId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `img_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  private async fileToBase64(file: File): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader returned non-string result'));
          return;
        }
        const commaIndex = result.indexOf(',');
        if (commaIndex < 0) {
          reject(new Error('FileReader data URL missing payload'));
          return;
        }
        resolve(result.slice(commaIndex + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(file);
    });
  }

  private async addImageFiles(files: readonly File[]): Promise<void> {
    const t = IMAGE_ATTACHMENT_I18N[this.uiLanguage];
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    if (
      this.imageAttachments.length + imageFiles.length >
      DomindsQ4HInput.IMAGE_ATTACHMENT_MAX_COUNT
    ) {
      throw new Error(t.tooMany);
    }

    const nextAttachments: ImageAttachment[] = [];
    try {
      for (const file of imageFiles) {
        if (!this.isSupportedImageMimeType(file.type)) {
          throw new Error(t.unsupported);
        }
        if (file.size <= 0 || file.size > DomindsQ4HInput.IMAGE_ATTACHMENT_MAX_BYTES) {
          throw new Error(t.tooLarge);
        }
        nextAttachments.push({
          id: this.makeAttachmentId(),
          mimeType: file.type,
          byteLength: file.size,
          dataBase64: await this.fileToBase64(file),
          objectUrl: URL.createObjectURL(file),
          name: file.name.trim() || file.type,
        });
      }
    } catch (error: unknown) {
      for (const attachment of nextAttachments) {
        URL.revokeObjectURL(attachment.objectUrl);
      }
      throw error;
    }

    this.imageAttachments = [...this.imageAttachments, ...nextAttachments];
    this.safeRender();
    this.scheduleInputUiUpdate();
  }

  private hasDraggedFiles(event: DragEvent): boolean {
    const dataTransfer = event.dataTransfer;
    if (dataTransfer === null) return false;
    return Array.from(dataTransfer.types).includes('Files');
  }

  private setImageDropActive(active: boolean): void {
    this.inputWrapper.classList.toggle('image-drop-active', active && !this.props.disabled);
  }

  private resetImageDragState(): void {
    this.imageDragDepth = 0;
    if (this.inputWrapper) {
      this.inputWrapper.classList.remove('image-drop-active');
    }
  }

  private handleDroppedImageFiles(files: readonly File[]): void {
    if (this.props.disabled) {
      const t = getUiStrings(this.uiLanguage);
      this.showError(t.inputNotAvailableToast);
      return;
    }

    void this.addImageFiles(files).catch((error: unknown) => {
      console.error('Failed to add dropped image:', error);
      const t = IMAGE_ATTACHMENT_I18N[this.uiLanguage];
      this.showError(error instanceof Error ? error.message : t.readFailed);
    });
  }

  private removeImageAttachment(id: string): void {
    const existing = this.imageAttachments.find((attachment) => attachment.id === id);
    if (existing) {
      URL.revokeObjectURL(existing.objectUrl);
    }
    this.imageAttachments = this.imageAttachments.filter((attachment) => attachment.id !== id);
    if (this.openImageAttachmentId === id) {
      this.openImageAttachmentId = null;
    }
    this.safeRender();
    this.scheduleInputUiUpdate();
  }

  private getOutgoingAttachments(): Array<{
    kind: 'image';
    mimeType: string;
    byteLength: number;
    dataBase64: string;
  }> {
    return this.imageAttachments.map((attachment) => ({
      kind: 'image',
      mimeType: attachment.mimeType,
      byteLength: attachment.byteLength,
      dataBase64: attachment.dataBase64,
    }));
  }

  public setUiLanguage(language: LanguageCode): void {
    this.uiLanguage = language;
    const t = getUiStrings(language);
    this.props.placeholder = t.q4hInputPlaceholder;
    if (this.textInput) {
      this.textInput.placeholder = t.q4hInputPlaceholder;
    }

    const root = this.shadowRoot;
    if (!root) return;

    this.updateEnterToggleTitle(this.resolvePrimaryActionMode());

    this.applyPrimaryActionMode();

    if (this.declareDeathButton) {
      this.declareDeathButton.textContent = t.declareDeath;
      this.declareDeathButton.title = t.declareDeath;
      this.declareDeathButton.setAttribute('aria-label', t.declareDeath);
    }
  }

  public setQuestions(questions: Q4HQuestion[]): void {
    this.questions = questions;

    if (this.selectedQuestionId !== null) {
      const stillExists = this.questions.some((q) => q.id === this.selectedQuestionId);
      if (!stillExists) this.selectedQuestionId = null;
    }

    this.updateUI();
    this.updateSendButton();
  }

  public getQuestions(): readonly Q4HQuestion[] {
    return this.questions;
  }

  public getQuestionCount(): number {
    return this.questions.length;
  }

  public selectQuestion(questionId: string | null): void {
    if (questionId === this.selectedQuestionId) return;
    this.selectedQuestionId = questionId;
    this.updateUI();
    this.updateSendButton();

    const question = this.questions.find((q) => q.id === questionId);
    if (question) {
      dispatchDomindsEvent(
        this,
        'q4h-select-question',
        {
          questionId,
          dialogId: question.dialogContext.selfId,
          rootId: question.dialogContext.rootId,
          tellaskContent: question.tellaskContent,
        },
        { bubbles: true, composed: true },
      );
    }
  }

  public getSelectedQuestionId(): string | null {
    return this.selectedQuestionId;
  }

  public setDialog(dialog: DialogContext): void {
    if (typeof dialog.selfId !== 'string' || typeof dialog.rootId !== 'string') {
      const t = getUiStrings(this.uiLanguage);
      this.showError(t.q4hInvalidDialogToast);
      return;
    }
    this.currentDialog = dialog;
    this.updateUI();
  }

  public clearDialog(): void {
    this.currentDialog = null;
    this.displayState = null;
    this.updateUI();
  }

  public setDisplayState(displayState: DialogDisplayState | null): void {
    this.displayState = displayState;
    this.applyPrimaryActionMode();
    this.updateUI();
  }

  private hasSelectedQ4HTarget(): boolean {
    return (
      this.selectedQuestionId !== null &&
      this.questions.some((q) => q.id === this.selectedQuestionId)
    );
  }

  private resolvePrimaryActionMode(): 'send' | 'queue_now' | 'stop' | 'stopping' {
    // Design choice: when a Q4H item is selected, primary action is always "send answer".
    // The selected Q4H target is treated as the active routing context and intentionally
    // takes precedence over stop semantics for the currently selected dialog.
    // Do not reorder this priority without revisiting the product behavior.
    if (this.hasSelectedQ4HTarget()) return 'send';
    if (this.currentDialog === null) return 'send';

    const hasContent =
      (this.textInput?.value ?? '').trim().length > 0 || this.imageAttachments.length > 0;
    const state = this.displayState;
    if (state === null) return 'send';
    if (state.kind === 'proceeding_stop_requested') return 'stopping';
    if (state.kind === 'proceeding') return hasContent ? 'queue_now' : 'stop';
    return 'send';
  }

  private getEnterToggleTitle(mode: 'send' | 'queue_now' | 'stop' | 'stopping'): string {
    const t = getUiStrings(this.uiLanguage);
    if (mode === 'queue_now') {
      return this.sendOnEnter ? t.q4hEnterToQueueNowTitle : t.q4hCtrlEnterToQueueNowTitle;
    }
    if (mode === 'stop' || mode === 'stopping') {
      return this.sendOnEnter ? t.q4hEnterToStopTitle : t.q4hCtrlEnterToStopTitle;
    }
    return this.sendOnEnter ? t.q4hEnterToSendTitle : t.q4hCtrlEnterToSendTitle;
  }

  private updateEnterToggleTitle(mode: 'send' | 'queue_now' | 'stop' | 'stopping'): void {
    const root = this.shadowRoot;
    if (!root) return;
    const toggle = root.querySelector('.send-on-enter-toggle') as HTMLButtonElement | null;
    if (!toggle) return;
    const title = this.getEnterToggleTitle(mode);
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
  }

  private applyPrimaryActionMode(): void {
    if (!this.sendButton) return;
    const t = getUiStrings(this.uiLanguage);
    const nextMode = this.resolvePrimaryActionMode();
    const title =
      nextMode === 'send'
        ? t.send
        : nextMode === 'queue_now'
          ? t.queueNow
          : nextMode === 'stop'
            ? t.stop
            : t.stopping;
    this.sendButton.title = title;
    this.sendButton.setAttribute('aria-label', title);

    if (nextMode === this.primaryActionMode) {
      return;
    }

    this.primaryActionMode = nextMode;
    this.sendButton.classList.toggle('queue', nextMode === 'queue_now');
    this.sendButton.classList.toggle('stop', nextMode === 'stop' || nextMode === 'stopping');
    if (nextMode === 'send') {
      this.sendButton.innerHTML = '<span class="send-icon icon-mask" aria-hidden="true"></span>';
      return;
    }
    if (nextMode === 'queue_now') {
      this.sendButton.innerHTML = '<span class="queue-icon icon-mask" aria-hidden="true"></span>';
      return;
    }
    this.sendButton.innerHTML = '<span class="stop-icon icon-mask" aria-hidden="true"></span>';
  }

  private restoreInputHistory(): void {
    try {
      const raw = localStorage.getItem(DomindsQ4HInput.INPUT_HISTORY_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const items: string[] = [];
      for (const item of parsed) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed === '') continue;
        items.push(trimmed);
      }
      this.inputHistory = items.slice(-DomindsQ4HInput.INPUT_HISTORY_MAX);
    } catch {
      // ignore
    }
  }

  private persistInputHistory(): void {
    try {
      localStorage.setItem(
        DomindsQ4HInput.INPUT_HISTORY_STORAGE_KEY,
        JSON.stringify(this.inputHistory.slice(-DomindsQ4HInput.INPUT_HISTORY_MAX)),
      );
    } catch {
      // ignore
    }
  }

  private recordInputHistoryEntry(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const last =
      this.inputHistory.length > 0 ? this.inputHistory[this.inputHistory.length - 1] : null;
    if (last === trimmed) return;
    this.inputHistory.push(trimmed);
    if (this.inputHistory.length > DomindsQ4HInput.INPUT_HISTORY_MAX) {
      this.inputHistory = this.inputHistory.slice(-DomindsQ4HInput.INPUT_HISTORY_MAX);
    }
    this.persistInputHistory();
  }

  private resetInputHistoryNavigation(): void {
    this.inputHistoryCursor = null;
    this.inputHistoryDraft = null;
  }

  private applyInputHistoryCursorValue(cursorAt: 'start' | 'end' = 'end'): void {
    if (!this.textInput) return;
    if (this.inputHistoryCursor === null) return;
    const len = this.inputHistory.length;
    const nextValue =
      this.inputHistoryCursor >= len
        ? (this.inputHistoryDraft ?? '')
        : (this.inputHistory[this.inputHistoryCursor] ?? '');
    this.textInput.value = nextValue;
    this.updateSendButton();
    this.scheduleInputUiUpdate();
    const nextPos = cursorAt === 'start' ? 0 : this.textInput.value.length;
    this.textInput.setSelectionRange(nextPos, nextPos);
  }

  private recallPreviousInputHistory(): void {
    if (!this.textInput) return;
    if (this.inputHistory.length === 0) return;

    if (this.inputHistoryCursor === null) {
      this.inputHistoryDraft = this.textInput.value;
      this.inputHistoryCursor = this.inputHistory.length;
    }

    if (this.inputHistoryCursor <= 0) return;
    this.inputHistoryCursor -= 1;
    this.applyInputHistoryCursorValue('start');
  }

  private recallNextInputHistory(): void {
    if (!this.textInput) return;
    if (this.inputHistoryCursor === null) return;
    const len = this.inputHistory.length;
    if (this.inputHistoryCursor >= len) return;
    this.inputHistoryCursor += 1;
    this.applyInputHistoryCursorValue();
  }

  public setDisabled(disabled: boolean): void {
    this.props.disabled = disabled;
    this.updateUI();
  }

  public focusInput(): void {
    if (this.textInput) {
      this.textInput.focus();
      const length = this.textInput.value.length;
      this.textInput.setSelectionRange(length, length);
    }
  }

  public clear(): void {
    if (this.textInput) {
      this.textInput.value = '';
      this.resetInputHistoryNavigation();
      this.revokeImageAttachments();
      this.updateSendButton();
      this.autoResizeTextarea();
      this.safeRender();
    }
  }

  public getValue(): string {
    return this.textInput?.value || '';
  }

  public setValue(value: string): void {
    if (this.textInput) {
      this.textInput.value = value;
      this.updateSendButton();
    }
  }

  public insertPromptTemplate(content: string): void {
    if (!this.textInput) return;
    const template = typeof content === 'string' ? content : '';
    if (template.trim() === '') return;

    const textarea = this.textInput;
    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);

    const needsPrefix = before.trim().length > 0 && !/\s$/.test(before);
    const needsSuffix = after.trim().length > 0 && !/^\s/.test(after);
    const prefix = needsPrefix ? '\n\n' : '';
    const suffix = needsSuffix ? '\n\n' : '';

    const inserted = `${prefix}${template}${suffix}`;
    textarea.value = `${before}${inserted}${after}`;

    const nextPos = before.length + inserted.length;
    textarea.setSelectionRange(nextPos, nextPos);
    this.updateSendButton();
    this.scheduleInputUiUpdate();
  }

  private safeRender(): void {
    if (this.inputUiRafId !== null) {
      window.cancelAnimationFrame(this.inputUiRafId);
      this.inputUiRafId = null;
    }

    const sr = this.shadowRoot;
    const active = sr ? sr.activeElement : null;
    const restoreFocus = active === this.textInput || active === this.sendButton;
    const selectionStart = active === this.textInput ? this.textInput.selectionStart : null;
    const selectionEnd = active === this.textInput ? this.textInput.selectionEnd : null;

    const currentValue = this.textInput?.value || '';

    this.render();
    this.setupEventListeners();

    if (this.textInput) {
      this.textInput.value = currentValue;
    }
    this.updateUI();

    if (restoreFocus && this.textInput && !this.textInput.disabled) {
      this.textInput.focus();
      const len = this.textInput.value.length;
      if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
        this.textInput.setSelectionRange(
          Math.min(selectionStart, len),
          Math.min(selectionEnd, len),
        );
      } else {
        this.textInput.setSelectionRange(len, len);
      }
    }
  }

  private autoResizeTextarea(): void {
    if (!this.textInput) return;
    const previousHostHeightPx = this.getCurrentHostHeightPx();
    const hostChromeHeightPx = this.getHostChromeHeightPx();
    const attachmentStripHeightPx = this.getAttachmentStripHeightPx();
    const minHeight = Math.max(
      0,
      this.manualResizeMinPx - hostChromeHeightPx - attachmentStripHeightPx,
    );
    const maxHeight = Math.max(
      minHeight,
      Math.floor(window.innerHeight * DomindsQ4HInput.AUTO_RESIZE_MAX_VIEWPORT_RATIO) -
        hostChromeHeightPx -
        attachmentStripHeightPx,
    );

    this.textInput.style.height = '';
    const scrollHeight = this.getMeasuredTextareaScrollHeightPx();
    const desiredTextHeight =
      scrollHeight <= minHeight + 1
        ? minHeight
        : scrollHeight + DomindsQ4HInput.AUTO_RESIZE_EXTRA_GAP_PX;
    const nextHeight = Math.max(minHeight, Math.min(desiredTextHeight, maxHeight));

    const desiredHostHeightPx = Math.ceil(
      hostChromeHeightPx + attachmentStripHeightPx + nextHeight,
    );
    const baselineHostHeightPx = this.getBaselineHostHeightPx();

    if (baselineHostHeightPx !== null) {
      this.autoResizeCaptureArmed = true;
      this.setHostHeightPx(Math.max(baselineHostHeightPx, desiredHostHeightPx));
      return;
    }

    if (!this.autoResizeCaptureArmed) {
      this.autoResizeCaptureArmed = true;
      this.setHostHeightPx(null);
      return;
    }

    if (desiredHostHeightPx > previousHostHeightPx + 1) {
      this.autoResizeBaseHostHeightPx = this.clampHostHeightPx(previousHostHeightPx);
      this.setHostHeightPx(desiredHostHeightPx);
      return;
    }

    this.setHostHeightPx(null);
  }

  private scheduleInputUiUpdate(): void {
    if (this.inputUiRafId !== null) return;
    this.inputUiRafId = window.requestAnimationFrame(() => {
      this.inputUiRafId = null;
      this.updateSendButton();
      if (!this.isComposing) {
        this.autoResizeTextarea();
      }
    });
  }

  private showError(message: string): void {
    if (this.inputWrapper) {
      this.inputWrapper.style.borderColor = 'var(--dominds-danger, #dc3545)';
      this.inputWrapper.style.boxShadow = '0 0 0 3px rgba(220, 53, 69, 0.1)';

      setTimeout(() => {
        this.inputWrapper.style.borderColor = '';
        this.inputWrapper.style.boxShadow = '';
      }, 3000);
    }

    dispatchDomindsEvent(
      this,
      'input-error',
      { message, type: 'error' },
      {
        bubbles: true,
        composed: true,
      },
    );
  }

  private setupEventListeners(): void {
    if (!this.shadowRoot) return;

    window.removeEventListener('resize', this.boundOnWindowResize);
    window.addEventListener('resize', this.boundOnWindowResize);

    if (this.textInput) {
      this.isComposing = false;
      this.textInput.addEventListener('compositionstart', () => {
        this.isComposing = true;
      });
      this.textInput.addEventListener('compositionend', () => {
        this.isComposing = false;
        this.scheduleInputUiUpdate();
      });
      this.textInput.addEventListener('compositioncancel', () => {
        this.isComposing = false;
        this.scheduleInputUiUpdate();
      });
      this.textInput.addEventListener('blur', () => {
        this.isComposing = false;
        this.escPrimedAtMs = null;
        this.scheduleInputUiUpdate();
      });
      this.textInput.addEventListener('input', () => {
        if (
          this.inputHistoryCursor !== null &&
          this.inputHistoryCursor !== this.inputHistory.length
        ) {
          // User started editing a recalled history item; exit history navigation mode.
          this.resetInputHistoryNavigation();
        }
        this.scheduleInputUiUpdate();
      });

      this.textInput.addEventListener('paste', (event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items || items.length === 0) return;
        const files = Array.from(items)
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (files.length === 0) return;
        event.preventDefault();
        void this.addImageFiles(files).catch((error: unknown) => {
          console.error('Failed to add pasted image:', error);
          const t = IMAGE_ATTACHMENT_I18N[this.uiLanguage];
          this.showError(error instanceof Error ? error.message : t.readFailed);
        });
      });

      this.textInput.addEventListener('keydown', (e) => {
        const isIme = this.isComposing || e.isComposing || e.keyCode === 229;

        if (!isIme && e.key === 'ArrowUp') {
          const start = this.textInput.selectionStart;
          const end = this.textInput.selectionEnd;
          if (start === 0 && end === 0) {
            e.preventDefault();
            e.stopPropagation();
            this.recallPreviousInputHistory();
            return;
          }
        }

        if (!isIme && e.key === 'ArrowDown') {
          const start = this.textInput.selectionStart;
          const end = this.textInput.selectionEnd;
          const len = this.textInput.value.length;
          if (start === len && end === len) {
            e.preventDefault();
            e.stopPropagation();
            this.recallNextInputHistory();
            return;
          }
        }

        if (e.key === 'Escape') {
          if (isIme) return;
          const hasContent = this.textInput.value.length > 0 || this.imageAttachments.length > 0;
          if (!hasContent) {
            this.escPrimedAtMs = null;
            return;
          }

          const now = Date.now();
          const primedAt = this.escPrimedAtMs;
          const isSecondPress = typeof primedAt === 'number' && now - primedAt <= 650;
          if (isSecondPress) {
            this.escPrimedAtMs = null;
            e.preventDefault();
            e.stopPropagation();
            this.clear();
            this.focusInput();
            return;
          }

          this.escPrimedAtMs = now;
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        this.escPrimedAtMs = null;

        if (e.key === 'Enter' && isIme) {
          return;
        }

        if (e.key !== 'Enter') {
          return;
        }

        const hasCtrlOrMeta = e.ctrlKey || e.metaKey;
        const hasNoModifier = !e.shiftKey && !hasCtrlOrMeta && !e.altKey;

        // Cmd/Ctrl+Enter always triggers the same primary action as the send button.
        if (hasCtrlOrMeta) {
          e.preventDefault();
          void this.handlePrimaryAction();
          return;
        }

        // Shift+Enter is always newline (keep native textarea behavior).
        if (e.shiftKey) {
          return;
        }

        // Only plain Enter respects the "send on Enter" preference.
        if (hasNoModifier && this.sendOnEnter) {
          e.preventDefault();
          void this.handlePrimaryAction();
        }
      });
    }

    if (this.inputWrapper) {
      this.inputWrapper.addEventListener('dragenter', (event: DragEvent) => {
        if (!this.hasDraggedFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        this.imageDragDepth += 1;
        this.setImageDropActive(true);
      });

      this.inputWrapper.addEventListener('dragover', (event: DragEvent) => {
        if (!this.hasDraggedFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const dataTransfer = event.dataTransfer;
        if (dataTransfer !== null) {
          dataTransfer.dropEffect = this.props.disabled ? 'none' : 'copy';
        }
        this.setImageDropActive(true);
      });

      this.inputWrapper.addEventListener('dragleave', (event: DragEvent) => {
        if (!this.hasDraggedFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        this.imageDragDepth = Math.max(0, this.imageDragDepth - 1);
        if (this.imageDragDepth === 0) {
          this.setImageDropActive(false);
        }
      });

      this.inputWrapper.addEventListener('drop', (event: DragEvent) => {
        if (!this.hasDraggedFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const dataTransfer = event.dataTransfer;
        const files = dataTransfer === null ? [] : Array.from(dataTransfer.files);
        this.resetImageDragState();
        if (files.length === 0) return;
        this.handleDroppedImageFiles(files);
      });
    }

    const toggleBtn = this.shadowRoot.querySelector('.send-on-enter-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.sendOnEnter = !this.sendOnEnter;
        this.persistSendOnEnterPreference();
        this.safeRender();
        this.focusInput();
      });
    }

    if (this.sendButton) {
      this.sendButton.addEventListener('click', () => {
        void this.handlePrimaryAction();
      });
    }

    if (this.declareDeathButton) {
      this.declareDeathButton.addEventListener('click', () => {
        void this.handleDeclareDeath();
      });
    }

    if (this.resizeHandle) {
      this.resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!e.isPrimary || e.button !== 0) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.finishManualResize(false);
        this.recomputeResizeBounds();
        if (this.textInput) {
          // Clear any inline height set by auto-resize so the textarea can stretch.
          this.textInput.style.height = '';
        }
        this.autoResizeBaseHostHeightPx = null;
        this.autoResizeCaptureArmed = false;
        const current = this.getBoundingClientRect().height;
        const startHeight = this.manualHeightPx ?? current;
        this.manualResizeStartHeight = startHeight;
        this.manualResizeStartY = e.clientY;
        this.isManualResizing = true;
        this.activePointerId = e.pointerId;
        this.manualHeightPx = startHeight;
        this.applyHeightConstraints();

        this.resizeHandle.setPointerCapture(e.pointerId);

        this.boundManualMove = (evt: PointerEvent) => {
          if (!this.isManualResizing || evt.pointerId !== this.activePointerId) return;
          const delta = evt.clientY - this.manualResizeStartY;
          const next = this.manualResizeStartHeight - delta;
          this.manualHeightPx = next;
          this.applyHeightConstraints();
        };
        this.boundManualUp = (evt: PointerEvent) => {
          if (evt.pointerId !== this.activePointerId) return;
          this.finishManualResize(true);
        };
        this.boundManualLostCapture = (evt: PointerEvent) => {
          if (evt.pointerId !== this.activePointerId) return;
          this.finishManualResize(true);
        };

        window.addEventListener('pointermove', this.boundManualMove, true);
        window.addEventListener('pointerup', this.boundManualUp, true);
        window.addEventListener('pointercancel', this.boundManualUp, true);
        this.resizeHandle.addEventListener('pointerup', this.boundManualUp);
        this.resizeHandle.addEventListener('pointercancel', this.boundManualUp);
        this.resizeHandle.addEventListener('lostpointercapture', this.boundManualLostCapture);
      });
    }

    this.shadowRoot.querySelectorAll<HTMLButtonElement>('.attachment-thumb').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.attachmentId;
        if (typeof id !== 'string') return;
        this.openImageAttachmentId = id;
        this.safeRender();
      });
    });

    this.shadowRoot.querySelectorAll<HTMLButtonElement>('.attachment-remove').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = button.dataset.attachmentId;
        if (typeof id !== 'string') return;
        this.removeImageAttachment(id);
      });
    });

    const modalCloseTargets = this.shadowRoot.querySelectorAll<HTMLElement>(
      '.image-modal-backdrop, .image-modal-close',
    );
    modalCloseTargets.forEach((target) => {
      target.addEventListener('click', () => {
        this.openImageAttachmentId = null;
        this.safeRender();
        this.focusInput();
      });
    });
  }

  private async requestDeclareDeath(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    const dialog = this.currentDialog;
    if (!dialog) {
      throw new Error(t.noActiveDialogToast);
    }
    if (dialog.selfId === dialog.rootId) {
      throw new Error(t.q4hDeclareDeadOnlySidelineToast);
    }
    const state = this.displayState;
    if (state === null || state.kind !== 'stopped' || !state.continueEnabled) {
      throw new Error(t.q4hDeclareDeadOnlyInterruptedToast);
    }
    if (this.props.disabled) {
      throw new Error(t.inputNotAvailableToast);
    }
    if (!this.wsManager.isConnected()) {
      throw new Error(t.q4hConnectionUnavailableToast);
    }
    const ok = window.confirm(this.getDeclareDeathConfirmText());
    if (!ok) return;
    const note = this.textInput ? this.textInput.value : '';
    this.wsManager.sendRaw({ type: 'declare_subdialog_dead', dialog, note });
    this.recordInputHistoryEntry(note);
    this.clear();
  }

  private getDeclareDeathConfirmText(): string {
    const t = getUiStrings(this.uiLanguage);
    const callName = this.currentDialog?.assignmentFromSup?.callName;
    switch (callName) {
      case 'tellaskSessionless':
        return t.declareDeathConfirmSessionless;
      case 'freshBootsReasoning':
        return t.declareDeathConfirmFbr;
      default:
        return t.declareDeathConfirm;
    }
  }

  private async requestStop(): Promise<void> {
    const t = getUiStrings(this.uiLanguage);
    if (!this.currentDialog) {
      throw new Error(t.noActiveDialogToast);
    }
    if (this.props.disabled) {
      throw new Error(t.inputNotAvailableToast);
    }
    this.wsManager.sendRaw({ type: 'interrupt_dialog', dialog: this.currentDialog });
  }

  private async handlePrimaryAction(): Promise<void> {
    try {
      const mode = this.resolvePrimaryActionMode();
      if (mode === 'stop') {
        await this.requestStop();
        return;
      }
      if (mode === 'stopping') {
        return;
      }
      await this.sendMessage();
    } catch (error: unknown) {
      console.error('Primary action failed:', error);
      const t = getUiStrings(this.uiLanguage);
      const errorMessage = error instanceof Error ? error.message : t.q4hActionFailedToast;
      this.showError(errorMessage);
    }
  }

  private async handleDeclareDeath(): Promise<void> {
    try {
      await this.requestDeclareDeath();
    } catch (error: unknown) {
      console.error('Declare dead failed:', error);
      const t = getUiStrings(this.uiLanguage);
      const errorMessage = error instanceof Error ? error.message : t.q4hActionFailedToast;
      this.showError(errorMessage);
    }
  }

  private async sendMessage(): Promise<{ success: true; msgId: string }> {
    const t = getUiStrings(this.uiLanguage);
    const attachmentI18n = IMAGE_ATTACHMENT_I18N[this.uiLanguage];
    const hasAttachments = this.imageAttachments.length > 0;
    const typedContent = this.textInput.value.trim();
    const content = typedContent || (hasAttachments ? attachmentI18n.imageOnlyPrompt : '');
    const attachments = this.getOutgoingAttachments();
    const answeredQuestionId = this.selectedQuestionId;
    const answeredQuestion =
      answeredQuestionId !== null
        ? (this.questions.find((q) => q.id === answeredQuestionId) ?? null)
        : null;
    if (answeredQuestionId !== null && answeredQuestion === null) {
      throw new Error(`${t.q4hSelectedQuestionStaleToastPrefix}${answeredQuestionId}`);
    }
    const targetDialog =
      answeredQuestion !== null
        ? {
            selfId: answeredQuestion.dialogContext.selfId,
            rootId: answeredQuestion.dialogContext.rootId,
          }
        : this.currentDialog;

    if (!content && attachments.length === 0) {
      throw new Error(t.q4hMessageEmptyToast);
    }

    if (!targetDialog) {
      throw new Error(t.q4hNoRoutableTargetToast);
    }

    if (this.props.disabled) {
      throw new Error(t.inputNotAvailableToast);
    }

    if (!this.wsManager.isConnected()) {
      throw new Error(t.q4hConnectionUnavailableToast);
    }

    const msgId = generateShortId();

    try {
      const sr = this.shadowRoot;
      const active = sr ? sr.activeElement : null;
      const restoreFocus = active === this.textInput || active === this.sendButton;

      if (answeredQuestion !== null) {
        this.sendHumanReply({
          targetDialog,
          content,
          attachments,
          msgId,
          questionId: answeredQuestion.id,
        });
        this.scheduleQ4HStateRefresh();
      } else {
        this.wsManager.sendRaw({
          type: 'drive_dlg_by_user_msg',
          dialog: targetDialog,
          content,
          attachments,
          msgId,
          userLanguageCode: this.uiLanguage,
        });
      }

      this.recordInputHistoryEntry(typedContent);
      if (answeredQuestion !== null) {
        // Q4H answer flow: clear question selection/styling immediately after answer routing.
        this.selectQuestion(null);
        const dialogId = answeredQuestion.dialogContext.selfId;
        const rootId = answeredQuestion.dialogContext.rootId;
        if (typeof dialogId === 'string' && typeof rootId === 'string') {
          dispatchDomindsEvent(
            this,
            'q4h-select-question',
            {
              questionId: null,
              dialogId,
              rootId,
              tellaskContent: '',
            },
            { bubbles: true, composed: true },
          );
        }
      } else {
        // Normal user-message flow: no Q4H style transition side effects.
      }
      this.clear();
      dispatchDomindsEvent(this, 'usersend', { content }, { bubbles: true, composed: true });

      if (restoreFocus) {
        queueMicrotask(() => {
          if (this.props.disabled) return;
          this.focusInput();
        });
      }

      return { success: true, msgId };
    } catch (error: unknown) {
      console.error('Failed to send message:', error);
      const errorMessage = error instanceof Error ? error.message : t.q4hSendFailedToast;
      this.showError(errorMessage);
      throw error;
    }
  }

  private sendHumanReply(args: {
    targetDialog: DialogIdent;
    content: string;
    attachments: Array<{
      kind: 'image';
      mimeType: string;
      byteLength: number;
      dataBase64: string;
    }>;
    msgId: string;
    questionId: string;
  }): void {
    this.wsManager.sendRaw({
      type: 'drive_dialog_by_user_answer',
      dialog: args.targetDialog,
      content: args.content,
      attachments: args.attachments,
      msgId: args.msgId,
      questionId: args.questionId,
      continuationType: 'answer',
      userLanguageCode: this.uiLanguage,
    });
  }

  private scheduleQ4HStateRefresh(): void {
    const now = Date.now();
    const last = this.lastQ4HRefreshRequestedAtMs;
    if (typeof last === 'number' && now - last < 200) return;
    this.lastQ4HRefreshRequestedAtMs = now;

    // Q4H answered is primarily driven by real-time `q4h_answered` events.
    // This snapshot refresh is a recovery path for rare race/miss windows,
    // ensuring the pending count converges to persisted state without manual reload.
    const delaysMs = [250, 900];
    for (const delay of delaysMs) {
      setTimeout(() => {
        this.wsManager.sendRaw({ type: 'get_q4h_state' });
      }, delay);
    }
  }

  private updateSendButton(): void {
    if (!this.sendButton || !this.textInput) return;

    this.applyPrimaryActionMode();
    const mode = this.resolvePrimaryActionMode();
    this.updateEnterToggleTitle(mode);
    if (mode === 'stop' || mode === 'stopping') {
      const canStop = !this.props.disabled && this.currentDialog !== null;
      this.sendButton.disabled = mode === 'stopping' || !canStop;
      return;
    }

    const hasContent = this.textInput.value.trim().length > 0 || this.imageAttachments.length > 0;
    const hasSelectedQ4H = this.hasSelectedQ4HTarget();
    const hasCurrentDialog = this.currentDialog !== null;
    const hasRoutableTarget = hasSelectedQ4H || hasCurrentDialog;
    const canSend = hasContent && !this.props.disabled && hasRoutableTarget;
    this.sendButton.disabled = !canSend;
  }

  private updateUI(): void {
    if (!this.inputWrapper || !this.textInput) return;

    const state = this.displayState;
    const isProceeding =
      state !== null && (state.kind === 'proceeding' || state.kind === 'proceeding_stop_requested');
    const shouldDisable = this.props.disabled === true;
    this.inputWrapper.classList.toggle('disabled', shouldDisable);
    this.inputWrapper.classList.toggle('q4h-active', this.selectedQuestionId !== null);
    this.textInput.disabled = shouldDisable;
    this.textInput.readOnly = false;

    this.setAttribute('data-display-state', state ? state.kind : 'none');
    this.setAttribute('aria-busy', isProceeding ? 'true' : 'false');
    this.updateSendButton();

    if (this.declareDeathButton) {
      const dialog = this.currentDialog;
      const isDead = state !== null && state.kind === 'dead';
      const isSubdialog = dialog !== null && dialog.selfId !== dialog.rootId;
      const shouldShow =
        isSubdialog &&
        !isDead &&
        state !== null &&
        state.kind === 'stopped' &&
        state.continueEnabled;
      this.declareDeathButton.hidden = !shouldShow;
      this.declareDeathButton.disabled = this.props.disabled || dialog === null;

      const t = getUiStrings(this.uiLanguage);
      this.declareDeathButton.textContent = t.declareDeath;
      this.declareDeathButton.title = t.declareDeath;
      this.declareDeathButton.setAttribute('aria-label', t.declareDeath);
    }
  }

  private render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getComponentHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;

    this.textInput = this.shadowRoot.querySelector('.message-input')!;
    this.measureTextarea = this.shadowRoot.querySelector('.message-input-measurer')!;
    this.sendButton = this.shadowRoot.querySelector('.send-button')!;
    this.declareDeathButton = this.shadowRoot.querySelector('.declare-death-button')!;
    this.inputWrapper = this.shadowRoot.querySelector('.input-wrapper')!;
    this.resizeHandle = this.shadowRoot.querySelector('.input-resize-handle')!;
  }

  private renderAttachmentStrip(): string {
    if (this.imageAttachments.length === 0) return '';
    const t = IMAGE_ATTACHMENT_I18N[this.uiLanguage];
    const items = this.imageAttachments
      .map((attachment) => {
        const id = DomindsQ4HInput.escapeHtml(attachment.id);
        const name = DomindsQ4HInput.escapeHtml(attachment.name);
        const src = DomindsQ4HInput.escapeHtml(attachment.objectUrl);
        return `
          <div class="attachment-item">
            <button class="attachment-thumb" type="button" data-attachment-id="${id}" title="${DomindsQ4HInput.escapeHtml(
              t.preview,
            )}" aria-label="${DomindsQ4HInput.escapeHtml(t.preview)}">
              <img src="${src}" alt="${name}">
            </button>
            <button class="attachment-remove" type="button" data-attachment-id="${id}" title="${DomindsQ4HInput.escapeHtml(
              t.remove,
            )}" aria-label="${DomindsQ4HInput.escapeHtml(t.remove)}">
              <span class="icon-mask attachment-remove-icon" aria-hidden="true"></span>
            </button>
          </div>
        `;
      })
      .join('');
    return `<div class="attachment-strip">${items}</div>`;
  }

  private renderImageModal(): string {
    const attachment =
      this.openImageAttachmentId === null
        ? null
        : (this.imageAttachments.find((item) => item.id === this.openImageAttachmentId) ?? null);
    if (attachment === null) return '';
    const t = IMAGE_ATTACHMENT_I18N[this.uiLanguage];
    return `
      <div class="image-modal" role="dialog" aria-modal="true">
        <div class="image-modal-backdrop"></div>
        <div class="image-modal-content">
          <button class="image-modal-close" type="button" title="${DomindsQ4HInput.escapeHtml(
            t.close,
          )}" aria-label="${DomindsQ4HInput.escapeHtml(t.close)}">
            <span class="icon-mask image-modal-close-icon" aria-hidden="true"></span>
          </button>
          <img src="${DomindsQ4HInput.escapeHtml(attachment.objectUrl)}" alt="${DomindsQ4HInput.escapeHtml(
            attachment.name,
          )}">
        </div>
      </div>
    `;
  }

  private getComponentHTML(): string {
    const t = getUiStrings(this.uiLanguage);
    const mode = this.resolvePrimaryActionMode();
    const primaryTitle =
      mode === 'send'
        ? t.send
        : mode === 'queue_now'
          ? t.queueNow
          : mode === 'stop'
            ? t.stop
            : t.stopping;
    const primaryClass =
      mode === 'queue_now'
        ? 'send-button queue'
        : mode === 'send'
          ? 'send-button'
          : 'send-button stop';
    const dialog = this.currentDialog;
    const isSubdialog = dialog !== null && dialog.selfId !== dialog.rootId;
    const state = this.displayState;
    const isDead = state !== null && state.kind === 'dead';
    const showDeclareDeath =
      isSubdialog && !isDead && state !== null && state.kind === 'stopped' && state.continueEnabled;

    return `
      <div class="q4h-input-container">
        <textarea class="message-input-measurer" tabindex="-1" aria-hidden="true"></textarea>
        <div class="input-section">
          <div class="input-resize-handle" role="separator" aria-orientation="horizontal" aria-label="${RESIZE_HANDLE_ARIA_LABEL_I18N[this.uiLanguage]}"></div>
          <div class="input-wrapper ${this.selectedQuestionId !== null ? 'q4h-active' : ''} ${this.props.disabled ? 'disabled' : ''}">
            <div class="input-body">
              <textarea id="human-input"
                class="message-input"
                placeholder="${this.props.placeholder}"
                maxlength="${this.props.maxLength}"
                rows="2"
                ${this.props.disabled ? 'disabled' : ''}
              ></textarea>
              ${this.renderAttachmentStrip()}
            </div>
            <div class="input-actions">
              <button
                class="send-on-enter-toggle ${this.sendOnEnter ? 'active' : ''}"
                type="button"
                title="${this.getEnterToggleTitle(mode)}"
              >
                ${this.sendOnEnter ? '⏎' : '⌘⏎'}
              </button>
              <button class="${primaryClass}" type="button" disabled title="${primaryTitle}" aria-label="${primaryTitle}">
                ${
                  mode === 'send'
                    ? '<span class="send-icon icon-mask" aria-hidden="true"></span>'
                    : mode === 'queue_now'
                      ? '<span class="queue-icon icon-mask" aria-hidden="true"></span>'
                      : '<span class="stop-icon icon-mask" aria-hidden="true"></span>'
                }
              </button>
              <button
                class="declare-death-button"
                type="button"
                title="${t.declareDeath}"
                aria-label="${t.declareDeath}"
                ${showDeclareDeath ? '' : 'hidden'}
              >${t.declareDeath}</button>
            </div>
          </div>
        </div>
        ${this.renderImageModal()}
      </div>
    `;
  }

  private getStyles(): string {
    return `
      ${ICON_MASK_BASE_CSS}
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-height: 0;
        max-height: 50vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color-scheme: inherit;
      }

      [hidden] {
        display: none !important;
      }

      .q4h-input-container {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        border-left: 1px solid var(--color-border-primary, #e2e8f0);
        border-right: 1px solid var(--color-border-primary, #e2e8f0);
        border-bottom: 1px solid var(--color-border-primary, #e2e8f0);
        background: var(--dominds-sidebar-bg, #f8f9fa);
        box-sizing: border-box;
      }

      .message-input-measurer {
        position: absolute;
        top: 0;
        left: -9999px;
        height: 0 !important;
        min-height: 0 !important;
        max-height: none !important;
        margin: 0;
        border: 0;
        box-sizing: border-box;
        overflow: hidden;
        visibility: hidden;
        pointer-events: none;
        resize: none;
        white-space: pre-wrap;
        overflow-wrap: break-word;
      }

      .input-resize-handle {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 12px;
        cursor: ns-resize;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        z-index: var(--dominds-z-local-handle, 2);
      }

      .input-resize-handle::after {
        content: '';
        position: absolute;
        inset: 0;
      }

      .input-resize-handle::before {
        content: '';
        width: 44px;
        height: 3px;
        border-radius: 999px;
        background: var(--dominds-border, #e0e0e0);
      }

      .input-resize-handle:hover::before {
        background: var(--dominds-primary, #007acc);
      }

      .input-section {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--color-border-primary, #e2e8f0);
        padding: 10px;
        background: var(--dominds-sidebar-bg, #f8f9fa);
        position: relative;
        z-index: var(--dominds-z-local-raised, 1);
      }

      .input-wrapper {
        display: flex;
        align-items: stretch;
        flex: 1;
        min-height: 0;
        gap: 6px;
        background: var(--dominds-input-bg, #f8f9fa);
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 18px;
        transition: all 0.2s ease;
        overflow: hidden;
        padding-right: 8px;
      }

      .input-actions {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        align-self: flex-end;
        padding-bottom: 6px;
      }

      .input-body {
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
      }

      .declare-death-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid var(--dominds-danger, #dc3545);
        background: transparent;
        color: var(--dominds-danger, #dc3545);
        font-size: var(--dominds-font-size-xs, 11px);
        font-weight: 600;
        cursor: pointer;
        user-select: none;
      }

      .declare-death-button:hover:not(:disabled) {
        background: rgba(220, 53, 69, 0.08);
      }

      .declare-death-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .send-on-enter-toggle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--color-fg-tertiary, #64748b);
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s ease;
        padding: 0;
      }

      .send-on-enter-toggle:hover {
        background: var(--color-bg-tertiary, #f1f5f9);
        color: var(--color-fg-primary, #0f172a);
        border-color: var(--color-border-primary, #e2e8f0);
      }

      .send-on-enter-toggle.active {
        font-weight: bold;
      }

      .input-wrapper.q4h-active {
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 12%, var(--color-bg-secondary, #ffffff));
        border-color: var(--dominds-primary, #007acc);
        border-top-color: transparent;
        border-radius: 0 0 18px 18px;
      }

      .input-wrapper.q4h-active:focus-within {
        border-color: var(--dominds-primary, #007acc);
        border-top-color: transparent;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dominds-primary, #007acc) 20%, transparent);
      }

      .input-wrapper:focus-within {
        border-color: var(--dominds-focus, #007acc);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dominds-focus, #007acc) 20%, transparent);
      }

      .input-wrapper.image-drop-active {
        border-color: var(--dominds-focus, #007acc);
        background: color-mix(in srgb, var(--dominds-focus, #007acc) 10%, var(--dominds-input-bg, #f8f9fa));
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dominds-focus, #007acc) 22%, transparent);
      }

      .input-wrapper.image-drop-active .message-input {
        cursor: copy;
      }

      .input-wrapper.disabled {
        opacity: 0.6;
        background: color-mix(in srgb, var(--dominds-primary, #007acc) 3%, var(--color-bg-secondary, #f8f9fa));
        border-color: var(--dominds-border, #e0e0e0);
      }

      .message-input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        box-sizing: border-box;
        padding: 9px 12px;
        font-size: 13px;
        line-height: var(--dominds-line-height-dense, 1.4);
        color: var(--dominds-fg, #333333);
        resize: none;
        min-height: 0;
        font-family: inherit;
        white-space: pre-wrap;
        overflow-y: auto;
      }

      .attachment-strip {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        padding: 0 8px 8px 12px;
        min-height: 44px;
        align-items: center;
      }

      .attachment-item {
        position: relative;
        width: 44px;
        height: 44px;
        flex: 0 0 44px;
      }

      .attachment-thumb {
        appearance: none;
        width: 44px;
        height: 44px;
        padding: 0;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 6px;
        overflow: hidden;
        background: var(--dominds-bg-secondary, #ffffff);
        cursor: pointer;
      }

      .attachment-thumb img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .attachment-remove {
        appearance: none;
        position: absolute;
        top: -5px;
        right: -5px;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 1px solid var(--dominds-border, #e0e0e0);
        border-radius: 50%;
        background: var(--dominds-bg-secondary, #ffffff);
        color: var(--dominds-fg, #333333);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
      }

      .attachment-remove-icon,
      .image-modal-close-icon {
        --icon-mask: ${ICON_MASK_URLS.close};
        width: 12px;
        height: 12px;
      }

      .image-modal {
        position: fixed;
        inset: 0;
        z-index: var(--dominds-z-overlay-modal, 2000);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .image-modal-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.62);
      }

      .image-modal-content {
        position: relative;
        max-width: min(92vw, 1100px);
        max-height: min(88vh, 900px);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .image-modal-content img {
        display: block;
        max-width: 100%;
        max-height: min(88vh, 900px);
        object-fit: contain;
        border-radius: 6px;
        background: #111111;
      }

      .image-modal-close {
        appearance: none;
        position: absolute;
        top: -10px;
        right: -10px;
        width: 28px;
        height: 28px;
        border: 1px solid rgba(255, 255, 255, 0.55);
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.74);
        color: #ffffff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }

      .message-input::placeholder {
        color: var(--dominds-muted, #666666);
      }

      .message-input:disabled {
        cursor: not-allowed;
      }

      .send-button {
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        width: 27px;
        height: 27px;
        border: none;
        border-radius: 50%;
        background: var(--dominds-primary, #007acc);
        color: white;
        cursor: pointer;
        transition: all 0.2s ease;
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      }

      .send-button.stop {
        background: var(--dominds-danger, #dc3545);
      }

      .send-button.queue {
        background: var(--dominds-warning, #d97706);
      }

      .send-button:hover:not(:disabled) {
        background: var(--dominds-primary-hover, #005ea6);
        transform: scale(1.05);
      }

      .send-button.stop:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dominds-danger, #dc3545) 85%, black);
      }

      .send-button.queue:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dominds-warning, #d97706) 88%, black);
      }

      .send-button:active:not(:disabled) {
        transform: scale(0.95);
      }

      .send-button:disabled {
        background: var(--dominds-disabled, #2d2d2d);
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
        opacity: 0.6;
      }

      .send-icon,
      .stop-icon,
      .queue-icon {
        display: block;
        position: absolute;
        left: 50%;
        top: 50%;
        width: 18px;
        height: 18px;
        transform: translate(-50%, -50%);
      }

      .send-icon {
        --icon-mask: ${ICON_MASK_URLS.send};
      }

      .stop-icon {
        --icon-mask: ${ICON_MASK_URLS.stop};
        width: 14px;
        height: 14px;
      }

      .queue-icon {
        --icon-mask: ${ICON_MASK_URLS.queueNow};
      }

    `;
  }
}

if (!customElements.get('dominds-q4h-input')) {
  customElements.define('dominds-q4h-input', DomindsQ4HInput);
}
