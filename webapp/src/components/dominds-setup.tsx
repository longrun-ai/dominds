import faviconUrl from '../assets/favicon.svg';
import { getUiStrings, type UiStrings } from '../i18n/ui';
import { getApiClient } from '../services/api';
import {
  readAuthKeyFromLocalStorage,
  readAuthKeyFromUrl,
  removeAuthKeyFromUrl,
  writeAuthKeyToLocalStorage,
} from '../services/auth';
import type {
  SetupFileKind,
  SetupFileResponse,
  SetupProminentEnumModelParam,
  SetupProviderSummary,
  SetupRequirement,
  SetupStatusResponse,
} from '../shared/types';
import {
  formatLanguageName,
  normalizeLanguageCode,
  supportedLanguageCodes,
  type LanguageCode,
} from '../shared/types/language';
import { escapeHtmlAttr } from '../shared/utils/html.js';
import './dominds-code-block';

type AuthState =
  | { kind: 'uninitialized' }
  | { kind: 'none' }
  | { kind: 'active'; source: 'url' | 'localStorage' | 'manual'; key: string }
  | { kind: 'prompt'; reason: 'missing' | 'rejected' };

type SetupState =
  | { kind: 'loading' }
  | { kind: 'auth_required' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: SetupStatusResponse };

type WorkspaceLlmDraft = {
  raw: string;
};

type FileModalState =
  | { kind: 'closed' }
  | { kind: 'loading'; fileKind: SetupFileKind }
  | {
      kind: 'ready';
      fileKind: SetupFileKind;
      response: Extract<SetupFileResponse, { success: true }>;
    }
  | { kind: 'error'; fileKind: SetupFileKind; path: string; message: string };

type ConfirmModalState =
  | { kind: 'closed' }
  | {
      kind: 'confirm_overwrite';
      path: string;
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel: string;
      onConfirm: { kind: 'write_team_yaml' } | { kind: 'write_workspace_llm_yaml' };
    };

export class DomindsSetup extends HTMLElement {
  private apiClient = getApiClient();
  private authState: AuthState = { kind: 'uninitialized' };
  private state: SetupState = { kind: 'loading' };
  private fileModal: FileModalState = { kind: 'closed' };
  private confirmModal: ConfirmModalState = { kind: 'closed' };
  private uiLanguage: LanguageCode = this.getInitialUiLanguage();

  private backendWorkspace: string = '';
  private backendVersion: string = '';

  private selectedProviderKey: string | null = null;
  private selectedModelKey: string | null = null;
  private envInputs: Record<string, string> = {};

