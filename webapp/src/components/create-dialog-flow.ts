import { getUiStrings } from '../i18n/ui';
import type { FrontendTeamMember } from '../services/api';
import type {
  DialogPrimingInput,
  PrimingScriptSummary,
  PrimingScriptWarningSummary,
} from '../shared/types';
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
  requestId: string;
  priming?: DialogPrimingInput;
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
  listPrimingScripts: (
    agentId: string,
  ) => Promise<{ recent: PrimingScriptSummary[]; warningSummary?: PrimingScriptWarningSummary }>;
  searchPrimingScripts: (
    agentId: string,
    query: string,
  ) => Promise<{ scripts: PrimingScriptSummary[]; warningSummary?: PrimingScriptWarningSummary }>;
  ensureTeamMembersReady: () => Promise<{ ok: true } | { ok: false; error: CreateDialogError }>;
  submitCreateDialog: (request: CreateDialogRequest) => Promise<CreateDialogResult>;
  onCreated: (result: CreateDialogSuccess) => Promise<void>;
  onAuthRequired: () => void;
  onToast: (message: string, kind: 'error' | 'warning' | 'info') => void;
};

type SuggestionDoc = { path: string; relativePath: string; name: string };
type PrimingCatalog = {
  recent: PrimingScriptSummary[];
  warningSummary?: PrimingScriptWarningSummary;
};
type PrimingSelectionPreference = {
  scriptRefs: string[];
  showInUi: boolean;
};
type PrimingSelectionPreferenceStore = {
  version: 1;
  byAgent: Record<string, PrimingSelectionPreference>;
};

const PRIMING_SELECTION_STORAGE_KEY = 'dominds-create-dialog-priming-selection-v1';

