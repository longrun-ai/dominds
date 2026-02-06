import { getUiStrings } from '../i18n/ui';
import type { FrontendTeamMember } from '../services/api';
import type { LanguageCode } from '../shared/types/language';
import { escapeHtml } from '../shared/utils/html.js';

export type DialogCreateAction =
  | { kind: 'task'; taskDocPath: string }
  | { kind: 'root'; rootId: string; taskDocPath: string; agentId: string };

export type CreateDialogErrorCode =
  | 'TEAM_NOT_READY'
  | 'TEAM_MEMBER_INVALID'
  | 'TASKDOC_INVALID'
  | 'AUTH_REQUIRED'
  | 'CREATE_FAILED';

export type CreateDialogError = {
  code: CreateDialogErrorCode;
  message: string;
};

export type CreateDialogSource = 'toolbar' | 'task_action' | 'root_action';

export type CreateDialogIntent = {
  source: CreateDialogSource;
  presetTaskDocPath?: string;
  presetAgentId?: string;
};

export type CreateDialogRequest = {
  agentId: string;
  taskDocPath: string;
  agentPrimingMode: AgentPrimingMode;
  requestId: string;
};

export type CreateDialogSuccess = {
  kind: 'success';
  requestId: string;
  selfId: string;
  rootId: string;
  agentId: string;
  taskDocPath: string;
};

export type CreateDialogFailure = {
  kind: 'failure';
  requestId: string;
  error: CreateDialogError;
};

export type CreateDialogResult = CreateDialogSuccess | CreateDialogFailure;

export type AgentPrimingMode = 'do' | 'reuse' | 'skip';
type DomindsFeelScope = 'visible' | 'shadow';

type CreateDialogUiState =
  | { kind: 'idle' }
  | { kind: 'opening'; intent: CreateDialogIntent }
  | { kind: 'ready'; intent: CreateDialogIntent }
  | { kind: 'submitting'; intent: CreateDialogIntent; requestId: string }
  | { kind: 'failed'; intent: CreateDialogIntent; error: CreateDialogError }
  | { kind: 'succeeded'; intent: CreateDialogIntent; result: CreateDialogSuccess }
  | { kind: 'closing' };

type CreateDialogControllerDeps = {
  getLanguage: () => LanguageCode;
  getTeamMembers: () => FrontendTeamMember[];
  getDefaultResponder: () => string | null;
  getTaskDocuments: () => Array<{ path: string; relativePath: string; name: string }>;
  ensureTeamMembersReady: () => Promise<{ ok: true } | { ok: false; error: CreateDialogError }>;
  getAgentPrimingStatus: (
    agentId: string,
  ) => Promise<{ hasCache: boolean; createdAt?: string; ageSeconds?: number }>;
  submitCreateDialog: (request: CreateDialogRequest) => Promise<CreateDialogResult>;
  onCreated: (result: CreateDialogSuccess) => Promise<void>;
  onAuthRequired: () => void;
  onToast: (message: string, kind: 'error' | 'warning' | 'info') => void;
};

type SuggestionDoc = { path: string; relativePath: string; name: string };

export class CreateDialogFlowController {
  private readonly deps: CreateDialogControllerDeps;
  private state: CreateDialogUiState = { kind: 'idle' };
  private modal: HTMLElement | null = null;
  private activeKeydownListener: ((e: KeyboardEvent) => void) | null = null;

  private static readonly AGENT_PRIMING_MODE_STORAGE_KEY = 'agent-priming-mode-v1';
  private static readonly AGENT_PRIMING_MODE_SHADOW_STORAGE_KEY = 'agent-priming-mode-shadow-v1';

  constructor(deps: CreateDialogControllerDeps) {
    this.deps = deps;
  }

  public isOpen(): boolean {
    return this.modal !== null;
  }

  public getState(): CreateDialogUiState {
    return this.state;
  }