  private workspaceLlmDraft: WorkspaceLlmDraft = { raw: '' };
  private workspaceLlmDraftTouched: boolean = false;
  private prominentParamSelections: Record<string, string> = {};
  private prominentParamTouched: Record<string, true> = {};

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.initializeAuth();
    this.render();
    void this.loadWorkspaceInfo();
    void this.loadStatus();
  }

  private getDefaultWorkspaceLlmYamlDraft(t: UiStrings): string {
    return t.setupWorkspaceLlmTextareaPlaceholder;
  }

  private async loadWorkspaceInfo(): Promise<void> {
    try {
      const resp = await this.apiClient.getHealth();
      if (!resp.success) {
        if (resp.status === 401) {
          this.authState =
            this.authState.kind === 'active'
              ? { kind: 'prompt', reason: 'rejected' }
              : { kind: 'prompt', reason: 'missing' };
          this.setAuthNone();
          this.state = { kind: 'auth_required' };
          this.backendWorkspace = '';
          this.render();
          return;
        }
        throw new Error(resp.error || 'Failed to load workspace info');
      }

      const data = resp.data;
      this.backendWorkspace = data && typeof data.workspace === 'string' ? data.workspace : '';

      this.backendVersion = data && typeof data.version === 'string' ? data.version : '';
      this.render();
    } catch (error: unknown) {
      console.error('Failed to load workspace info:', error);
      this.backendWorkspace = '';
      this.backendVersion = '';
      this.render();
    }
  }

  private getStoredUiLanguage(): LanguageCode | null {
    try {
      const stored = localStorage.getItem('dominds-ui-language');
      if (!stored) return null;
      return normalizeLanguageCode(stored);
    } catch (error) {
      console.warn('Failed to read ui language from localStorage', error);
      return null;
    }
  }

  private getBrowserPreferredUiLanguage(): LanguageCode {
    const raw = typeof navigator.language === 'string' ? navigator.language : '';
    const parsed = normalizeLanguageCode(raw);
    return parsed ?? 'en';
  }

  private getInitialUiLanguage(): LanguageCode {
    const stored = this.getStoredUiLanguage();
    if (stored) return stored;
    return this.getBrowserPreferredUiLanguage();
  }

  private persistUiLanguage(uiLanguage: LanguageCode): void {
    try {
      localStorage.setItem('dominds-ui-language', uiLanguage);
    } catch (error) {
      console.warn('Failed to persist ui language preference', error);
    }
  }

  private initializeAuth(): void {
    const urlKey = readAuthKeyFromUrl();
    if (urlKey) {
      this.setAuthActive('url', urlKey);
      // URL auth must not persist.
      removeAuthKeyFromUrl();
      return;
    }
    const localKey = readAuthKeyFromLocalStorage();
    if (localKey) {
      this.setAuthActive('localStorage', localKey);
      return;
    }
    this.setAuthNone();
  }

  private setAuthActive(source: 'url' | 'localStorage' | 'manual', key: string): void {
    this.authState = { kind: 'active', source, key };
    this.apiClient.setAuthToken(key);
  }

  private setAuthNone(): void {
    this.authState = { kind: 'none' };
    this.apiClient.clearAuthToken();
  }

  private async loadStatus(): Promise<void> {
    this.state = { kind: 'loading' };
    this.render();

    const resp = await this.apiClient.getSetupStatus();
    if (!resp.success) {
      if (resp.status === 401) {
        this.authState =
          this.authState.kind === 'active'
            ? { kind: 'prompt', reason: 'rejected' }
            : { kind: 'prompt', reason: 'missing' };
        this.setAuthNone();
        this.state = { kind: 'auth_required' };
        this.render();
        return;
      }
      this.state = { kind: 'error', message: resp.error || 'Failed to load setup status' };
      this.render();
      return;
    }

    const status = resp.data;
    if (!status) {
      this.state = { kind: 'error', message: 'Missing setup status payload' };
      this.render();
      return;
    }

    this.state = { kind: 'ready', status };
    this.initializeSelections(status);

    const t = getUiStrings(this.uiLanguage);
    if (!this.workspaceLlmDraftTouched) {
      if (status.workspaceLlmYaml.exists) {
        const llm = await this.apiClient.getSetupWorkspaceLlmYaml();
        if (llm.success && llm.data && llm.data.success) {
          this.workspaceLlmDraft = { raw: llm.data.raw };
        }
      } else if (!this.workspaceLlmDraft.raw) {
        this.workspaceLlmDraft = { raw: this.getDefaultWorkspaceLlmYamlDraft(t) };
      }
    }
    this.render();
  }

  private async writeWorkspaceLlmYamlFromUi(): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const status = this.state.status;
    const raw = this.workspaceLlmDraft.raw;
    const t = getUiStrings(this.uiLanguage);
    if (!raw.trim()) {
      alert(t.setupWorkspaceLlmContentRequired);
      return;
    }

    const overwrite = status.workspaceLlmYaml.exists;
    if (overwrite) {
      const path = status.workspaceLlmYaml.path;
      this.confirmModal = {
        kind: 'confirm_overwrite',
        path,
        title: t.setupOverwriteConfirmTitle,
        message: t.setupOverwriteConfirmBody.replace('{path}', path),
        confirmLabel: t.setupOverwriteConfirmConfirm,
        cancelLabel: t.setupOverwriteConfirmCancel,
        onConfirm: { kind: 'write_workspace_llm_yaml' },
      };
      this.render();
      return;
    }

    const resp = await this.apiClient.writeWorkspaceLlmYaml({ raw, overwrite });
    if (!resp.success) {
      if (resp.status === 409) {
        alert(resp.error || '.minds/llm.yaml already exists');
        return;
      }
      alert(resp.error || t.setupWorkspaceLlmWriteFailed);
      return;
    }

    if (resp.data && resp.data.success) {
      alert(`${t.setupWorkspaceLlmWriteSuccessPrefix}${resp.data.path}`);
    }

    await this.loadStatus();
  }

  private async writeWorkspaceLlmYamlFromUiConfirmed(): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const status = this.state.status;
    const raw = this.workspaceLlmDraft.raw;
    const t = getUiStrings(this.uiLanguage);
    const overwrite = status.workspaceLlmYaml.exists;
    const resp = await this.apiClient.writeWorkspaceLlmYaml({ raw, overwrite });
    if (!resp.success) {
      if (resp.status === 409) {
        alert(resp.error || '.minds/llm.yaml already exists');
        return;
      }
      alert(resp.error || t.setupWorkspaceLlmWriteFailed);
      return;
    }

    if (resp.data && resp.data.success) {
      alert(`${t.setupWorkspaceLlmWriteSuccessPrefix}${resp.data.path}`);
    }

    await this.loadStatus();
  }

  private initializeSelections(status: SetupStatusResponse): void {
    if (this.selectedProviderKey && this.selectedModelKey) {
      this.applyDefaultProminentSelections(status, this.selectedProviderKey);
      return;
    }

    const teamProvider =
      status.teamYaml.memberDefaults && typeof status.teamYaml.memberDefaults.provider === 'string'
        ? status.teamYaml.memberDefaults.provider
        : null;
    const teamModel =
      status.teamYaml.memberDefaults && typeof status.teamYaml.memberDefaults.model === 'string'
        ? status.teamYaml.memberDefaults.model
        : null;

    const configuredProviders = status.providers.filter((p) => p.envVar.isSet);
    const preferredProviderKey =
      (teamProvider && configuredProviders.some((p) => p.providerKey === teamProvider)
        ? teamProvider
        : null) ?? pickFirstProviderKey(configuredProviders);
    const provider = preferredProviderKey
      ? status.providers.find((p) => p.providerKey === preferredProviderKey)
      : undefined;

    const providerKey = provider ? provider.providerKey : null;
    const modelKeyFromTeam =
      provider && teamModel ? provider.models.find((m) => m.key === teamModel)?.key : undefined;
    const modelKey = modelKeyFromTeam ?? provider?.models[0]?.key ?? null;

    this.selectedProviderKey = providerKey ?? null;
    this.selectedModelKey = modelKey ?? null;
    if (this.selectedProviderKey) {
      this.applyDefaultProminentSelections(status, this.selectedProviderKey);
    }
  }

  private applyDefaultProminentSelections(status: SetupStatusResponse, providerKey: string): void {
    const provider = status.providers.find((p) => p.providerKey === providerKey);
    const prominent = provider?.prominentModelParams ?? [];
    for (const p of prominent) {
      const k = `${providerKey}/${p.namespace}/${p.key}`;
      if (this.prominentParamTouched[k] === true) continue;
      const def = p.defaultValue;
      if (typeof def === 'string' && def !== '' && p.values.includes(def)) {
        this.prominentParamSelections[k] = def;
        continue;
      }
      const first = p.values[0];
      if (typeof first === 'string' && first !== '') {
        this.prominentParamSelections[k] = first;
      }
    }
  }

  private async handleSubmitAuth(key: string): Promise<void> {
    if (!key) return;
    this.setAuthActive('manual', key);

    const probe = await this.apiClient.getSetupStatus();
    if (!probe.success) {
      this.setAuthNone();
      this.authState = { kind: 'prompt', reason: 'rejected' };
      this.state = { kind: 'auth_required' };
      this.render();
      return;
    }

    writeAuthKeyToLocalStorage(key);
    await this.loadStatus();
  }

  private get requirement(): SetupRequirement | null {
    if (this.state.kind !== 'ready') return null;
    return this.state.status.requirement;
  }

  private get isSetupOk(): boolean {
    const r = this.requirement;
    return !!r && r.kind === 'ok';
  }

  private render(): void {
    if (!this.shadowRoot) return;
    const t = getUiStrings(this.uiLanguage);

    this.shadowRoot.innerHTML = `
      <style>${this.styles()}</style>
      <div class="page">
        <header class="header">
          <a class="logo" href="https://github.com/longrun-ai/dominds" target="_blank" rel="noopener noreferrer" title="${escapeHtmlAttr(
            t.logoGitHubTitle,
          )}" aria-label="${escapeHtmlAttr(t.logoGitHubTitle)}">
            <img src="${faviconUrl}" width="20" height="20" alt="Dominds Logo" />
            <span class="logo-text">
              <span>Dominds</span>
              <span class="dominds-version ${this.backendVersion ? '' : 'hidden'}">${escapeHtml(
                this.backendVersion ? `v${this.backendVersion}` : '',
              )}</span>
            </span>
            </a>
          <span class="setup-badge">${escapeHtml(t.setupTitle)}</span>
          <div class="workspace-indicator" title="${escapeHtmlAttr(t.backendWorkspaceTitle)}">
            📁 ${escapeHtml(this.backendWorkspace || t.backendWorkspaceLoading)}
          </div>
          <div class="spacer"></div>
          <select id="setup-lang-select" class="select select-compact" title="${escapeHtmlAttr(
            t.uiLanguageSelectTitle,
          )}">
            ${supportedLanguageCodes
              .map((code) => {
                const sel = code === this.uiLanguage ? 'selected' : '';
                const label = formatLanguageName(code, this.uiLanguage);
                return `<option value="${escapeHtmlAttr(code)}" ${sel}>${escapeHtml(label)}</option>`;
              })
              .join('')}
          </select>
          <button class="btn" id="refresh-btn">${escapeHtml(t.setupRefresh)}</button>
          <button class="btn primary" id="go-btn" ${this.isSetupOk ? '' : 'disabled'}>${escapeHtml(
            t.setupGoToApp,
          )}</button>
        </header>
        <main class="body">${this.renderBody()}</main>
      </div>
      ${this.renderFileModal()}
      ${this.renderConfirmModal()}
    `;

    const refresh = this.shadowRoot.querySelector('#refresh-btn');
    if (refresh instanceof HTMLButtonElement) {
      refresh.onclick = () => void Promise.all([this.loadStatus(), this.loadWorkspaceInfo()]);
    }

    const goBtn = this.shadowRoot.querySelector('#go-btn');
    if (goBtn instanceof HTMLButtonElement) {
      goBtn.onclick = () => {
        if (!this.isSetupOk) return;
        window.location.href = this.getAppUrl();
      };
    }

    const langSelect = this.shadowRoot.querySelector('#setup-lang-select');
    if (langSelect instanceof HTMLSelectElement) {
      langSelect.onchange = () => {
        const parsed = normalizeLanguageCode(langSelect.value);
        if (!parsed) return;
        this.uiLanguage = parsed;
        this.persistUiLanguage(parsed);
        this.render();
      };
    }

    this.wireBodyHandlers();
  }

  private renderConfirmModal(): string {
    if (this.confirmModal.kind === 'closed') return '';
    const m = this.confirmModal;
    return `
      <div class="modal">
        <div class="modal-backdrop" id="confirm-modal-backdrop"></div>
        <div class="modal-content" role="dialog" aria-modal="true">
          <div class="modal-header">
            <div class="modal-title">${escapeHtml(m.title)}</div>
            <div class="spacer"></div>
            <button class="btn" id="confirm-modal-cancel">${escapeHtml(m.cancelLabel)}</button>
            <button class="btn preferred" id="confirm-modal-confirm">${escapeHtml(
              m.confirmLabel,
            )}</button>
          </div>
          <div class="modal-body"><div class="error">${escapeHtml(m.message)}</div></div>
        </div>
      </div>
    `;
  }

  private wireBodyHandlers(): void {
    if (!this.shadowRoot) return;

    const authSubmit = this.shadowRoot.querySelector('#auth-submit');
    if (authSubmit instanceof HTMLButtonElement) {
      authSubmit.onclick = () => {
        const input = this.shadowRoot?.querySelector('#auth-key') as HTMLInputElement | null;
        const key = input ? input.value : '';
        void this.handleSubmitAuth(key);
      };
    }

    const providerSel = this.shadowRoot.querySelector('#provider-select');
    if (providerSel instanceof HTMLSelectElement) {
      providerSel.onchange = () => {
        const next = providerSel.value;
        this.selectedProviderKey = next;
        const status = this.state.kind === 'ready' ? this.state.status : null;
        if (status) {
          const provider = status.providers.find((p) => p.providerKey === next);
          this.selectedModelKey = provider?.models[0]?.key ?? null;
          this.applyDefaultProminentSelections(status, next);
        }
        this.render();
      };
    }

    const modelSel = this.shadowRoot.querySelector('#model-select');
    if (modelSel instanceof HTMLSelectElement) {
      modelSel.onchange = () => {
        this.selectedModelKey = modelSel.value;
        this.render();
      };
    }

    const prominentParams = this.shadowRoot.querySelectorAll<HTMLSelectElement>(
      '[data-prominent-param="true"]',
    );
    prominentParams.forEach((sel) => {
      sel.onchange = () => {
        const providerKey = sel.getAttribute('data-prominent-provider');
        const ns = sel.getAttribute('data-prominent-namespace');
        const key = sel.getAttribute('data-prominent-key');
        if (typeof providerKey !== 'string' || providerKey === '') return;
        if (typeof ns !== 'string' || ns === '') return;
        if (typeof key !== 'string' || key === '') return;
        const compoundKey = `${providerKey}/${ns}/${key}`;
        this.prominentParamTouched[compoundKey] = true;
        this.prominentParamSelections[compoundKey] = sel.value;
        this.render();
      };
    });

    const copyBtn = this.shadowRoot.querySelector('#copy-team-snippet');
    if (copyBtn instanceof HTMLButtonElement) {
      copyBtn.onclick = () => void this.writeTeamYamlFromUi();
    }

    const viewBuiltinBtn = this.shadowRoot.querySelector('#view-builtin-example');
    if (viewBuiltinBtn instanceof HTMLButtonElement) {
      viewBuiltinBtn.onclick = () => void this.openFileModal('defaults_yaml');
    }

    const viewWorkspaceBtn = this.shadowRoot.querySelector('#view-workspace-llm-yaml');
    if (viewWorkspaceBtn instanceof HTMLButtonElement) {
      viewWorkspaceBtn.onclick = () => void this.openFileModal('workspace_llm_yaml');
    }

    const writeWorkspaceBtn = this.shadowRoot.querySelector('#write-workspace-llm-yaml');
    if (writeWorkspaceBtn instanceof HTMLButtonElement) {
      writeWorkspaceBtn.onclick = () => void this.writeWorkspaceLlmYamlFromUi();
    }

    const confirmCancel = this.shadowRoot.querySelector('#confirm-modal-cancel');
    if (confirmCancel instanceof HTMLButtonElement) {
      confirmCancel.onclick = () => {
        this.confirmModal = { kind: 'closed' };
        this.render();
      };
    }

    const confirmBackdrop = this.shadowRoot.querySelector('#confirm-modal-backdrop');
    if (confirmBackdrop instanceof HTMLDivElement) {
      confirmBackdrop.onclick = () => {
        this.confirmModal = { kind: 'closed' };
        this.render();
      };
    }

    const confirmBtn = this.shadowRoot.querySelector('#confirm-modal-confirm');
    if (confirmBtn instanceof HTMLButtonElement) {
      confirmBtn.onclick = () => {
        const modal = this.confirmModal;
        this.confirmModal = { kind: 'closed' };
        this.render();
        if (modal.kind !== 'confirm_overwrite') return;
        if (modal.onConfirm.kind === 'write_team_yaml') {
          void this.writeTeamYamlFromUiConfirmed();
        } else if (modal.onConfirm.kind === 'write_workspace_llm_yaml') {
          void this.writeWorkspaceLlmYamlFromUiConfirmed();
        } else {
          const _exhaustive: never = modal.onConfirm;
          console.warn('Unhandled confirm action', _exhaustive);
        }
      };
    }

    const envInputs = this.shadowRoot.querySelectorAll<HTMLInputElement>('[data-env-input]');
    envInputs.forEach((input) => {
      input.oninput = () => {
        const envVar = input.getAttribute('data-env-input');
        if (typeof envVar !== 'string') return;
        this.envInputs[envVar] = input.value;
      };
    });

    const workspaceTextarea = this.shadowRoot.querySelector('#workspace-llm-textarea');
    if (workspaceTextarea instanceof HTMLTextAreaElement) {
      workspaceTextarea.oninput = () => {
        this.workspaceLlmDraftTouched = true;
        this.workspaceLlmDraft = { raw: workspaceTextarea.value };
      };
    }

    const writeButtons = this.shadowRoot.querySelectorAll<HTMLButtonElement>('[data-write-env]');
    writeButtons.forEach((btn) => {
      btn.onclick = () => void this.handleWriteEnv(btn);
    });

    const closeFileModal = this.shadowRoot.querySelector('#file-modal-close');
    if (closeFileModal instanceof HTMLButtonElement) {
      closeFileModal.onclick = () => {
        this.fileModal = { kind: 'closed' };
        this.render();
      };
    }

    const fileBackdrop = this.shadowRoot.querySelector('#file-modal-backdrop');
    if (fileBackdrop instanceof HTMLDivElement) {
      fileBackdrop.onclick = () => {
        this.fileModal = { kind: 'closed' };
        this.render();
      };
    }

    const copyFileBtn = this.shadowRoot.querySelector('#file-modal-copy');
    if (copyFileBtn instanceof HTMLButtonElement) {
      copyFileBtn.onclick = () => void this.copyFileModalRaw();
    }

    this.renderFileModalCodeBlock();
  }

  private async handleWriteEnv(btn: HTMLButtonElement): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const envVar = btn.getAttribute('data-env-var');
    const target = btn.getAttribute('data-target');
    if (typeof envVar !== 'string' || (target !== 'bashrc' && target !== 'zshrc')) return;

    const value = this.envInputs[envVar] ?? '';
    if (!value) {
      alert(`Missing value for ${envVar}`);
      return;
    }

    const resp = await this.apiClient.writeShellEnv({ envVar, value, targets: [target] });
    if (!resp.success) {
      alert(resp.error || 'Failed to write shell env');
      return;
    }

    await this.loadStatus();
  }

  private renderFileModalCodeBlock(): void {
    if (!this.shadowRoot) return;
    if (this.fileModal.kind !== 'ready') return;

    const textarea = this.shadowRoot.querySelector('#file-modal-textarea');
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.value = this.fileModal.response.raw;
    }

    const container = this.shadowRoot.querySelector('#file-modal-code');
    if (!(container instanceof HTMLDivElement)) return;
    container.innerHTML = '';

    type CodeBlockEl = HTMLElement & { code: string };
    const el = document.createElement('dominds-code-block') as CodeBlockEl;
    el.setAttribute('language', 'yaml');
    el.code = this.fileModal.response.raw;
    container.appendChild(el);
  }

  private async openFileModal(kind: SetupFileKind): Promise<void> {
    this.fileModal = { kind: 'loading', fileKind: kind };
    this.render();

    const resp =
      kind === 'defaults_yaml'
        ? await this.apiClient.getSetupDefaultsYaml()
        : await this.apiClient.getSetupWorkspaceLlmYaml();

    if (!resp.success) {
      if (resp.status === 401) {
        this.authState =
          this.authState.kind === 'active'
            ? { kind: 'prompt', reason: 'rejected' }
            : { kind: 'prompt', reason: 'missing' };
        this.setAuthNone();
        this.state = { kind: 'auth_required' };
        this.fileModal = { kind: 'closed' };
        this.render();
        return;
      }
      this.fileModal = {
        kind: 'error',
        fileKind: kind,
        path: kind === 'defaults_yaml' ? 'defaults.yaml' : '.minds/llm.yaml',
        message: resp.error || 'Failed to load file',
      };
      this.render();
      return;
    }

    const payload = resp.data;
    if (!payload) {
      this.fileModal = {
        kind: 'error',
        fileKind: kind,
        path: kind === 'defaults_yaml' ? 'defaults.yaml' : '.minds/llm.yaml',
        message: 'Missing response payload',
      };
      this.render();
      return;
    }

    if (!payload.success) {
      this.fileModal = {
        kind: 'error',
        fileKind: kind,
        path: payload.path,
        message: payload.error,
      };
      this.render();
      return;
    }

    this.fileModal = { kind: 'ready', fileKind: kind, response: payload };
    this.render();
    // Ensure modal content is populated even if event wiring order changes.
    queueMicrotask(() => this.renderFileModalCodeBlock());
  }

  private async copyFileModalRaw(): Promise<void> {
    if (this.fileModal.kind !== 'ready') return;
    const raw = this.fileModal.response.raw;
    try {
      await navigator.clipboard.writeText(raw);
    } catch {
      window.prompt('Copy the content below:', raw);
    }
  }

  private buildTeamYamlSnippet(): string {
    const provider = this.selectedProviderKey ?? '<providerKey>';
    const model = this.selectedModelKey ?? '<modelKey>';
    const lines = ['member_defaults:', `  provider: ${provider}`, `  model: ${model}`];

    const status = this.state.kind === 'ready' ? this.state.status : null;
    const selectedProviderKey = this.selectedProviderKey;
    if (status && typeof selectedProviderKey === 'string' && selectedProviderKey !== '') {
      const providerSummary = status.providers.find((p) => p.providerKey === selectedProviderKey);
      const prominent = providerSummary?.prominentModelParams ?? [];
      const selected = this.collectSelectedProminentParams(selectedProviderKey, prominent);
      const namespacesInOrder = Object.keys(selected);
      if (namespacesInOrder.length > 0) {
        lines.push('  model_params:');
        for (const ns of namespacesInOrder) {
          const entries = selected[ns];
          if (!entries || Object.keys(entries).length === 0) continue;
          lines.push(`    ${ns}:`);
          for (const [k, v] of Object.entries(entries)) {
            lines.push(`      ${k}: ${v}`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  private collectSelectedProminentParams(
    providerKey: string,
    prominent: SetupProminentEnumModelParam[],
  ): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const p of prominent) {
      const val = this.prominentParamSelections[`${providerKey}/${p.namespace}/${p.key}`];
      if (typeof val !== 'string' || val === '') continue;
      if (!p.values.includes(val)) continue;
      const bucket = out[p.namespace] ?? {};
      bucket[p.key] = val;
      out[p.namespace] = bucket;
    }
    return out;
  }

  private canWriteTeamYaml(status: SetupStatusResponse): boolean {
    const providerKey = this.selectedProviderKey;
    const modelKey = this.selectedModelKey;
    if (!providerKey || !modelKey) return false;
    const providerSummary = status.providers.find((p) => p.providerKey === providerKey);
    if (!providerSummary) return false;
    const prominent = providerSummary.prominentModelParams ?? [];
    for (const p of prominent) {
      const val = this.prominentParamSelections[`${providerKey}/${p.namespace}/${p.key}`];
      if (typeof val !== 'string' || val === '') return false;
      if (!p.values.includes(val)) return false;
    }
    return true;
  }

  private async writeTeamYamlFromUi(): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const status = this.state.status;
    const provider = this.selectedProviderKey;
    const model = this.selectedModelKey;
    if (!provider || !model) {
      alert(getUiStrings(this.uiLanguage).setupSelectProviderModelFirst);
      return;
    }

    if (!this.canWriteTeamYaml(status)) {
      alert(getUiStrings(this.uiLanguage).setupSelectProminentModelParamsFirst);
      return;
    }

    const providerSummary = status.providers.find((p) => p.providerKey === provider);
    const prominent = providerSummary?.prominentModelParams ?? [];
    const selectedProminent = this.collectSelectedProminentParams(provider, prominent);
    const modelParams = Object.keys(selectedProminent).length > 0 ? selectedProminent : undefined;

    const overwrite = this.state.status.teamYaml.exists;
    if (overwrite) {
      const path = this.state.status.teamYaml.path;
      const t = getUiStrings(this.uiLanguage);
      this.confirmModal = {
        kind: 'confirm_overwrite',
        path,
        title: t.setupOverwriteConfirmTitle,
        message: t.setupOverwriteConfirmBody.replace('{path}', path),
        confirmLabel: t.setupOverwriteConfirmConfirm,
        cancelLabel: t.setupOverwriteConfirmCancel,
        onConfirm: { kind: 'write_team_yaml' },
      };
      this.render();
      return;
    }

    const resp = await this.apiClient.writeTeamYaml({ provider, model, overwrite, modelParams });
    if (!resp.success) {
      if (resp.status === 409) {
        alert(resp.error || 'team.yaml already exists');
        return;
      }
      alert(resp.error || 'Failed to write .minds/team.yaml');
      return;
    }

    await this.loadStatus();
  }

  private async writeTeamYamlFromUiConfirmed(): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const status = this.state.status;
    const provider = this.selectedProviderKey;
    const model = this.selectedModelKey;
    const t = getUiStrings(this.uiLanguage);
    if (!provider || !model) {
      alert(t.setupSelectProviderModelFirst);
      return;
    }

    if (!this.canWriteTeamYaml(status)) {
      alert(t.setupSelectProminentModelParamsFirst);
      return;
    }

    const providerSummary = status.providers.find((p) => p.providerKey === provider);
    const prominent = providerSummary?.prominentModelParams ?? [];
    const selectedProminent = this.collectSelectedProminentParams(provider, prominent);
    const modelParams = Object.keys(selectedProminent).length > 0 ? selectedProminent : undefined;

    const overwrite = status.teamYaml.exists;
    const resp = await this.apiClient.writeTeamYaml({ provider, model, overwrite, modelParams });
    if (!resp.success) {
      if (resp.status === 409) {
        alert(resp.error || 'team.yaml already exists');
        return;
      }
      alert(resp.error || 'Failed to write .minds/team.yaml');
      return;
    }

    await this.loadStatus();
  }

  private getAppUrl(): string {
    if (this.authState.kind === 'active' && this.authState.source === 'url') {
      return `/?auth=${encodeURIComponent(this.authState.key)}`;
    }
    return '/';
  }

  private renderBody(): string {
    const t = getUiStrings(this.uiLanguage);
    if (this.state.kind === 'loading') {
      return `<div class="card"><div class="muted">${escapeHtml(t.setupLoadingStatus)}</div></div>`;
    }
    if (this.state.kind === 'auth_required') {
      const reason =
        this.authState.kind === 'prompt' && this.authState.reason === 'rejected'
          ? t.setupAuthRejected
          : t.setupAuthRequired;
      return `
        <div class="card">
          <div class="section-title">${escapeHtml(t.setupAuthenticationTitle)}</div>
          <div class="muted">${escapeHtml(reason)}</div>
          <div class="row">
            <input id="auth-key" class="input" type="password" placeholder="${escapeHtmlAttr(
              t.authKeyPlaceholder,
            )}" autocomplete="off" />
            <button id="auth-submit" class="btn primary">${escapeHtml(t.connect)}</button>
          </div>
        </div>
      `;
    }
    if (this.state.kind === 'error') {
      return `<div class="card"><div class="error">${escapeHtml(this.state.message)}</div></div>`;
    }

    const status = this.state.status;
    return `
      ${this.renderSummary(status)}
      ${this.renderTeamSection(status)}
      ${this.renderProvidersSection(status)}
    `;
  }

  private renderSummary(status: SetupStatusResponse): string {
    const t = getUiStrings(this.uiLanguage);
    const req = status.requirement;
    const badgeClass = req.kind === 'ok' ? 'ok' : 'warn';
    const badgeText = req.kind === 'ok' ? t.setupSummaryReady : t.setupSummaryRequired;
    const detail = escapeHtml(formatSetupRequirementDetail(this.uiLanguage, t, req));

    const shell = status.shell.kind === 'other' ? 'unknown' : status.shell.kind;
    const defaultRc =
      status.shell.defaultRc === 'bashrc'
        ? '~/.bashrc'
        : status.shell.defaultRc === 'zshrc'
          ? '~/.zshrc'
          : '(unknown)';

    return `
      <div class="card">
        <div class="row">
          <div class="badge ${badgeClass}">${badgeText}</div>
          <div class="muted">${detail}</div>
          <div class="spacer"></div>
          <div class="muted">${escapeHtml(t.setupSummaryShell)}: ${escapeHtml(
            shell,
          )} • ${escapeHtml(t.setupSummaryDefaultRc)}: ${escapeHtml(defaultRc)}</div>
        </div>
      </div>
    `;
  }

  private renderTeamSection(status: SetupStatusResponse): string {
    const t = getUiStrings(this.uiLanguage);
    const teamPath = status.teamYaml.path;
    const exists = status.teamYaml.exists;
    const parseError = status.teamYaml.parseError;
    const snippet = escapeHtml(this.buildTeamYamlSnippet());
    const writeTeamLabel = exists ? t.setupWriteTeamYamlOverwrite : t.setupWriteTeamYamlCreate;
    const canWrite = this.canWriteTeamYaml(status);
    const writeDisabled = canWrite ? '' : 'disabled';
    const prominentForm = this.renderProminentModelParamsForm(status);
    const writeButtonClass = exists ? 'btn preferred' : 'btn';

    const configuredProviders = status.providers.filter((p) => p.envVar.isSet);
    const providerSelectOptions =
      configuredProviders.length > 0
        ? configuredProviders
            .map((p) => {
              const sel = this.selectedProviderKey === p.providerKey ? 'selected' : '';
              return `<option value="${escapeHtmlAttr(p.providerKey)}" ${sel}>${escapeHtml(
                p.providerKey,
              )} — ${escapeHtml(p.name)}</option>`;
            })
            .join('')
        : `<option value="" selected disabled>(no configured providers)</option>`;

    return `
      <div class="card">
        <div class="section-title">${escapeHtml(t.setupTeamTitle)}</div>
        ${parseError ? `<div class="error">${escapeHtml(parseError)}</div>` : ''}

        <div class="subcard" style="margin-top:12px;">
          <div class="subcard-title">${escapeHtml(t.setupMemberDefaultsTitle)}</div>
          <div class="fields" style="margin-top:8px;">
            <div class="field">
              <div class="field-title">${escapeHtml(t.teamMembersProviderLabel)}</div>
              <select id="provider-select" class="select">${providerSelectOptions}</select>
            </div>
            <div class="field">
              <div class="field-title">${escapeHtml(t.teamMembersModelLabel)}</div>
              <select id="model-select" class="select">${this.renderModelOptions(status)}</select>
            </div>
          </div>
          ${prominentForm}
        </div>

        <pre class="code" style="margin-top:12px;">${snippet}</pre>

        <div class="row" style="margin-top:10px;">
          <div class="muted">${this.renderTeamAfterWriteHint(teamPath, t)}</div>
          <div class="spacer"></div>
          <button id="copy-team-snippet" class="${writeButtonClass}" ${writeDisabled}>${escapeHtml(
            writeTeamLabel,
          )}</button>
        </div>
      </div>
    `;
  }

  private renderTeamAfterWriteHint(teamPath: string, t: UiStrings): string {
    const filePill = `<span class="pill"><code>${escapeHtml(teamPath)}</code></span>`;
    const refreshPill = `<span class="pill">${escapeHtml(t.setupRefresh)}</span>`;
    const goToAppPill = `<span class="pill">${escapeHtml(t.setupGoToApp)}</span>`;

    if (this.uiLanguage === 'zh') {
      return `写入/更新 ${filePill} 后点 ${refreshPill}；当配置有效时，${goToAppPill} 按钮会启用。`;
    }

    return `After writing/updating ${filePill}, click ${refreshPill}. When setup is valid, ${goToAppPill} enables.`;
  }

  private formatModelParamNamespaceTitle(
    namespace: SetupProminentEnumModelParam['namespace'],
  ): string {
    const language = this.uiLanguage;
    switch (namespace) {
      case 'general':
        return language === 'zh' ? '通用' : 'General';
      case 'codex':
        return 'Codex';
      case 'openai':
        return 'OpenAI';
      case 'anthropic':
        return 'Anthropic';
      default: {
        const _exhaustive: never = namespace;
        return String(_exhaustive);
      }
    }
  }

  private renderProminentModelParamsForm(status: SetupStatusResponse): string {
    const providerKey = this.selectedProviderKey;
    if (!providerKey) return '';
    const provider = status.providers.find((p) => p.providerKey === providerKey);
    const prominent = provider?.prominentModelParams ?? [];
    if (prominent.length === 0) return '';

    const t = getUiStrings(this.uiLanguage);

    const groups: Record<
      SetupProminentEnumModelParam['namespace'],
      SetupProminentEnumModelParam[]
    > = {
      general: [],
      codex: [],
      openai: [],
      anthropic: [],
    };
    for (const p of prominent) {
      groups[p.namespace].push(p);
    }

    const groupOrder: Array<SetupProminentEnumModelParam['namespace']> = [
      'general',
      'codex',
      'openai',
      'anthropic',
    ];

    const sections = groupOrder
      .map((ns) => {
        const items = groups[ns];
        if (!items || items.length === 0) return '';

        const rows = items
          .map((p) => {
            if (p.values.length === 0) return '';
            const compoundKey = `${providerKey}/${p.namespace}/${p.key}`;
            const stored = this.prominentParamSelections[compoundKey];
            const selected =
              (typeof stored === 'string' && stored !== '' ? stored : undefined) ??
              p.defaultValue ??
              p.values[0] ??
              '';
            const options = p.values
              .map((v) => {
                const sel = selected === v ? 'selected' : '';
                return `<option value="${escapeHtmlAttr(v)}" ${sel}>${escapeHtml(v)}</option>`;
              })
              .join('');

            return `
              <div class="param-row">
                <div class="param-label-wrap">
                  <div class="param-label">${escapeHtml(p.description)}</div>
                  <div class="param-key"><code>${escapeHtml(p.key)}</code></div>
                </div>
                <select
                  class="select select-compact"
                  data-prominent-param="true"
                  data-prominent-provider="${escapeHtmlAttr(providerKey)}"
                  data-prominent-namespace="${escapeHtmlAttr(p.namespace)}"
                  data-prominent-key="${escapeHtmlAttr(p.key)}"
                  title="${escapeHtmlAttr(p.description)}"
                >
                  ${options}
                </select>
              </div>
            `;
          })
          .join('');

        return `
          <div class="subcard nested" style="margin-top:10px;">
            <div class="subcard-title">${escapeHtml(this.formatModelParamNamespaceTitle(ns))}</div>
            ${rows}
          </div>
        `;
      })
      .join('');

    const hint = t.setupTeamModelParamsHint.trim();
    const hintHtml =
      hint === '' ? '' : `<div class="muted" style="margin-top:4px;">${escapeHtml(hint)}</div>`;
    return `
      <div class="subcard" style="margin-top:10px;">
        <div class="subcard-title">${escapeHtml(t.setupModelParamsTitle)}</div>
        ${hintHtml}
        ${sections}
      </div>
    `;
  }

  private renderModelOptions(status: SetupStatusResponse): string {
    const providerKey = this.selectedProviderKey;
    const provider = providerKey
      ? status.providers.find((p) => p.providerKey === providerKey)
      : undefined;
    const models = provider ? provider.models : [];
    return models
      .map((m) => {
        const sel = this.selectedModelKey === m.key ? 'selected' : '';
        const label = m.name ? `${m.key} — ${m.name}` : m.key;
        return `<option value="${escapeHtmlAttr(m.key)}" ${sel}>${escapeHtml(label)}</option>`;
      })
      .join('');
  }

  private renderProvidersSection(status: SetupStatusResponse): string {
    const t = getUiStrings(this.uiLanguage);
    const preferredRc = status.shell.defaultRc;

    const configured = status.providers.filter((p) => p.envVar.isSet);
    const unconfigured = status.providers.filter((p) => !p.envVar.isSet);

    const configuredHtml =
      configured.length > 0
        ? configured.map((p) => this.renderProviderCard(p, preferredRc)).join('')
        : `<div class="muted">(none)</div>`;

    const unconfiguredHtml =
      unconfigured.length > 0
        ? unconfigured.map((p) => this.renderProviderCard(p, preferredRc)).join('')
        : `<div class="muted">(none)</div>`;

    return `
      <div class="card">
        <div class="row">
          <div class="section-title">${escapeHtml(t.setupProvidersTitle)} · ${escapeHtml(
            t.setupProvidersGroupConfigured,
          )}</div>
        </div>
        <div class="muted">${escapeHtml(t.setupProvidersHelp)}</div>
        <div class="providers">${configuredHtml}</div>
      </div>

      ${this.renderWorkspaceLlmYamlSection(status)}

      <div class="card">
        <div class="row">
          <div class="section-title">${escapeHtml(t.setupProvidersTitle)} · ${escapeHtml(
            t.setupProvidersGroupUnconfigured,
          )}</div>
        </div>
        <div class="providers">${unconfiguredHtml}</div>
      </div>
    `;
  }

  private renderProviderCard(p: SetupProviderSummary, preferredRc: string): string {
    const t = getUiStrings(this.uiLanguage);
    const envVar = p.apiKeyEnvVar;
    const inputVal = this.envInputs[envVar] ?? '';
    const setText = p.envVar.isSet ? t.setupProviderEnvVarSet : t.setupProviderEnvVarMissing;
    const providerEnvClass = p.envVar.isSet ? 'env-set' : 'env-missing';
    const bashPreferred = preferredRc === 'bashrc' ? 'preferred' : '';
    const zshPreferred = preferredRc === 'zshrc' ? 'preferred' : '';
    const bashState = p.envVar.bashrcHas ? 'present' : 'absent';
    const zshState = p.envVar.zshrcHas ? 'present' : 'absent';
    const bashVerb = p.envVar.bashrcHas ? t.setupWriteRcOverwrite : t.setupWriteRcWrite;
    const zshVerb = p.envVar.zshrcHas ? t.setupWriteRcOverwrite : t.setupWriteRcWrite;

    const links: string[] = [];
    if (typeof p.apiMgmtUrl === 'string') {
      links.push(
        `<a class="anchor" href="${escapeHtmlAttr(
          p.apiMgmtUrl,
        )}" target="_blank" rel="noreferrer">${escapeHtml(t.setupProviderApiKeys)}</a>`,
      );
    }
    if (typeof p.techSpecUrl === 'string') {
      links.push(
        `<a class="anchor" href="${escapeHtmlAttr(
          p.techSpecUrl,
        )}" target="_blank" rel="noreferrer">${escapeHtml(t.setupProviderDocs)}</a>`,
      );
    }

    const linksHtml =
      links.length > 0
        ? `<div class="anchors">${links.join('<span class="anchor-sep">•</span>')}</div>`
        : '<div class="anchors"></div>';

    return `
      <div class="provider-card ${providerEnvClass}">
        <div class="provider-top">
          <div class="provider-title">${escapeHtml(p.providerKey)}</div>
          ${linksHtml}
          <div class="provider-meta">${escapeHtml(t.setupProviderBaseUrl)}: <code>${escapeHtml(
            p.baseUrl,
          )}</code></div>
        </div>

        <div class="provider-actions">
          <div class="env-pill ${p.envVar.isSet ? 'set' : 'missing'}" title="${escapeHtmlAttr(
            t.setupProviderEnvVar,
          )}">
            <code>${escapeHtml(envVar)}</code>
            <span class="env-state">${p.envVar.isSet ? '✅' : '⚠️'}</span>
          </div>
          <input
            class="input"
            placeholder="Paste value for ${escapeHtmlAttr(envVar)}"
            value="${escapeHtmlAttr(inputVal)}"
            data-env-input="${escapeHtmlAttr(envVar)}"
          />
          <div class="rc-buttons">
            <button class="btn ${bashPreferred}" data-write-env="1" data-env-var="${escapeHtmlAttr(
              envVar,
            )}" data-target="bashrc">${bashVerb} ~/.bashrc</button>
            <button class="btn ${zshPreferred}" data-write-env="1" data-env-var="${escapeHtmlAttr(
              envVar,
            )}" data-target="zshrc">${zshVerb} ~/.zshrc</button>
          </div>
        </div>

        <div class="provider-bottom">
          <div class="models" title="${escapeHtmlAttr(t.setupProviderModelsHint)}">
            ${p.models
              .slice(0, 24)
              .map(
                (m) =>
                  `<span class="chip ${m.verified ? 'ok' : 'warn'}">${escapeHtml(m.key)}</span>`,
              )
              .join('')}
            ${p.models.length > 24 ? `<span class="muted">…</span>` : ''}
          </div>
          <div class="rc-tags">
            <span class="rc-tag ${bashState}">~/.bashrc</span>
            <span class="rc-tag ${zshState}">~/.zshrc</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderWorkspaceLlmYamlSection(status: SetupStatusResponse): string {
    const t = getUiStrings(this.uiLanguage);
    const info = status.workspaceLlmYaml;
    const exists = info.exists;
    const parseError = info.parseError;
    const writeLabel = exists ? t.setupOverwriteWorkspaceLlmYaml : t.setupWriteWorkspaceLlmYaml;
    return `
      <div class="card">
        <div class="row">
          <div class="section-title">${escapeHtml(t.setupWorkspaceLlmTitle)}</div>
          <div class="spacer"></div>
          <button class="btn" id="write-workspace-llm-yaml">${escapeHtml(writeLabel)}</button>
          <button class="btn" id="view-workspace-llm-yaml" ${exists ? '' : 'disabled'}>${escapeHtml(
            t.setupViewWorkspaceLlmYaml,
          )}</button>
          <button class="btn" id="view-builtin-example">${escapeHtml(
            t.setupViewBuiltinProvidersExample,
          )}</button>
        </div>
        <div class="muted">${escapeHtml(t.setupWorkspaceLlmHelp)}</div>
        <textarea id="workspace-llm-textarea" class="file-textarea" spellcheck="false">${escapeHtml(
          this.workspaceLlmDraft.raw,
        )}</textarea>
        ${parseError ? `<div class="error">${escapeHtml(parseError)}</div>` : ''}
      </div>
    `;
  }

  private renderFileModal(): string {
    const t = getUiStrings(this.uiLanguage);
    if (this.fileModal.kind === 'closed') return '';

    const title =
      this.fileModal.fileKind === 'defaults_yaml'
        ? 'defaults.yaml'
        : this.fileModal.fileKind === 'workspace_llm_yaml'
          ? '.minds/llm.yaml'
          : 'file';

    let body = '';
    if (this.fileModal.kind === 'loading') {
      body = `<div class="muted">${escapeHtml(t.setupFileModalLoading)}</div>`;
    } else if (this.fileModal.kind === 'error') {
      body = `<div class="error">${escapeHtml(this.fileModal.message)}</div>`;
    } else if (this.fileModal.kind === 'ready') {
      body = `
        <div class="muted">${escapeHtml(t.setupFileModalSelectToCopy)}</div>
        <div class="file-path muted"><code>${escapeHtml(this.fileModal.response.path)}</code></div>
        <textarea id="file-modal-textarea" class="file-textarea" readonly spellcheck="false"></textarea>
        <div id="file-modal-code"></div>
      `;
    } else {
      const _exhaustive: never = this.fileModal;
      body = escapeHtml(String(_exhaustive));
    }

    const copyDisabled = this.fileModal.kind === 'ready' ? '' : 'disabled';

    return `
      <div class="modal">
        <div class="modal-backdrop" id="file-modal-backdrop"></div>
        <div class="modal-content" role="dialog" aria-modal="true">
          <div class="modal-header">
            <div class="modal-title">${escapeHtml(title)}</div>
            <div class="spacer"></div>
            <button class="btn" id="file-modal-copy" ${copyDisabled}>${escapeHtml(
              t.setupFileModalCopy,
            )}</button>
            <button class="btn" id="file-modal-close">${escapeHtml(t.close)}</button>
          </div>
          <div class="modal-body">${body}</div>
        </div>
      </div>
    `;
  }

  private styles(): string {
    return `
      :host{
        display:block;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        background:var(--dominds-bg,#ffffff);
        color:var(--dominds-fg,#333333);
        color-scheme:inherit;
      }

      *,
      *::before,
      *::after{
        box-sizing:border-box;
      }

      .page{min-height:100vh;background:var(--dominds-bg,#ffffff);display:flex;flex-direction:column;}

      .header{
        display:flex;
        align-items:flex-end;
        justify-content:flex-start;
        gap:16px;
        padding:12px 16px;
        background:var(--dominds-header-bg,var(--dominds-bg,#ffffff));
        border-bottom:1px solid var(--dominds-border,#e0e0e0);
        flex-shrink:0;
      }

      .body{padding:18px;}

      .workspace-indicator{
        font-size:11px;
        color:var(--dominds-muted,#666666);
        font-family:'SF Mono',Monaco,'Cascadia Code','Roboto Mono',Consolas,'Courier New',monospace;
        background:var(--dominds-hover,#f8f9fa);
        padding:5px 8px;
        border-radius:4px;
        border:1px solid var(--dominds-border,#e0e0e0);
        flex:1;
        max-width:50%;
        min-width:0;
        height:calc(1em * 1.4 * 0.85);
        display:flex;
        align-items:center;
        justify-content:flex-start;
        overflow-x:auto;
        overflow-y:hidden;
        white-space:nowrap;
        scrollbar-width:thin;
        scrollbar-color:var(--dominds-muted,#666666) var(--dominds-hover,#f8f9fa);
      }

      .workspace-indicator::-webkit-scrollbar{height:4px;}
      .workspace-indicator::-webkit-scrollbar-track{background:var(--dominds-hover,#f8f9fa);}
      .workspace-indicator::-webkit-scrollbar-thumb{background:var(--dominds-muted,#666666);border-radius:2px;}
      .workspace-indicator::-webkit-scrollbar-thumb:hover{background:var(--dominds-fg,#333333);}

      .hidden{display:none;}

      .logo{display:flex;align-items:flex-end;gap:12px;color:var(--dominds-primary,#007acc);text-decoration:none;font-weight:600;font-size:18px;line-height:1;}
      .logo img{display:block;align-self:flex-end;}

      .logo-text{display:flex;align-items:flex-end;gap:6px;line-height:1;}

      .logo-text > span{display:block;line-height:1;}

      .dominds-version{font-size:0.55em;font-weight:550;color:var(--dominds-muted,#666666);opacity:0.85;line-height:1;}

      .setup-badge{
        font-size:12px;
        font-weight:650;
        padding:4px 10px;
        border-radius:999px;
        border:1px solid color-mix(in srgb, var(--dominds-primary,#007acc) 35%, var(--dominds-border,#e0e0e0));
        background:var(--dominds-primary-bg,color-mix(in srgb, var(--dominds-primary,#007acc) 12%, transparent));
        color:var(--dominds-primary,#007acc);
      }

      .spacer{flex:1;}

      .card{background:var(--dominds-bg-secondary,#ffffff);border:1px solid var(--dominds-border,#e0e0e0);border-radius:12px;padding:14px;margin-bottom:12px;box-shadow:var(--shadow-sm,0 1px 2px 0 rgb(0 0 0 / 0.05));}
      .section-title{font-size:14px;font-weight:650;margin-bottom:8px;color:var(--dominds-fg,#333333);}
      .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
      .muted{color:var(--dominds-muted,#666666);font-size:12.5px;}
      .muted a{color:var(--dominds-primary,#007acc);}
      .muted a:hover{text-decoration:underline;}
      .error{color:var(--dominds-danger,#dc3545);font-size:13px;margin-top:8px;}

      .pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dominds-border-light,#e5e7eb);background:var(--dominds-bg-secondary,#ffffff);color:var(--dominds-fg,#333333);font-size:12px;line-height:1.4;white-space:nowrap;}
      .pill code{background:transparent;border:0;padding:0;border-radius:0;}

      .subcard{background:var(--dominds-bg,#f8f9fa);border:1px solid var(--dominds-border-light,#e5e7eb);border-radius:12px;padding:10px;}
      .subcard.nested{background:var(--dominds-bg-secondary,#ffffff);}
      .subcard-title{font-size:12px;font-weight:700;color:var(--dominds-fg,#333333);}

      .fields{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;}
      .field{display:flex;flex-direction:column;gap:6px;min-width:260px;flex:1;}
      .field-title{font-size:12px;font-weight:650;color:var(--dominds-fg,#333333);}

      .param-row{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:8px;}
      .param-label-wrap{display:flex;flex-direction:column;gap:2px;min-width:260px;flex:1;}
      .param-label{font-size:12.5px;color:var(--dominds-fg,#333333);}
      .param-key{font-size:11px;color:var(--dominds-muted,#666666);}

      .badge{font-size:12px;padding:4px 8px;border-radius:999px;border:1px solid transparent;}
      .badge.ok{background:var(--dominds-success-bg,#d4edda);border-color:var(--dominds-success-border,#c3e6cb);color:var(--dominds-success,#28a745);}
      .badge.warn{background:var(--dominds-warning-bg,#fff3cd);border-color:var(--dominds-warning-border,#ffeaa7);color:var(--dominds-warning,#ffc107);}

      .btn{background:var(--dominds-bg-secondary,#ffffff);color:var(--dominds-fg,#333333);border:1px solid var(--dominds-border,#e0e0e0);border-radius:10px;padding:8px 10px;cursor:pointer;}
      .btn{transition:transform .06s ease,background .12s ease,border-color .12s ease,box-shadow .12s ease;}
      .btn.primary{background:var(--dominds-primary,#007acc);border-color:var(--dominds-primary,#007acc);color:#ffffff;}
      .btn:hover:not(:disabled){background:var(--dominds-hover,#f0f0f0);border-color:color-mix(in srgb, var(--dominds-primary,#007acc) 35%, var(--dominds-border,#e0e0e0));}
      .btn:active:not(:disabled){transform:translateY(1px);}
      .btn.primary:hover:not(:disabled){background:var(--dominds-primary-hover,#005ea6);border-color:var(--dominds-primary-hover,#005ea6);box-shadow:0 0 0 2px color-mix(in srgb, var(--dominds-primary,#007acc) 22%, transparent);}
      .btn:disabled{opacity:.45;cursor:not-allowed;}
      .btn.preferred{outline:2px solid var(--dominds-focus,var(--dominds-primary,#007acc));}

      .input{flex:1;min-width:260px;background:var(--dominds-input-bg,var(--dominds-bg-secondary,#ffffff));color:var(--dominds-fg,#333333);border:1px solid var(--dominds-border,#e0e0e0);border-radius:10px;padding:9px 10px;}
      .select{background:var(--dominds-input-bg,var(--dominds-bg-secondary,#ffffff));color:var(--dominds-fg,#333333);border:1px solid var(--dominds-border,#e0e0e0);border-radius:10px;padding:9px 10px;min-width:240px;}
      .select.select-compact{min-width:160px;padding:8px 10px;}

      code{background:var(--color-bg-tertiary,#f1f5f9);border:1px solid var(--dominds-border-light,#e5e7eb);padding:1px 6px;border-radius:8px;}

      .code{background:var(--color-bg-tertiary,#f1f5f9);border:1px solid var(--dominds-border-light,#e5e7eb);border-radius:12px;padding:12px;overflow:auto;margin-top:10px;color:var(--dominds-fg,#333333);}

      .providers{display:flex;flex-direction:column;gap:10px;margin-top:10px;}
      .provider-card{background:var(--dominds-bg-secondary,#ffffff);border:1px solid var(--dominds-border,#e0e0e0);border-radius:12px;padding:10px;}
      .provider-card.env-set{background:color-mix(in srgb, var(--dominds-success,#28a745) 10%, var(--dominds-bg-secondary,#ffffff));border-color:color-mix(in srgb, var(--dominds-success,#28a745) 35%, var(--dominds-border,#e0e0e0));}
      .provider-card.env-missing{background:color-mix(in srgb, var(--dominds-warning,#ffc107) 10%, var(--dominds-bg-secondary,#ffffff));border-color:color-mix(in srgb, var(--dominds-warning,#ffc107) 35%, var(--dominds-border,#e0e0e0));}

      .provider-top{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;}
      .provider-title{font-weight:700;color:var(--dominds-fg,#333333);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

      .anchors{display:flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;}
      .anchor{color:var(--dominds-primary,#007acc);font-weight:650;text-decoration:none;font-size:13px;}
      .anchor:hover{text-decoration:underline;}
      .anchor-sep{color:var(--dominds-muted,#666666);font-size:12px;}

      .provider-meta{justify-self:end;color:var(--dominds-muted,#666666);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw;}

      .provider-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;}

      .env-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 8px;border-radius:999px;border:1px solid var(--dominds-border-light,#e5e7eb);background:var(--dominds-bg-secondary,#ffffff);font-size:12px;color:var(--dominds-fg,#333333);white-space:nowrap;}
      .env-pill code{background:transparent;border:0;padding:0;border-radius:0;}
      .env-pill.set{border-color:color-mix(in srgb, var(--dominds-success,#28a745) 45%, var(--dominds-border,#e0e0e0));color:var(--dominds-success,#28a745);}
      .env-pill.missing{border-color:var(--dominds-border-light,#e5e7eb);color:var(--dominds-muted,#666666);}
      .env-state{display:inline-flex;align-items:center;justify-content:center;width:1.25em;}

      .provider-actions .input{min-width:220px;padding:6px 8px;font-size:12.5px;}
      .provider-actions .btn{padding:6px 8px;font-size:12px;border-radius:9px;}

      .rc-buttons{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;}

      .provider-bottom{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:8px;}
      .models{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-start;flex:1;min-width:0;}

      .rc-tags{display:flex;gap:6px;align-items:center;justify-content:flex-end;white-space:nowrap;}
      .rc-tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dominds-border-light,#e5e7eb);background:var(--dominds-bg-secondary,#ffffff);color:var(--dominds-muted,#666666);}
      .rc-tag.present{border-color:color-mix(in srgb, var(--dominds-success,#28a745) 45%, var(--dominds-border,#e0e0e0));color:var(--dominds-success,#28a745);}
      .rc-tag.absent{border-color:var(--dominds-border-light,#e5e7eb);color:var(--dominds-muted,#666666);}
      /* Intentionally no extra focus/"preferred" outline on rc tags (avoid double blue rings). */

      .chip{font-size:11px;border-radius:999px;padding:2px 7px;border:1px solid var(--dominds-border-light,#e5e7eb);background:var(--dominds-bg-secondary,#ffffff);}
      .chip.ok{border-color:color-mix(in srgb, var(--dominds-success,#28a745) 45%, var(--dominds-border,#e0e0e0));color:var(--dominds-success,#28a745);}
      .chip.warn{border-color:color-mix(in srgb, var(--dominds-warning,#ffc107) 45%, var(--dominds-border,#e0e0e0));color:var(--dominds-warning,#ffc107);}

      .modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:10000;}
      .modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55);}
      .modal-content{position:relative;max-width:1100px;width:min(1100px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:var(--dominds-bg-secondary,#ffffff);border:1px solid var(--dominds-border,#e0e0e0);border-radius:12px;box-shadow:var(--shadow-lg,0 10px 15px -3px rgb(0 0 0 / 0.1),0 4px 6px -4px rgb(0 0 0 / 0.1));}
      .modal-header{position:sticky;top:0;display:flex;align-items:center;gap:10px;padding:12px 12px;background:var(--dominds-bg-secondary,#ffffff);border-bottom:1px solid var(--dominds-border,#e0e0e0);}
      .modal-title{font-weight:650;color:var(--dominds-fg,#333333);}
      .modal-body{padding:12px;}
      .file-path{margin:8px 0 10px 0;}
      .file-textarea{width:100%;max-width:100%;min-height:220px;max-height:50vh;resize:vertical;background:var(--dominds-input-bg,var(--dominds-bg-secondary,#ffffff));color:var(--dominds-fg,#333333);border:1px solid var(--dominds-border-light,#e5e7eb);border-radius:12px;padding:12px;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,Liberation Mono,monospace;font-size:12.5px;line-height:1.35;}
    `;
  }
}

function pickFirstProviderKey(providers: SetupProviderSummary[]): string | null {
  const withEnv = providers.find((p) => p.envVar.isSet);
  if (withEnv) return withEnv.providerKey;
  return providers.length > 0 ? providers[0].providerKey : null;
}

function formatSetupRequirementDetail(
  language: LanguageCode,
  t: UiStrings,
  req: SetupRequirement,
): string {
  switch (req.kind) {
    case 'ok':
      return t.setupReqOk;
    case 'missing_team_yaml':
      return language === 'zh'
        ? t.setupReqMissingTeamYaml
        : `${t.setupReqMissingTeamYaml} (${req.teamYamlPath})`;
    case 'invalid_team_yaml':
      return `${t.setupReqInvalidTeamYaml}${req.errorText}`;
    case 'missing_member_defaults_fields':
      return `${t.setupReqMissingDefaultsFields}${req.missing.join(', ')}`;
    case 'unknown_provider':
      return `${t.setupReqUnknownProvider}${req.provider}`;
    case 'unknown_model':
      return language === 'zh'
        ? `${t.setupReqUnknownModel}${req.provider}/${req.model}`
        : `${t.setupReqUnknownModel}${req.provider}/${req.model}`;
    case 'missing_provider_env':
      return language === 'zh'
        ? `${t.setupReqMissingProviderEnv}${req.envVar}（提供商=${req.provider}）`
        : `${t.setupReqMissingProviderEnv}${req.envVar} (provider=${req.provider})`;
    default: {
      const _exhaustive: never = req;
      return String(_exhaustive);
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

customElements.define('dominds-setup', DomindsSetup);
