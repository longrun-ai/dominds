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

type FileModalState =
  | { kind: 'closed' }
  | { kind: 'loading'; fileKind: SetupFileKind }
  | {
      kind: 'ready';
      fileKind: SetupFileKind;
      response: Extract<SetupFileResponse, { success: true }>;
    }
  | { kind: 'error'; fileKind: SetupFileKind; path: string; message: string };

export class DomindsSetup extends HTMLElement {
  private apiClient = getApiClient();
  private authState: AuthState = { kind: 'uninitialized' };
  private state: SetupState = { kind: 'loading' };
  private fileModal: FileModalState = { kind: 'closed' };
  private uiLanguage: LanguageCode = this.getInitialUiLanguage();

  private selectedProviderKey: string | null = null;
  private selectedModelKey: string | null = null;
  private envInputs: Record<string, string> = {};

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.initializeAuth();
    this.render();
    void this.loadStatus();
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
    this.render();
  }

  private initializeSelections(status: SetupStatusResponse): void {
    if (this.selectedProviderKey && this.selectedModelKey) return;

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
            <span>Dominds</span>
            </a>
          <span class="setup-badge">${escapeHtml(t.setupTitle)}</span>
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
        ${this.renderBody()}
      </div>
      ${this.renderFileModal()}
    `;

    const refresh = this.shadowRoot.querySelector('#refresh-btn');
    if (refresh instanceof HTMLButtonElement) {
      refresh.onclick = () => void this.loadStatus();
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

    const copyBtn = this.shadowRoot.querySelector('#copy-team-snippet');
    if (copyBtn instanceof HTMLButtonElement) {
      copyBtn.onclick = () => void this.writeTeamYamlFromUi();
    }

    const viewDefaultsBtn = this.shadowRoot.querySelector('#view-defaults-yaml');
    if (viewDefaultsBtn instanceof HTMLButtonElement) {
      viewDefaultsBtn.onclick = () => void this.openFileModal('defaults_yaml');
    }

    const viewWorkspaceBtn = this.shadowRoot.querySelector('#view-workspace-llm-yaml');
    if (viewWorkspaceBtn instanceof HTMLButtonElement) {
      viewWorkspaceBtn.onclick = () => void this.openFileModal('workspace_llm_yaml');
    }

    const envInputs = this.shadowRoot.querySelectorAll<HTMLInputElement>('[data-env-input]');
    envInputs.forEach((input) => {
      input.oninput = () => {
        const envVar = input.getAttribute('data-env-input');
        if (typeof envVar !== 'string') return;
        this.envInputs[envVar] = input.value;
      };
    });

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
    return ['member_defaults:', `  provider: ${provider}`, `  model: ${model}`].join('\n');
  }

  private async writeTeamYamlFromUi(): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const provider = this.selectedProviderKey;
    const model = this.selectedModelKey;
    if (!provider || !model) {
      alert(getUiStrings(this.uiLanguage).setupSelectProviderModelFirst);
      return;
    }

    const overwrite = this.state.status.teamYaml.exists;
    const resp = await this.apiClient.writeTeamYaml({ provider, model, overwrite });
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
      ${this.renderWorkspaceLlmYamlSection(status)}
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
    const md = status.teamYaml.memberDefaults;
    const provider = md && typeof md.provider === 'string' ? md.provider : '';
    const model = md && typeof md.model === 'string' ? md.model : '';
    const snippet = escapeHtml(this.buildTeamYamlSnippet());
    const writeTeamLabel = exists ? t.setupWriteTeamYamlOverwrite : t.setupWriteTeamYamlCreate;

    const requiredHint =
      this.uiLanguage === 'zh'
        ? `必须在 <code>${escapeHtml(teamPath)}</code> 中设置 <code>${escapeHtml(
            t.setupTeamProviderLabel,
          )}</code> 与 <code>${escapeHtml(t.setupTeamModelLabel)}</code>。`
        : `Required: set <code>${escapeHtml(t.setupTeamProviderLabel)}</code> and <code>${escapeHtml(
            t.setupTeamModelLabel,
          )}</code> in <code>${escapeHtml(teamPath)}</code>.`;

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
        <div class="muted">${requiredHint}</div>
        <div class="kv">
          <div class="k">${escapeHtml(t.setupTeamFileLabel)}</div><div class="v">${escapeHtml(teamPath)} ${exists ? '' : '(missing)'}</div>
          <div class="k">${escapeHtml(t.setupTeamProviderLabel)}</div><div class="v">${escapeHtml(provider || '(unset)')}</div>
          <div class="k">${escapeHtml(t.setupTeamModelLabel)}</div><div class="v">${escapeHtml(model || '(unset)')}</div>
        </div>
        ${parseError ? `<div class="error">${escapeHtml(parseError)}</div>` : ''}
        <div class="row" style="margin-top:12px;">
          <label class="muted" style="min-width:120px;">${escapeHtml(t.teamMembersProviderLabel)}</label>
          <select id="provider-select" class="select">
            ${providerSelectOptions}
          </select>
          <label class="muted" style="min-width:80px;">${escapeHtml(t.teamMembersModelLabel)}</label>
          <select id="model-select" class="select">
            ${this.renderModelOptions(status)}
          </select>
          <button id="copy-team-snippet" class="btn">${escapeHtml(writeTeamLabel)}</button>
        </div>
        <pre class="code">${snippet}</pre>
        <div class="muted">${escapeHtml(t.setupTeamAfterWriteHint)}</div>
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
    return `
      <div class="card">
        <div class="row">
          <div class="section-title">${escapeHtml(t.setupProvidersTitle)}</div>
          <div class="spacer"></div>
          <button class="btn" id="view-defaults-yaml">${escapeHtml(t.setupViewDefaultsYaml)}</button>
        </div>
        <div class="muted">${escapeHtml(t.setupProvidersHelp)}</div>
        <div class="providers">
          ${status.providers.map((p) => this.renderProviderCard(p, preferredRc)).join('')}
        </div>
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
        `<a href="${escapeHtmlAttr(p.apiMgmtUrl)}" target="_blank" rel="noreferrer">${escapeHtml(
          t.setupProviderApiKeys,
        )}</a>`,
      );
    }
    if (typeof p.techSpecUrl === 'string') {
      links.push(
        `<a href="${escapeHtmlAttr(p.techSpecUrl)}" target="_blank" rel="noreferrer">${escapeHtml(
          t.setupProviderDocs,
        )}</a>`,
      );
    }

    return `
      <div class="provider-card ${providerEnvClass}">
        <div class="row">
          <div class="provider-title">${escapeHtml(p.providerKey)} <span class="muted">— ${escapeHtml(
            p.name,
          )}</span></div>
          <div class="spacer"></div>
          <div class="muted">${links.join(' • ')}</div>
        </div>
        <div class="muted">${escapeHtml(t.setupProviderBaseUrl)}: <code>${escapeHtml(
          p.baseUrl,
        )}</code></div>
        <div class="kv">
          <div class="k">${escapeHtml(t.setupProviderEnvVar)}</div><div class="v"><code>${escapeHtml(
            envVar,
          )}</code> — ${escapeHtml(setText)}</div>
          <div class="k">~/.bashrc</div><div class="v">${bashState}</div>
          <div class="k">~/.zshrc</div><div class="v">${zshState}</div>
        </div>
        <div class="row" style="margin-top:10px;">
          <input
            class="input"
            placeholder="Paste value for ${escapeHtmlAttr(envVar)}"
            value="${escapeHtmlAttr(inputVal)}"
            data-env-input="${escapeHtmlAttr(envVar)}"
          />
          <button class="btn ${bashPreferred}" data-write-env="1" data-env-var="${escapeHtmlAttr(
            envVar,
          )}" data-target="bashrc">${bashVerb} ~/.bashrc</button>
          <button class="btn ${zshPreferred}" data-write-env="1" data-env-var="${escapeHtmlAttr(
            envVar,
          )}" data-target="zshrc">${zshVerb} ~/.zshrc</button>
        </div>
        <div class="muted" style="margin-top:10px;">${escapeHtml(t.setupProviderModelsHint)}</div>
        <div class="models">
          ${p.models
            .slice(0, 24)
            .map(
              (m) => `<span class="chip ${m.verified ? 'ok' : 'warn'}">${escapeHtml(m.key)}</span>`,
            )
            .join('')}
          ${p.models.length > 24 ? `<span class="muted">…</span>` : ''}
        </div>
      </div>
    `;
  }

  private renderWorkspaceLlmYamlSection(status: SetupStatusResponse): string {
    const t = getUiStrings(this.uiLanguage);
    const info = status.workspaceLlmYaml;
    const exists = info.exists;
    const keys = Array.isArray(info.providerKeys) ? info.providerKeys : [];
    const parseError = info.parseError;
    return `
      <div class="card">
        <div class="row">
          <div class="section-title">Optional: Workspace <code>.minds/llm.yaml</code></div>
          <div class="spacer"></div>
          <button class="btn" id="view-workspace-llm-yaml" ${exists ? '' : 'disabled'}>${escapeHtml(
            t.setupViewWorkspaceLlmYaml,
          )}</button>
        </div>
        <div class="muted">
          This file can override/add providers for this workspace only.
        </div>
        <div class="kv">
          <div class="k">File</div><div class="v">${escapeHtml(info.path)} ${exists ? '' : '(missing)'}</div>
          <div class="k">Providers</div><div class="v">${exists ? escapeHtml(keys.join(', ') || '(none)') : '(n/a)'}</div>
        </div>
        ${parseError ? `<div class="error">${escapeHtml(parseError)}</div>` : ''}
        ${exists ? '' : '<div class="muted">Create it if you need custom endpoints/models per workspace.</div>'}
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
      :host{display:block;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#eaeaea;}
      .page{min-height:100vh;background:#0b0f14;padding:18px;}
      .header{display:flex;align-items:center;gap:10px;margin-bottom:14px;}
      .logo{display:flex;align-items:center;gap:10px;color:#eaeaea;text-decoration:none;font-weight:650;}
      .logo img{display:block;}
      .setup-badge{font-size:12px;font-weight:650;padding:3px 8px;border-radius:999px;border:1px solid #2d3a4e;background:#0e1420;color:#9fb0c6;}
      .spacer{flex:1;}
      .card{background:#121822;border:1px solid #243041;border-radius:12px;padding:14px;margin-bottom:12px;}
      .section-title{font-size:14px;font-weight:650;margin-bottom:8px;}
      .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
      .muted{color:#9fb0c6;font-size:12.5px;}
      .error{color:#ff6b6b;font-size:13px;margin-top:8px;}
      .badge{font-size:12px;padding:4px 8px;border-radius:999px;border:1px solid transparent;}
      .badge.ok{background:#11301e;border-color:#1c6b3d;color:#b9f6ca;}
      .badge.warn{background:#2d2610;border-color:#8b6b12;color:#ffe08a;}
      .btn{background:#1a2230;color:#eaeaea;border:1px solid #2d3a4e;border-radius:10px;padding:8px 10px;cursor:pointer;}
      .btn{transition:transform .06s ease,filter .12s ease,background .12s ease,border-color .12s ease,box-shadow .12s ease;}
      .btn.primary{background:#2b5cff;border-color:#2b5cff;}
      .btn:hover:not(:disabled){filter:brightness(1.08);border-color:#3b4a64;}
      .btn:active:not(:disabled){transform:translateY(1px);filter:brightness(.98);}
      .btn.primary:hover:not(:disabled){filter:brightness(1.08);box-shadow:0 0 0 2px rgba(43,92,255,.22);}
      .btn:disabled{opacity:.45;cursor:not-allowed;}
      .btn.preferred{outline:2px solid #2b5cff;}
      .input{flex:1;min-width:260px;background:#0e1420;color:#eaeaea;border:1px solid #2d3a4e;border-radius:10px;padding:9px 10px;}
      .select{background:#0e1420;color:#eaeaea;border:1px solid #2d3a4e;border-radius:10px;padding:9px 10px;min-width:240px;}
      .select.select-compact{min-width:160px;padding:8px 10px;}
      code{background:#0e1420;border:1px solid #243041;padding:1px 6px;border-radius:8px;}
      .kv{display:grid;grid-template-columns:200px 1fr;gap:6px 10px;margin-top:10px;}
      .k{color:#9fb0c6;font-size:12px;}
      .v{color:#eaeaea;font-size:12.5px;}
      .code{background:#0e1420;border:1px solid #243041;border-radius:12px;padding:12px;overflow:auto;margin-top:10px;}
      .providers{display:flex;flex-direction:column;gap:12px;margin-top:10px;}
      .provider-card{background:#0e1420;border:1px solid #243041;border-radius:12px;padding:12px;}
      .provider-card.env-set{background:rgba(17,48,30,.55);border-color:#1c6b3d;}
      .provider-card.env-missing{background:rgba(45,38,16,.55);border-color:#8b6b12;}
      .provider-title{font-weight:650;}
      .models{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;}
      .chip{font-size:11.5px;border-radius:999px;padding:4px 8px;border:1px solid #243041;background:#121822;}
      .chip.ok{border-color:#1c6b3d;color:#b9f6ca;}
      .chip.warn{border-color:#8b6b12;color:#ffe08a;}
      .modal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:10000;}
      .modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55);}
      .modal-content{position:relative;max-width:1100px;width:min(1100px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;background:#121822;border:1px solid #243041;border-radius:12px;}
      .modal-header{position:sticky;top:0;display:flex;align-items:center;gap:10px;padding:12px 12px;background:#121822;border-bottom:1px solid #243041;}
      .modal-title{font-weight:650;}
      .modal-body{padding:12px;}
      .file-path{margin:8px 0 10px 0;}
      .file-textarea{width:100%;min-height:220px;max-height:50vh;resize:vertical;background:#0e1420;color:#eaeaea;border:1px solid #243041;border-radius:12px;padding:12px;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,Liberation Mono,monospace;font-size:12.5px;line-height:1.35;}
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
        ? `${t.setupReqMissingProviderEnv}${req.envVar}（provider=${req.provider}）`
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

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text);
}

customElements.define('dominds-setup', DomindsSetup);