  public async open(
    host: ShadowRoot,
    intent: CreateDialogIntent,
  ): Promise<{ ok: true } | { ok: false; error: CreateDialogError }> {
    if (this.modal) {
      this.applyIntentPreset(intent);
      this.focusTaskInput();
      this.state = { kind: 'ready', intent };
      return { ok: true };
    }

    this.state = { kind: 'opening', intent };
    const readiness = await this.deps.ensureTeamMembersReady();
    if (!readiness.ok) {
      this.state = { kind: 'failed', intent, error: readiness.error };
      return readiness;
    }

    const teamMembers = this.deps.getTeamMembers();
    const visibleMembers = teamMembers.filter((m) => m.hidden !== true);
    const shadowMembers = teamMembers.filter((m) => m.hidden === true);
    if (visibleMembers.length === 0 && shadowMembers.length === 0) {
      const t = getUiStrings(this.deps.getLanguage());
      const error: CreateDialogError = {
        code: 'TEAM_NOT_READY',
        message: t.newDialogNoTeamMembers,
      };
      this.state = { kind: 'failed', intent, error };
      return { ok: false, error };
    }

    this.renderModal(host, intent, visibleMembers, shadowMembers);
    this.state = { kind: 'ready', intent };
    return { ok: true };
  }

  public close(): void {
    if (!this.modal) {
      this.state = { kind: 'idle' };
      return;
    }
    this.state = { kind: 'closing' };
    if (this.activeKeydownListener) {
      this.modal.removeEventListener('keydown', this.activeKeydownListener, true);
      this.activeKeydownListener = null;
    }
    this.modal.remove();
    this.modal = null;
    this.state = { kind: 'idle' };
  }

  public updateLanguage(): void {
    if (!this.modal) return;
    const t = getUiStrings(this.deps.getLanguage());
    const title = this.modal.querySelector('#modal-title');
    if (title instanceof HTMLElement) title.textContent = t.createNewDialogTitle;
    const closeBtn = this.modal.querySelector('.modal-close');
    if (closeBtn instanceof HTMLButtonElement) closeBtn.setAttribute('aria-label', t.close);
    const taskLabel = this.modal.querySelector('label[for="task-doc-input"]');
    if (taskLabel instanceof HTMLElement) taskLabel.textContent = t.taskDocumentLabel;
    const taskInput = this.modal.querySelector('#task-doc-input');
    if (taskInput instanceof HTMLInputElement) taskInput.placeholder = t.taskDocumentPlaceholder;
    const help = this.modal.querySelector('.form-help');
    if (help instanceof HTMLElement) help.textContent = t.taskDocumentHelp;
    const teammateLabel = this.modal.querySelector('label[for="teammate-select"]');
    if (teammateLabel instanceof HTMLElement) teammateLabel.textContent = t.teammateLabel;
    const shadowLabel = this.modal.querySelector('label[for="shadow-teammate-select"]');
    if (shadowLabel instanceof HTMLElement) shadowLabel.textContent = t.shadowMembersLabel;
    const cancel = this.modal.querySelector('#modal-cancel-btn');
    if (cancel instanceof HTMLButtonElement) cancel.textContent = t.cancel;
    const create = this.modal.querySelector('#create-dialog-btn');
    if (create instanceof HTMLButtonElement) {
      create.textContent =
        create.dataset.createState === 'creating' ? t.createDialogCreating : t.createDialog;
    }
  }

  private applyIntentPreset(intent: CreateDialogIntent): void {
    if (!this.modal) return;
    const taskInput = this.modal.querySelector('#task-doc-input');
    if (taskInput instanceof HTMLInputElement) {
      const preset = intent.presetTaskDocPath;
      if (typeof preset === 'string' && preset.trim() !== '') {
        taskInput.value = preset.trim();
      }
    }
    if (typeof intent.presetAgentId === 'string' && intent.presetAgentId.trim() !== '') {
      const teammateSelect = this.modal.querySelector('#teammate-select');
      if (teammateSelect instanceof HTMLSelectElement) {
        teammateSelect.value = intent.presetAgentId.trim();
      }
    }
  }