export class CreateDialogFlowController {
  private readonly deps: CreateDialogControllerDeps;
  private state: CreateDialogUiState = { kind: 'idle' };
  private modal: HTMLElement | null = null;
  private activeKeydownListener: ((e: KeyboardEvent) => void) | null = null;
  private refreshI18nInModal: (() => void) | null = null;

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
    this.refreshI18nInModal = null;
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
    if (this.refreshI18nInModal) {
      this.refreshI18nInModal();
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
        const nextAgentId = intent.presetAgentId.trim();
        if (teammateSelect.value !== nextAgentId) {
          teammateSelect.value = nextAgentId;
          teammateSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
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
            <div class="form-inline-row">
              <label for="task-doc-input">${escapeHtml(t.taskDocumentLabel)}</label>
              <div class="task-doc-container">
                <input type="text" id="task-doc-input" class="task-doc-input" placeholder="${escapeHtml(
                  t.taskDocumentPlaceholder,
                )}" autocomplete="off" value="${escapeHtml(taskPreset)}">
                <div id="task-doc-suggestions" class="task-doc-suggestions"></div>
              </div>
            </div>
            <small class="form-help">${escapeHtml(t.taskDocumentHelp)}</small>
          </div>
          <div class="form-group form-group-vertical">
            <div class="form-inline-row">
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
          <div class="form-group form-group-vertical priming-group">
            <div class="priming-header-row">
              <label for="priming-recent-select" id="priming-scripts-label">${escapeHtml(t.primingScriptsLabel)}</label>
              <select id="priming-recent-select" class="teammate-dropdown priming-inline-select">
                <option value="__none__">${escapeHtml(t.primingNoneOption)}</option>
                <option value="__more__">${escapeHtml(t.primingMoreOption)}</option>
              </select>
              <label class="priming-ui-toggle" for="priming-show-in-ui">
                <input type="checkbox" id="priming-show-in-ui" checked>
                <span id="priming-show-in-ui-label">${escapeHtml(t.primingShowInUiLabel)}</span>
              </label>
            </div>
            <div id="priming-more-section" class="priming-more-section" style="display:none;">
              <input type="text" id="priming-search-input" class="task-doc-input" placeholder="${escapeHtml(
                t.primingSearchPlaceholder,
              )}" autocomplete="off">
              <div id="priming-search-results" class="priming-search-results"></div>
            </div>
            <small class="form-help" id="priming-help">${escapeHtml(t.primingHelpText)}</small>
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
    const errorEl = modal.querySelector('#create-dialog-error');
    const closeBtn = modal.querySelector('.modal-close');
    const cancelBtn = modal.querySelector('#modal-cancel-btn');
    const backdrop = modal.querySelector('.modal-backdrop');
    const primingRecentSelect = modal.querySelector('#priming-recent-select');
    const primingMoreSection = modal.querySelector('#priming-more-section');
    const primingSearchInput = modal.querySelector('#priming-search-input');
    const primingSearchResults = modal.querySelector('#priming-search-results');
    const primingShowInUi = modal.querySelector('#priming-show-in-ui');
    const primingScriptsLabel = modal.querySelector('#priming-scripts-label');
    const primingShowInUiLabel = modal.querySelector('#priming-show-in-ui-label');
    const primingHelp = modal.querySelector('#priming-help');

    if (
      !(select instanceof HTMLSelectElement) ||
      !(taskInput instanceof HTMLInputElement) ||
      !(suggestions instanceof HTMLElement) ||
      !(createBtn instanceof HTMLButtonElement) ||
      !(teammateInfo instanceof HTMLElement) ||
      !(closeBtn instanceof HTMLButtonElement) ||
      !(cancelBtn instanceof HTMLButtonElement) ||
      !(backdrop instanceof HTMLElement) ||
      !(primingRecentSelect instanceof HTMLSelectElement) ||
      !(primingMoreSection instanceof HTMLElement) ||
      !(primingSearchInput instanceof HTMLInputElement) ||
      !(primingSearchResults instanceof HTMLElement) ||
      !(primingShowInUi instanceof HTMLInputElement) ||
      !(primingScriptsLabel instanceof HTMLElement) ||
      !(primingShowInUiLabel instanceof HTMLElement) ||
      !(primingHelp instanceof HTMLElement)
    ) {
      this.close();
      return;
    }

    const strings = () => getUiStrings(this.deps.getLanguage());
    let createInFlight = false;
    let selectedSuggestionIndex = -1;
    let currentSuggestions: SuggestionDoc[] = [];
    let primingCatalog: PrimingCatalog = { recent: [] };
    let knownPrimingScriptsByRef = new Map<string, PrimingScriptSummary>();
    let selectedPrimingRef: string | null = null;
    let selectedPrimingDropdownValue = '__none__';
    let primingSearchTerm = '';
    let primingLoading = false;
    let primingSearchLoading = false;
    let primingSearchMatches: PrimingScriptSummary[] = [];
    let primingLoadSeq = 0;
    let primingSearchSeq = 0;
    let primingBoundAgentId = '';
    const isRecord = (value: unknown): value is Record<string, unknown> => {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    };

    const normalizePreference = (value: unknown): PrimingSelectionPreference | null => {
      if (!isRecord(value)) return null;
      const scriptRefsRaw = value['scriptRefs'];
      const showInUiRaw = value['showInUi'];
      if (!Array.isArray(scriptRefsRaw)) return null;
      if (typeof showInUiRaw !== 'boolean') return null;
      const dedupedRefs: string[] = [];
      const seen = new Set<string>();
      for (const item of scriptRefsRaw) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed === '' || seen.has(trimmed)) continue;
        seen.add(trimmed);
        dedupedRefs.push(trimmed);
      }
      return {
        scriptRefs: dedupedRefs,
        showInUi: showInUiRaw,
      };
    };

    const readPrimingPreference = (agentId: string): PrimingSelectionPreference | null => {
      const normalizedAgentId = agentId.trim();
      if (normalizedAgentId === '') return null;
      try {
        const raw = window.localStorage.getItem(PRIMING_SELECTION_STORAGE_KEY);
        if (typeof raw !== 'string' || raw.trim() === '') return null;
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) return null;
        if (parsed['version'] !== 1) return null;
        const byAgentRaw = parsed['byAgent'];
        if (!isRecord(byAgentRaw)) return null;
        return normalizePreference(byAgentRaw[normalizedAgentId]);
      } catch {
        return null;
      }
    };

    const writePrimingPreference = (agentId: string, pref: PrimingSelectionPreference): void => {
      const normalizedAgentId = agentId.trim();
      if (normalizedAgentId === '') return;
      const normalizedPref = normalizePreference(pref);
      if (!normalizedPref) return;
      const byAgent: Record<string, PrimingSelectionPreference> = {};
      try {
        const raw = window.localStorage.getItem(PRIMING_SELECTION_STORAGE_KEY);
        if (typeof raw === 'string' && raw.trim() !== '') {
          const parsed: unknown = JSON.parse(raw);
          if (isRecord(parsed) && parsed['version'] === 1 && isRecord(parsed['byAgent'])) {
            for (const [key, value] of Object.entries(parsed['byAgent'])) {
              const normalized = normalizePreference(value);
              if (!normalized) continue;
              byAgent[key] = normalized;
            }
          }
        }
        byAgent[normalizedAgentId] = normalizedPref;
        const payload: PrimingSelectionPreferenceStore = { version: 1, byAgent };
        window.localStorage.setItem(PRIMING_SELECTION_STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // Ignore localStorage errors and continue without persisted defaults.
      }
    };

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
    const primingUiToggle = primingShowInUi.closest('.priming-ui-toggle');
    const syncPrimingShowInUiDisabled = (): void => {
      const disabledByNone = selectedPrimingDropdownValue === '__none__';
      const disabled = createInFlight || disabledByNone;
      primingShowInUi.disabled = disabled;
      if (primingUiToggle instanceof HTMLElement) {
        primingUiToggle.classList.toggle('disabled', disabledByNone);
      }
    };

    const setCreateInFlight = (inFlight: boolean): void => {
      createInFlight = inFlight;
      const t = strings();
      createBtn.disabled = inFlight;
      createBtn.dataset.createState = inFlight ? 'creating' : 'idle';
      createBtn.textContent = inFlight ? t.createDialogCreating : t.createDialog;
      closeBtn.disabled = inFlight;
      cancelBtn.disabled = inFlight;
      select.disabled = inFlight;
      if (shadowSelect instanceof HTMLSelectElement) shadowSelect.disabled = inFlight;
      taskInput.disabled = inFlight;
      primingSearchInput.disabled = inFlight;
      primingRecentSelect.disabled = inFlight || primingLoading;
      primingSearchResults
        .querySelectorAll<HTMLButtonElement>('button.priming-script-select')
        .forEach((btn) => {
          btn.disabled = inFlight;
        });
      syncPrimingShowInUiDisabled();
    };

    const formatPrimingScriptLabel = (script: PrimingScriptSummary): string => {
      const title = typeof script.title === 'string' ? script.title.trim() : '';
      if (title !== '' && title !== script.slug) {
        return `${title} (${script.slug})`;
      }
      return script.slug;
    };

    const setPrimingMoreVisible = (visible: boolean): void => {
      primingMoreSection.style.display = visible ? 'block' : 'none';
      if (!visible) {
        primingSearchSeq += 1;
        primingSearchTerm = '';
        primingSearchInput.value = '';
        primingSearchLoading = false;
        primingSearchMatches = [];
      }
    };

    const renderPrimingRecentOptions = (): void => {
      const t = strings();
      const optionValues = new Set<string>();
      const options: string[] = [
        `<option value="__none__">${escapeHtml(t.primingNoneOption)}</option>`,
      ];
      optionValues.add('__none__');

      const recentSeen = new Set<string>();
      for (const script of primingCatalog.recent) {
        if (recentSeen.has(script.ref)) continue;
        recentSeen.add(script.ref);
        optionValues.add(script.ref);
        options.push(
          `<option value="${escapeHtml(script.ref)}">${escapeHtml(formatPrimingScriptLabel(script))}</option>`,
        );
      }
      if (selectedPrimingRef !== null && !recentSeen.has(selectedPrimingRef)) {
        const selectedScript = knownPrimingScriptsByRef.get(selectedPrimingRef);
        const selectedLabel = selectedScript
          ? formatPrimingScriptLabel(selectedScript)
          : selectedPrimingRef;
        optionValues.add(selectedPrimingRef);
        options.push(
          `<option value="${escapeHtml(selectedPrimingRef)}">${escapeHtml(selectedLabel)}</option>`,
        );
      }

      optionValues.add('__more__');
      options.push(`<option value="__more__">${escapeHtml(t.primingMoreOption)}</option>`);
      primingRecentSelect.innerHTML = options.join('');
      if (!optionValues.has(selectedPrimingDropdownValue)) {
        selectedPrimingDropdownValue =
          selectedPrimingRef !== null ? selectedPrimingRef : '__none__';
      }
      primingRecentSelect.value = optionValues.has(selectedPrimingDropdownValue)
        ? selectedPrimingDropdownValue
        : '__none__';
      primingRecentSelect.disabled = createInFlight || primingLoading;
      syncPrimingShowInUiDisabled();
    };

    const renderPrimingSearchResults = (): void => {
      const t = strings();
      if (primingMoreSection.style.display === 'none') {
        primingSearchResults.innerHTML = '';
        return;
      }
      if (primingSearchLoading) {
        primingSearchResults.innerHTML = `<div class="priming-search-empty">${escapeHtml(t.loading)}</div>`;
        return;
      }
      const normalized = primingSearchTerm.trim();
      if (normalized === '') {
        primingSearchResults.innerHTML = '';
        return;
      }
      const matches = primingSearchMatches;
      if (matches.length === 0) {
        primingSearchResults.innerHTML = `<div class="priming-search-empty">${escapeHtml(t.primingNoMatches)}</div>`;
        return;
      }
      primingSearchResults.innerHTML = matches
        .map((script) => {
          const scopeLabel =
            script.scope === 'team_shared'
              ? t.primingScopeTeamShared
              : script.ownerAgentId
                ? `@${script.ownerAgentId}`
                : t.primingScopeIndividual;
          return `<div class="priming-search-item"><div class="priming-search-meta"><div class="priming-search-name">${escapeHtml(
            formatPrimingScriptLabel(script),
          )}</div><div class="priming-search-ref">${escapeHtml(script.ref)} · ${escapeHtml(
            scopeLabel,
          )}</div></div><button type="button" class="priming-script-select" data-script-ref="${escapeHtml(
            script.ref,
          )}">${escapeHtml(t.primingAddScriptAction)}</button></div>`;
        })
        .join('');
      primingSearchResults
        .querySelectorAll<HTMLButtonElement>('button.priming-script-select')
        .forEach((btn) => {
          btn.disabled = createInFlight;
        });
    };

    const refreshPrimingLocalizedTexts = (): void => {
      const t = strings();
      primingScriptsLabel.textContent = t.primingScriptsLabel;
      primingShowInUiLabel.textContent = t.primingShowInUiLabel;
      primingSearchInput.placeholder = t.primingSearchPlaceholder;
      primingHelp.textContent = t.primingHelpText;
      renderPrimingRecentOptions();
      renderPrimingSearchResults();
    };

    this.refreshI18nInModal = refreshPrimingLocalizedTexts;
    refreshPrimingLocalizedTexts();

    const setPrimingLoading = (loading: boolean): void => {
      primingLoading = loading;
      primingRecentSelect.disabled = loading || createInFlight;
      if (loading) {
        const t = strings();
        primingRecentSelect.innerHTML = `<option value="">${escapeHtml(t.loading)}</option>`;
      } else {
        renderPrimingRecentOptions();
      }
    };

    const setPrimingSearchLoading = (loading: boolean): void => {
      primingSearchLoading = loading;
      renderPrimingSearchResults();
    };
    const seenPrimingWarningSignatures = new Set<string>();

    const emitPrimingWarningToast = (summary: PrimingScriptWarningSummary | undefined): void => {
      if (!summary || summary.skippedCount <= 0) return;
      const signature = JSON.stringify(summary);
      if (seenPrimingWarningSignatures.has(signature)) return;
      seenPrimingWarningSignatures.add(signature);

      const t = strings();
      const sampleTexts = summary.samples
        .slice(0, 2)
        .map((item) => `${item.path}: ${item.error.replace(/\s+/g, ' ').trim()}`)
        .join(' | ');
      const extraCount = Math.max(0, summary.skippedCount - summary.samples.length);
      const extraText = extraCount > 0 ? ` (+${String(extraCount)})` : '';
      const message = `${t.primingInvalidScriptsSkippedToastPrefix}${String(
        summary.skippedCount,
      )}${t.primingInvalidScriptsSkippedToastMiddle}${sampleTexts}${extraText}`;
      this.deps.onToast(message, 'error');
    };

    const setSelectedPrimingScript = (
      scriptRef: string | null,
      dropdownValueOverride?: string,
    ): void => {
      selectedPrimingRef = scriptRef;
      selectedPrimingDropdownValue =
        typeof dropdownValueOverride === 'string'
          ? dropdownValueOverride
          : scriptRef !== null
            ? scriptRef
            : '__none__';
      renderPrimingRecentOptions();
      renderPrimingSearchResults();
      syncPrimingShowInUiDisabled();
    };

    const loadPrimingScriptsForSelectedAgent = async (): Promise<void> => {
      const selectedAgentId = resolveSelectedAgentId().trim();
      const requestSeq = primingLoadSeq + 1;
      primingLoadSeq = requestSeq;
      if (primingBoundAgentId !== selectedAgentId) {
        primingBoundAgentId = selectedAgentId;
        const savedPreference = readPrimingPreference(selectedAgentId);
        selectedPrimingRef =
          savedPreference && savedPreference.scriptRefs.length > 0
            ? savedPreference.scriptRefs[0]
            : null;
        selectedPrimingDropdownValue =
          selectedPrimingRef !== null ? selectedPrimingRef : '__none__';
        primingShowInUi.checked = savedPreference ? savedPreference.showInUi : true;
        knownPrimingScriptsByRef = new Map<string, PrimingScriptSummary>();
      }
      primingSearchSeq += 1;
      setPrimingSearchLoading(false);
      primingSearchMatches = [];
      setPrimingMoreVisible(false);
      renderPrimingSearchResults();

      if (selectedAgentId === '') {
        primingCatalog = { recent: [] };
        setSelectedPrimingScript(null);
        renderPrimingRecentOptions();
        renderPrimingSearchResults();
        return;
      }

      setPrimingLoading(true);
      try {
        const listed = await this.deps.listPrimingScripts(selectedAgentId);
        if (requestSeq !== primingLoadSeq) return;
        primingCatalog = listed;
        emitPrimingWarningToast(listed.warningSummary);
        for (const script of primingCatalog.recent) {
          knownPrimingScriptsByRef.set(script.ref, script);
        }
        if (selectedPrimingRef !== null && !knownPrimingScriptsByRef.has(selectedPrimingRef)) {
          setSelectedPrimingScript(null);
        }
        renderPrimingRecentOptions();
        renderPrimingSearchResults();
      } catch (error: unknown) {
        if (requestSeq !== primingLoadSeq) return;
        primingCatalog = { recent: [] };
        selectedPrimingRef = null;
        selectedPrimingDropdownValue = '__none__';
        knownPrimingScriptsByRef = new Map<string, PrimingScriptSummary>();
        renderPrimingRecentOptions();
        renderPrimingSearchResults();
        const t = strings();
        const reason = error instanceof Error ? error.message : t.unknownError;
        this.deps.onToast(`${t.primingLoadFailedToastPrefix}${reason}`, 'warning');
      } finally {
        if (requestSeq === primingLoadSeq) {
          setPrimingLoading(false);
        }
      }
    };

    const searchPrimingScriptsForSelectedAgent = async (queryText: string): Promise<void> => {
      const selectedAgentId = resolveSelectedAgentId().trim();
      primingSearchTerm = queryText;
      const normalizedQuery = queryText.trim();
      const requestSeq = primingSearchSeq + 1;
      primingSearchSeq = requestSeq;

      if (selectedAgentId === '' || normalizedQuery === '') {
        setPrimingSearchLoading(false);
        primingSearchMatches = [];
        renderPrimingSearchResults();
        return;
      }

      setPrimingSearchLoading(true);
      try {
        const matched = await this.deps.searchPrimingScripts(selectedAgentId, normalizedQuery);
        if (requestSeq !== primingSearchSeq) return;
        primingSearchMatches = matched.scripts;
        emitPrimingWarningToast(matched.warningSummary);
        for (const script of primingSearchMatches) {
          knownPrimingScriptsByRef.set(script.ref, script);
        }
        renderPrimingSearchResults();
      } catch (error: unknown) {
        if (requestSeq !== primingSearchSeq) return;
        primingSearchMatches = [];
        renderPrimingSearchResults();
        const t = strings();
        const reason = error instanceof Error ? error.message : t.unknownError;
        this.deps.onToast(`${t.primingLoadFailedToastPrefix}${reason}`, 'warning');
      } finally {
        if (requestSeq === primingSearchSeq) {
          setPrimingSearchLoading(false);
        }
      }
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
      if (primingMoreSection.style.display !== 'none') {
        e.preventDefault();
        setPrimingMoreVisible(false);
        renderPrimingSearchResults();
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

    const persistPrimingPreference = (): void => {
      const selectedAgentId = resolveSelectedAgentId().trim();
      if (selectedAgentId === '') return;
      writePrimingPreference(selectedAgentId, {
        scriptRefs: selectedPrimingRef !== null ? [selectedPrimingRef] : [],
        showInUi: primingShowInUi.checked,
      });
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

    select.addEventListener('change', () => {
      const isShadow = select.value === '__shadow__';
      if (shadowGroup instanceof HTMLElement) {
        shadowGroup.style.display = isShadow ? 'block' : 'none';
      }
      showTeammateInfo(select.value);
      void loadPrimingScriptsForSelectedAgent();
    });
    if (shadowSelect instanceof HTMLSelectElement) {
      shadowSelect.addEventListener('change', () => {
        showTeammateInfo('__shadow__');
        void loadPrimingScriptsForSelectedAgent();
      });
    }
    showTeammateInfo(select.value);
    void loadPrimingScriptsForSelectedAgent();

    primingRecentSelect.addEventListener('change', () => {
      const value = primingRecentSelect.value;
      if (value === '__more__') {
        setPrimingMoreVisible(true);
        void searchPrimingScriptsForSelectedAgent(primingSearchInput.value);
        primingSearchInput.focus();
        renderPrimingRecentOptions();
        return;
      }
      if (value === '__none__') {
        setSelectedPrimingScript(null, '__none__');
        setPrimingMoreVisible(false);
        return;
      }
      if (value === '') {
        setSelectedPrimingScript(null, '__none__');
        return;
      }
      setSelectedPrimingScript(value);
      setPrimingMoreVisible(false);
    });

    primingSearchInput.addEventListener('input', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      void searchPrimingScriptsForSelectedAgent(target.value);
    });

    primingSearchResults.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const selectBtn = target.closest('button.priming-script-select');
      if (!(selectBtn instanceof HTMLButtonElement)) return;
      const scriptRef = selectBtn.dataset.scriptRef;
      if (typeof scriptRef !== 'string' || scriptRef.trim() === '') return;
      setSelectedPrimingScript(scriptRef);
      setPrimingMoreVisible(false);
    });

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
        const t = strings();
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
        const t = strings();
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
      };
      if (selectedPrimingRef !== null) {
        request.priming = {
          scriptRefs: [selectedPrimingRef],
          showInUi: primingShowInUi.checked,
        };
      }
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
        persistPrimingPreference();
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