  private focusTaskInput(): void {
    if (!this.modal) return;
    const taskInput = this.modal.querySelector('#task-doc-input');
    if (taskInput instanceof HTMLInputElement) {
      setTimeout(() => taskInput.focus(), 0);
    }
  }

  private renderModal(
    host: ShadowRoot,
    intent: CreateDialogIntent,
    visibleMembers: FrontendTeamMember[],
    shadowMembers: FrontendTeamMember[],
  ): void {
    const t = getUiStrings(this.deps.getLanguage());
    const defaultResponder = this.deps.getDefaultResponder();
    const defaultIsVisible =
      typeof defaultResponder === 'string' && visibleMembers.some((m) => m.id === defaultResponder);
    const defaultIsShadow =
      typeof defaultResponder === 'string' && shadowMembers.some((m) => m.id === defaultResponder);
    const initialPickShadow =
      shadowMembers.length > 0 &&
      (defaultIsShadow || (!defaultIsVisible && visibleMembers.length === 0));
    const firstShadowId = shadowMembers.length > 0 ? shadowMembers[0].id : '';
    const taskPreset = typeof intent.presetTaskDocPath === 'string' ? intent.presetTaskDocPath : '';
    const modal = document.createElement('div');
    modal.className = 'dominds-modal create-dialog-modal';
    modal.dataset.modalKind = 'create-dialog';
    modal.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal-content" role="dialog" aria-labelledby="modal-title" aria-modal="true">
        <div class="modal-header">
          <h3 id="modal-title">${escapeHtml(t.createNewDialogTitle)}</h3>
          <button class="modal-close" aria-label="${escapeHtml(t.close)}">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group form-group-vertical">
            <label for="task-doc-input">${escapeHtml(t.taskDocumentLabel)}</label>
            <div class="task-doc-container">
              <input type="text" id="task-doc-input" class="task-doc-input" placeholder="${escapeHtml(
                t.taskDocumentPlaceholder,
              )}" autocomplete="off" value="${escapeHtml(taskPreset)}">
              <div id="task-doc-suggestions" class="task-doc-suggestions"></div>
            </div>
            <small class="form-help">${escapeHtml(t.taskDocumentHelp)}</small>
          </div>
          <div class="form-group form-group-vertical">
            <label for="teammate-select">${escapeHtml(t.teammateLabel)}</label>
            <select id="teammate-select" class="teammate-dropdown">
              ${visibleMembers
                .map((member) => {
                  const isDefault = member.id === defaultResponder;
                  const emoji = this.getAgentEmoji(member.icon);
                  const selected =
                    (typeof intent.presetAgentId === 'string' &&
                      intent.presetAgentId === member.id) ||
                    (!intent.presetAgentId && isDefault);
                  return `<option value="${escapeHtml(member.id)}" ${selected ? 'selected' : ''}>${escapeHtml(
                    `${emoji} ${member.name} (@${member.id})${isDefault ? t.defaultMarker : ''}`,
                  )}</option>`;
                })
                .join('')}
              ${
                shadowMembers.length > 0
                  ? `<option value="__shadow__" ${initialPickShadow ? 'selected' : ''}>${escapeHtml(
                      t.shadowMembersOption,
                    )}</option>`
                  : ''
              }
            </select>
          </div>
          <div class="form-group form-group-vertical shadow-members-group" id="shadow-members-group" style="${
            initialPickShadow ? '' : 'display:none;'
          }">
            <label for="shadow-teammate-select">${escapeHtml(t.shadowMembersLabel)}</label>
            <select id="shadow-teammate-select" class="teammate-dropdown">
              ${shadowMembers
                .map((member) => {
                  const isDefault = member.id === defaultResponder;
                  const emoji = this.getAgentEmoji(member.icon);
                  const selected =
                    isDefault ||
                    (!defaultIsShadow && firstShadowId === member.id) ||
                    intent.presetAgentId === member.id;
                  return `<option value="${escapeHtml(member.id)}" ${selected ? 'selected' : ''}>${escapeHtml(
                    `${emoji} ${member.name} (@${member.id})${isDefault ? t.defaultMarker : ''}`,
                  )}</option>`;
                })
                .join('')}
            </select>
          </div>
          <div class="teammate-info" id="teammate-info"></div>
          <div class="form-group form-group-horizontal">
            <div class="dominds-feel-row">
              <span class="dominds-feel-label">${escapeHtml(t.agentPrimingLabel)}</span>
              <div class="dominds-feel-options" id="dominds-feel-options">
                <span class="dominds-feel-loading">${escapeHtml(t.loading)}</span>
              </div>
            </div>
          </div>
          <div class="modal-error" id="create-dialog-error" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel-btn">${escapeHtml(t.cancel)}</button>
          <button class="btn btn-primary" id="create-dialog-btn">${escapeHtml(t.createDialog)}</button>
        </div>
      </div>
    `;
    host.appendChild(modal);
    this.modal = modal;
    this.setupInteractions(modal, intent, visibleMembers, shadowMembers);
    this.focusTaskInput();
  }

  private setupInteractions(
    modal: HTMLElement,
    intent: CreateDialogIntent,
    visibleMembers: FrontendTeamMember[],
    shadowMembers: FrontendTeamMember[],
  ): void {
    const select = modal.querySelector('#teammate-select');
    const shadowGroup = modal.querySelector('#shadow-members-group');
    const shadowSelect = modal.querySelector('#shadow-teammate-select');
    const taskInput = modal.querySelector('#task-doc-input');
    const suggestions = modal.querySelector('#task-doc-suggestions');
    const createBtn = modal.querySelector('#create-dialog-btn');
    const teammateInfo = modal.querySelector('#teammate-info');
    const feelOptions = modal.querySelector('#dominds-feel-options');
    const errorEl = modal.querySelector('#create-dialog-error');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('#modal-cancel-btn');
    const backdrop = modal.querySelector('.modal-backdrop');

    if (
      !(select instanceof HTMLSelectElement) ||
      !(taskInput instanceof HTMLInputElement) ||
      !(suggestions instanceof HTMLElement) ||
      !(createBtn instanceof HTMLButtonElement) ||
      !(teammateInfo instanceof HTMLElement) ||
      !(closeBtn instanceof HTMLButtonElement) ||
      !(cancelBtn instanceof HTMLButtonElement) ||
      !(backdrop instanceof HTMLElement)
    ) {
      this.close();
      return;
    }

    const t = getUiStrings(this.deps.getLanguage());
    let createInFlight = false;
    let currentAgentPrimingMode: AgentPrimingMode = 'do';
    let selectedSuggestionIndex = -1;
    let currentSuggestions: SuggestionDoc[] = [];
    let agentPrimingRenderSeq = 0;

    suggestions.style.display = 'none';

    const clearInlineError = (): void => {
      if (!(errorEl instanceof HTMLElement)) return;
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    };

    const setInlineError = (error: CreateDialogError): void => {
      if (!(errorEl instanceof HTMLElement)) return;
      errorEl.dataset.errorCode = error.code;
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
    };

    const setCreateInFlight = (inFlight: boolean): void => {
      createInFlight = inFlight;
      createBtn.disabled = inFlight;
      createBtn.dataset.createState = inFlight ? 'creating' : 'idle';
      createBtn.textContent = inFlight ? t.createDialogCreating : t.createDialog;
      closeBtn.disabled = inFlight;
      cancelBtn.disabled = inFlight;
      select.disabled = inFlight;
      if (shadowSelect instanceof HTMLSelectElement) shadowSelect.disabled = inFlight;
      taskInput.disabled = inFlight;
    };

    const hideSuggestions = (): void => {
      suggestions.innerHTML = '';
      suggestions.style.display = 'none';
      selectedSuggestionIndex = -1;
    };

    const hasVisibleSuggestions = (): boolean => {
      return suggestions.style.display !== 'none' && suggestions.innerHTML.trim() !== '';
    };

    const closeModal = (): void => {
      if (createInFlight) return;
      this.close();
    };

    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);

    const modalKeydownListener = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (createInFlight) {
        e.preventDefault();
        return;
      }
      if (hasVisibleSuggestions()) {
        e.preventDefault();
        hideSuggestions();
        return;
      }
      e.preventDefault();
      closeModal();
    };
    modal.addEventListener('keydown', modalKeydownListener, true);
    this.activeKeydownListener = modalKeydownListener;

    const resolveSelectedAgentId = (): string => {
      if (select.value === '__shadow__') {
        if (shadowSelect instanceof HTMLSelectElement) return shadowSelect.value || '';
        return '';
      }
      return select.value;
    };

    const showTeammateInfo = (selectedAgentId: string): void => {
      let resolved = selectedAgentId;
      if (selectedAgentId === '__shadow__') {
        resolved = shadowSelect instanceof HTMLSelectElement ? shadowSelect.value : '';
      }
      if (!resolved) {
        teammateInfo.style.display = 'none';
        return;
      }
      const member = [...visibleMembers, ...shadowMembers].find((m) => m.id === resolved);
      if (!member) {
        teammateInfo.style.display = 'none';
        return;
      }
      const emoji = this.getAgentEmoji(member.icon);
      const isDefault = member.id === this.deps.getDefaultResponder();
      teammateInfo.innerHTML = `
        <div class="teammate-details">
          <h4>${escapeHtml(`${emoji} ${member.name}${isDefault ? ' • Default' : ''}`)}</h4>
          <p><strong>Call Sign:</strong> @${escapeHtml(member.id)}</p>
          <p><strong>Provider:</strong> ${escapeHtml(member.provider ?? 'Not specified')}</p>
          <p><strong>Model:</strong> ${escapeHtml(member.model ?? 'Not specified')}</p>
          ${
            Array.isArray(member.gofor) && member.gofor.length > 0
              ? `<p><strong>Specializes in:</strong> ${escapeHtml(member.gofor.join(', '))}</p>`
              : ''
          }
        </div>
      `;
      teammateInfo.style.display = 'block';
    };

    const formatCompactAge = (ageSeconds: number): string => {
      const totalSeconds = Number.isFinite(ageSeconds) ? Math.max(0, Math.floor(ageSeconds)) : 0;
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      let out = '';
      if (days > 0) out += `${days}d`;
      if (hours > 0 || days > 0) out += `${hours}h`;
      out += `${minutes}m`;
      return out;
    };

    const readStoredAgentPrimingMode = (scope: DomindsFeelScope): AgentPrimingMode | null => {
      try {
        const key =
          scope === 'shadow'
            ? CreateDialogFlowController.AGENT_PRIMING_MODE_SHADOW_STORAGE_KEY
            : CreateDialogFlowController.AGENT_PRIMING_MODE_STORAGE_KEY;
        const raw = localStorage.getItem(key);
        if (raw === 'do' || raw === 'reuse' || raw === 'skip') return raw;
        return null;
      } catch (error: unknown) {
        console.warn('Failed to read agent-priming mode from localStorage', error);
        return null;
      }
    };

    const persistAgentPrimingMode = (mode: AgentPrimingMode, scope: DomindsFeelScope): void => {
      try {
        const key =
          scope === 'shadow'
            ? CreateDialogFlowController.AGENT_PRIMING_MODE_SHADOW_STORAGE_KEY
            : CreateDialogFlowController.AGENT_PRIMING_MODE_STORAGE_KEY;
        localStorage.setItem(key, mode);
      } catch (error: unknown) {
        console.warn('Failed to persist agent-priming mode to localStorage', error);
      }
    };

    const renderPrimingChoices = (args: {
      hasCache: boolean;
      ageSeconds: number;
      scope: DomindsFeelScope;
    }): void => {
      if (!(feelOptions instanceof HTMLElement)) return;
      const stored = readStoredAgentPrimingMode(args.scope);
      const allowed: AgentPrimingMode[] = args.hasCache ? ['reuse', 'do', 'skip'] : ['do', 'skip'];
      const selected: AgentPrimingMode = (() => {
        if (stored && allowed.includes(stored)) return stored;
        if (args.scope === 'shadow') return 'skip';
        return args.hasCache ? 'reuse' : 'do';
      })();
      currentAgentPrimingMode = selected;
      const reuseLabel = `${formatCompactAge(args.ageSeconds)}${t.agentPrimingReuseAgeSuffix}`;
      const optionRows: Array<{ mode: AgentPrimingMode; label: string }> = args.hasCache
        ? [
            { mode: 'reuse', label: reuseLabel },
            { mode: 'do', label: t.agentPrimingRerun },
            { mode: 'skip', label: t.agentPrimingSkip },
          ]
        : [
            { mode: 'do', label: t.agentPrimingDo },
            { mode: 'skip', label: t.agentPrimingSkip },
          ];
      feelOptions.innerHTML = optionRows
        .map((row) => {
          const checked = row.mode === selected ? 'checked' : '';
          return `<label class="dominds-feel-option"><input type="radio" name="dominds-feel" value="${row.mode}" ${checked}><span>${escapeHtml(
            row.label,
          )}</span></label>`;
        })
        .join('');
    };

    const refreshPrimingChoices = async (): Promise<void> => {
      if (!(feelOptions instanceof HTMLElement)) return;
      const selectedAgent = resolveSelectedAgentId();
      const scope: DomindsFeelScope = select.value === '__shadow__' ? 'shadow' : 'visible';
      if (!selectedAgent) {
        renderPrimingChoices({ hasCache: false, ageSeconds: 0, scope });
        return;
      }
      const seq = (agentPrimingRenderSeq += 1);
      feelOptions.innerHTML = `<span class="dominds-feel-loading">${escapeHtml(t.loading)}</span>`;
      try {
        const status = await this.deps.getAgentPrimingStatus(selectedAgent);
        if (seq !== agentPrimingRenderSeq) return;
        let ageSeconds = 0;
        if (typeof status.ageSeconds === 'number' && Number.isFinite(status.ageSeconds)) {
          ageSeconds = status.ageSeconds;
        } else if (typeof status.createdAt === 'string') {
          const createdAtMs = Date.parse(status.createdAt);
          if (Number.isFinite(createdAtMs)) {
            ageSeconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
          }
        }
        renderPrimingChoices({ hasCache: status.hasCache, ageSeconds, scope });
      } catch (error: unknown) {
        if (seq !== agentPrimingRenderSeq) return;
        console.warn('Failed to fetch agent priming status', error);
        renderPrimingChoices({ hasCache: false, ageSeconds: 0, scope });
      }
    };

    if (feelOptions instanceof HTMLElement) {
      feelOptions.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;
        const v = target.value;
        if (v !== 'do' && v !== 'reuse' && v !== 'skip') return;
        currentAgentPrimingMode = v;
        const scope: DomindsFeelScope = select.value === '__shadow__' ? 'shadow' : 'visible';
        persistAgentPrimingMode(v, scope);
      });
    }

    select.addEventListener('change', () => {
      const isShadow = select.value === '__shadow__';
      if (shadowGroup instanceof HTMLElement) {
        shadowGroup.style.display = isShadow ? 'block' : 'none';
      }
      showTeammateInfo(select.value);
      void refreshPrimingChoices();
    });
    if (shadowSelect instanceof HTMLSelectElement) {
      shadowSelect.addEventListener('change', () => {
        showTeammateInfo('__shadow__');
        void refreshPrimingChoices();
      });
    }
    showTeammateInfo(select.value);
    void refreshPrimingChoices();

    const updateSuggestions = (query: string): void => {
      const normalized = query.trim().toLowerCase();
      if (!normalized) {
        hideSuggestions();
        return;
      }
      currentSuggestions = this.deps
        .getTaskDocuments()
        .filter(
          (doc) =>
            doc.relativePath.toLowerCase().includes(normalized) ||
            doc.name.toLowerCase().includes(normalized),
        )
        .map((doc) => ({
          ...doc,
          _score: this.calculateSortScore(
            doc.name.toLowerCase().includes(normalized),
            doc.relativePath.toLowerCase().includes(normalized),
            doc.name.toLowerCase().startsWith(normalized),
            doc.relativePath.toLowerCase().startsWith(normalized),
            doc.name.toLowerCase() === normalized,
          ),
        }))
        .sort((a, b) => {
          if (a._score !== b._score) return b._score - a._score;
          if (a.name.length !== b.name.length) return a.name.length - b.name.length;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 50)
        .map(({ _score, ...doc }) => doc);
      if (currentSuggestions.length === 0) {
        suggestions.innerHTML = `<div class="no-suggestions">${escapeHtml(t.taskDocumentNoMatches)}</div>`;
        suggestions.style.display = 'block';
        selectedSuggestionIndex = -1;
        return;
      }
      suggestions.innerHTML = currentSuggestions
        .map(
          (doc, index) =>
            `<div class="suggestion ${index === selectedSuggestionIndex ? 'selected' : ''}" data-index="${String(index)}"><div class="suggestion-path">${escapeHtml(
              doc.relativePath,
            )}</div><div class="suggestion-name">${escapeHtml(doc.name)}</div></div>`,
        )
        .join('');
      suggestions.style.display = 'block';
      selectedSuggestionIndex = -1;
    };

    const selectSuggestion = (index: number): void => {
      if (index < 0 || index >= currentSuggestions.length) return;
      taskInput.value = currentSuggestions[index].relativePath;
      hideSuggestions();
      taskInput.focus();
    };

    taskInput.addEventListener('input', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      updateSuggestions(target.value);
    });

    taskInput.addEventListener('keydown', (e) => {
      if (suggestions.style.display === 'none') {
        if (e.key === 'Enter') {
          e.preventDefault();
          createBtn.click();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          selectedSuggestionIndex = Math.min(
            selectedSuggestionIndex + 1,
            currentSuggestions.length - 1,
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
          break;
        case 'Tab': {
          e.preventDefault();
          if (currentSuggestions.length > 0) {
            const commonPrefix = this.calculateCommonPrefix(
              currentSuggestions.map((d) => d.relativePath),
            );
            if (commonPrefix.length > taskInput.value.length) {
              taskInput.value = commonPrefix;
              taskInput.dispatchEvent(new Event('input', { bubbles: true }));
              return;
            }
          }
          if (currentSuggestions.length > 0 && selectedSuggestionIndex < 0) {
            selectedSuggestionIndex = 0;
            selectSuggestion(selectedSuggestionIndex);
          }
          break;
        }
        case 'Enter':
          e.preventDefault();
          if (selectedSuggestionIndex >= 0) {
            selectSuggestion(selectedSuggestionIndex);
          } else if (currentSuggestions.length === 0) {
            createBtn.click();
          }
          break;
        case 'Escape':
          e.preventDefault();
          hideSuggestions();
          break;
      }
      const suggestionElements = suggestions.querySelectorAll('.suggestion');
      suggestionElements.forEach((el, index) => {
        if (!(el instanceof HTMLElement)) return;
        el.classList.toggle('selected', index === selectedSuggestionIndex);
      });
    });

    suggestions.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const suggestionEl = target.closest('.suggestion');
      if (!(suggestionEl instanceof HTMLElement)) return;
      const rawIndex = suggestionEl.dataset.index;
      if (typeof rawIndex !== 'string') return;
      const index = Number.parseInt(rawIndex, 10);
      if (!Number.isFinite(index)) return;
      selectSuggestion(index);
    });

    createBtn.addEventListener('click', async () => {
      if (createInFlight) return;
      clearInlineError();
      if (hasVisibleSuggestions()) hideSuggestions();

      const normalizedTaskDocPath = this.normalizeTaskDocPath(taskInput.value);
      if (!normalizedTaskDocPath.ok) {
        setInlineError(normalizedTaskDocPath.error);
        this.state = { kind: 'failed', intent, error: normalizedTaskDocPath.error };
        return;
      }
      taskInput.value = normalizedTaskDocPath.taskDocPath;

      const selectedAgentId = resolveSelectedAgentId();
      if (!selectedAgentId) {
        const error: CreateDialogError = {
          code: 'TEAM_MEMBER_INVALID',
          message: t.shadowMembersSelectRequired,
        };
        setInlineError(error);
        this.state = { kind: 'failed', intent, error };
        return;
      }

      const requestId = this.generateRequestId();
      this.state = { kind: 'submitting', intent, requestId };
      setCreateInFlight(true);
      const request: CreateDialogRequest = {
        requestId,
        agentId: selectedAgentId,
        taskDocPath: normalizedTaskDocPath.taskDocPath,
        agentPrimingMode: currentAgentPrimingMode,
      };
      try {
        const result = await this.deps.submitCreateDialog(request);
        if (result.kind === 'failure') {
          if (result.error.code === 'AUTH_REQUIRED') {
            this.deps.onAuthRequired();
          }
          setInlineError(result.error);
          this.state = { kind: 'failed', intent, error: result.error };
          return;
        }
        this.state = { kind: 'succeeded', intent, result };
        await this.deps.onCreated(result);
        this.close();
      } catch (error: unknown) {
        const fallback: CreateDialogError = {
          code: 'CREATE_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        };
        setInlineError(fallback);
        this.state = { kind: 'failed', intent, error: fallback };
      } finally {
        if (this.modal !== null) setCreateInFlight(false);
      }
    });

    modal.addEventListener('keydown', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const tag = target.tagName;
      if (
        e.key === 'Enter' &&
        tag !== 'INPUT' &&
        tag !== 'SELECT' &&
        tag !== 'TEXTAREA' &&
        tag !== 'BUTTON'
      ) {
        e.preventDefault();
        createBtn.click();
      }
    });
  }

  private normalizeTaskDocPath(
    raw: string,
  ): { ok: true; taskDocPath: string } | { ok: false; error: CreateDialogError } {
    let next = raw.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    if (!next) next = 'socializing.tsk';
    if (!next.endsWith('.tsk')) next = `${next}.tsk`;
    if (!next || next === '.tsk') {
      return {
        ok: false,
        error: { code: 'TASKDOC_INVALID', message: 'Taskdoc path is invalid' },
      };
    }
    return { ok: true, taskDocPath: next };
  }

  private getAgentEmoji(icon?: string): string {
    if (typeof icon === 'string' && icon !== '') return icon;
    return '🛠';
  }

  private calculateSortScore(
    nameMatch: boolean,
    pathMatch: boolean,
    nameStartsWith: boolean,
    pathStartsWith: boolean,
    nameExactMatch: boolean,
  ): number {
    if (nameExactMatch) return 100;
    if (nameStartsWith) return 90;
    if (pathStartsWith) return 80;
    if (nameMatch) return 70;
    if (pathMatch) return 60;
    return 0;
  }

  private calculateCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];
    const shortest = strings.reduce(
      (min, str) => (str.length < min.length ? str : min),
      strings[0],
    );
    let commonPrefix = '';
    for (let i = 0; i < shortest.length; i += 1) {
      const char = shortest[i];
      const allHaveChar = strings.every((str) => str[i] === char);
      if (!allHaveChar) break;
      commonPrefix += char;
    }
    return commonPrefix;
  }

  private generateRequestId(): string {
    return `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
