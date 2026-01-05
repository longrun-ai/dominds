/**
 * Enhanced Team Members Component for Dominds WebUI
 * AI agent team display with provider, model, and capabilities
 */

import type { FrontendTeamMember } from '../services/api';

export interface TeamMembersProps {
  members: FrontendTeamMember[];
  compact?: boolean;
  showActions?: boolean;
  onMemberSelect?: (member: FrontendTeamMember) => void;
  onMemberEdit?: (member: FrontendTeamMember) => void;
}

export class DomindsTeamMembers extends HTMLElement {
  private props: TeamMembersProps = {
    members: [],
    compact: false,
    showActions: false,
  };
  private isModalOpen = false;
  private modal: HTMLElement | null = null;
  private memberList!: HTMLElement;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.render();
    this.setupButtonHandler();
  }

  disconnectedCallback(): void {
    this.closeModal();
  }

  /**
   * Update team members list
   */
  public setMembers(members: FrontendTeamMember[]): void {
    this.props.members = members;
    if (this.isModalOpen) {
      this.updateModalContent();
    }
  }

  /**
   * Set component properties
   */
  public setProps(props: Partial<TeamMembersProps>): void {
    this.props = { ...this.props, ...props };
    if (this.isModalOpen) {
      this.updateModalContent();
    }
  }

  /**
   * Show team members modal
   */
  public show(): void {
    if (this.isModalOpen) return;
    this.isModalOpen = true;
    this.createModal();
  }

  /**
   * Hide team members modal
   */
  public hide(): void {
    this.closeModal();
  }

  private render(): void {
    if (!this.shadowRoot) return;

    const style = this.getStyles();
    const html = this.getHTML();

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      ${html}
    `;
  }

  public getStyles(): string {
    return `
      :host {
        display: inline-block;
      }

      .icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        background: transparent;
        border-radius: 6px;
        cursor: pointer;
        color: var(--dominds-fg, #333333);
      }

      .icon-button:hover {
        background: var(--dominds-hover, #f0f0f0);
      }

      .member-count {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 10px;
        padding: 2px 6px;
        font-size: 12px;
        font-weight: 600;
      }

      /* Modal styles */
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: modalFadeIn 0.3s ease-out;
      }

      .modal-content {
        background: var(--dominds-bg, #ffffff);
        color: var(--dominds-fg, #333333);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        max-width: 500px;
        max-height: 600px;
        width: 90%;
        overflow: hidden;
        animation: modalSlideIn 0.3s ease-out;
      }

      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 20px 24px;
        border-bottom: 1px solid var(--dominds-border, #e0e0e0);
        background: var(--dominds-header-bg, #f8f9fa);
      }

      .modal-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }

      .modal-close {
        background: none;
        border: none;
        font-size: 20px;
        cursor: pointer;
        color: var(--dominds-muted, #666666);
        padding: 4px;
        border-radius: 4px;
        transition: all 0.2s ease;
      }

      .modal-close:hover {
        background: var(--dominds-hover, #f0f0f0);
        color: var(--dominds-fg, #333333);
      }

      .modal-body {
        max-height: 400px;
        overflow-y: auto;
        padding: 0;
      }

      .members-list {
        display: flex;
        flex-direction: column;
      }

      .member-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 24px;
        border-bottom: 1px solid var(--dominds-border-light, rgba(224, 224, 224, 0.5));
        transition: background-color 0.2s ease;
        cursor: pointer;
      }

      .member-item:hover {
        background: var(--dominds-hover, #f0f0f0);
      }

      .member-item:last-child {
        border-bottom: none;
      }

      .member-info {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
        min-width: 0;
      }

      .member-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--dominds-primary, #007acc);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 14px;
        flex-shrink: 0;
        position: relative;
      }

      .member-avatar.online::after {
        content: '';
        position: absolute;
        bottom: 2px;
        right: 2px;
        width: 10px;
        height: 10px;
        background: var(--dominds-success, #10b981);
        border: 2px solid var(--dominds-bg, #ffffff);
        border-radius: 50%;
      }

      .member-details {
        flex: 1;
        min-width: 0;
      }

      .member-name {
        font-weight: 600;
        font-size: 14px;
        color: var(--dominds-fg, #333333);
        margin-bottom: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .member-id {
        font-size: 12px;
        color: var(--dominds-muted, #666666);
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      }

      .member-actions {
        display: flex;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.2s ease;
      }

      .member-item:hover .member-actions {
        opacity: 1;
      }

      .member-action {
        background: none;
        border: none;
        padding: 4px 6px;
        border-radius: 4px;
        cursor: pointer;
        color: var(--dominds-muted, #666666);
        font-size: 12px;
        transition: all 0.2s ease;
      }

      .member-action:hover {
        background: var(--dominds-hover, #f0f0f0);
        color: var(--dominds-fg, #333333);
      }

      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 200px;
        color: var(--dominds-muted, #666666);
        text-align: center;
        padding: 40px 20px;
      }

      .empty-content {
        max-width: 300px;
      }

      .empty-icon {
        font-size: 32px;
        margin-bottom: 12px;
        opacity: 0.5;
      }

      .empty-title {
        font-size: 16px;
        font-weight: 500;
        margin-bottom: 6px;
      }

      .empty-text {
        font-size: 13px;
        line-height: 1.4;
        opacity: 0.7;
      }

      /* Compact mode */
      .compact .member-item {
        padding: 12px 16px;
      }

      .compact .member-avatar {
        width: 32px;
        height: 32px;
        font-size: 12px;
      }

      .compact .member-name {
        font-size: 13px;
      }

      .compact .member-id {
        font-size: 11px;
      }

      /* Animations */
      @keyframes modalFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes modalSlideIn {
        from {
          opacity: 0;
          transform: translateY(-20px) scale(0.95);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      /* Custom scrollbar */
      .modal-body::-webkit-scrollbar {
        width: 6px;
      }

      .modal-body::-webkit-scrollbar-track {
        background: var(--dominds-scrollbar-track, #f1f1f1);
        border-radius: 3px;
      }

      .modal-body::-webkit-scrollbar-thumb {
        background: var(--dominds-scrollbar-thumb, #c1c1c1);
        border-radius: 3px;
      }

      .modal-body::-webkit-scrollbar-thumb:hover {
        background: var(--dominds-scrollbar-thumb-hover, #a8a8a8);
      }

      /* Responsive design */
      @media (max-width: 768px) {
        .modal-content {
          width: 95%;
          max-height: 80vh;
        }

        .modal-header {
          padding: 16px 20px;
        }

        .member-item {
          padding: 12px 16px;
        }

        .member-avatar {
          width: 36px;
          height: 36px;
          font-size: 13px;
        }
      }

      /* Dark theme adjustments */
      [data-theme="dark"] .modal-content {
        background: var(--dominds-bg-secondary, #1e293b);
        color: var(--dominds-fg, #f1f5f9);
      }

      [data-theme="dark"] .modal-header {
        background: var(--dominds-header-bg, #374151);
        border-color: var(--dominds-border, #4b5563);
      }

      [data-theme="dark"] .member-item {
        border-bottom-color: var(--dominds-border, #4b5563);
      }

      [data-theme="dark"] .member-item:hover {
        background: var(--dominds-hover, #374151);
      }

      [data-theme="dark"] .modal-close:hover {
        background: var(--dominds-hover, #374151);
      }
    `;
  }

  public getHTML(): string {
    const memberCount = this.props.members.length;

    return `
      <button class="icon-button" type="button" title="Team Members" ${memberCount === 0 ? 'disabled' : ''}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-3-3.87"></path><path d="M7 21v-2a4 4 0 0 1 3-3.87"></path><circle cx="12" cy="7" r="4"></circle><path d="M18 8a3 3 0 1 0 0-6"></path><path d="M6 8a3 3 0 1 1 0-6"></path></svg>
      </button>
    `;
  }

  private createModal(): void {
    // Create modal overlay
    this.modal = document.createElement('div');
    this.modal.className = 'modal-overlay';

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.className = 'modal-content';

    const header = this.createModalHeader();
    const body = this.createModalBody();

    modalContent.appendChild(header);
    modalContent.appendChild(body);

    this.modal.appendChild(modalContent);
    document.body.appendChild(this.modal);

    // Setup event listeners
    this.setupModalEventListeners();
  }

  private setupButtonHandler(): void {
    const btn = this.shadowRoot?.querySelector('button.icon-button');
    if (!btn) return;
    btn.addEventListener('click', () => {
      this.show();
    });
  }

  private createModalHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'modal-header';

    header.innerHTML = `
      <h3 class="modal-title">
        👥 Team Members (${this.props.members.length})
      </h3>
      <button class="modal-close" type="button" title="Close">×</button>
    `;

    return header;
  }

  private createModalBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'modal-body';

    if (this.props.members.length === 0) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-content">
            <div class="empty-icon">👥</div>
            <div class="empty-title">No team members</div>
            <div class="empty-text">Team members will appear here once configured.</div>
          </div>
        </div>
      `;
    } else {
      const membersList = document.createElement('div');
      membersList.className = 'members-list';
      this.memberList = membersList;

      this.props.members.forEach((member) => {
        membersList.appendChild(this.createMemberItem(member));
      });

      body.appendChild(membersList);
    }

    return body;
  }

  private createMemberItem(member: FrontendTeamMember): HTMLElement {
    const item = document.createElement('div');
    item.className = 'member-item';
    item.setAttribute('data-member-id', member.id);

    item.innerHTML = `
      <div class="member-info">
        <div class="member-avatar">${this.getInitials(member.name)}</div>
        <div class="member-details">
          <div class="member-name">${member.name}</div>
          <div class="member-id">${member.id}</div>
          <div class="member-provider">${member.provider} - ${member.model}</div>
        </div>
      </div>
      ${this.props.showActions ? this.createMemberActions(member) : ''}
    `;

    return item;
  }

  private createMemberActions(member: FrontendTeamMember): string {
    return `
      <div class="member-actions">
        <button class="member-action" title="Select member" data-action="select">👤</button>
        <button class="member-action" title="Edit member" data-action="edit">⚙️</button>
      </div>
    `;
  }

  private getInitials(name: string): string {
    return name
      .split(' ')
      .map((part) => part.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  private setupModalEventListeners(): void {
    if (!this.modal) return;

    // Close modal on overlay click
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.closeModal();
      }
    });

    // Close modal on close button click
    const closeButton = this.modal.querySelector('.modal-close');
    closeButton?.addEventListener('click', () => {
      this.closeModal();
    });

    // Handle escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Handle member item clicks
    const memberItems = this.modal.querySelectorAll('.member-item');
    memberItems.forEach((item) => {
      // Member selection
      item.addEventListener('click', () => {
        const memberId = item.getAttribute('data-member-id');
        const member = this.props.members.find((m) => m.id === memberId);
        if (member && this.props.onMemberSelect) {
          this.props.onMemberSelect(member);
        }
      });

      // Member actions
      const actions = item.querySelectorAll('.member-action');
      actions.forEach((action) => {
        action.addEventListener('click', (e) => {
          e.stopPropagation();
          const memberId = item.getAttribute('data-member-id');
          const actionType = (action as HTMLElement).getAttribute('data-action');
          const member = this.props.members.find((m) => m.id === memberId);

          if (member && actionType === 'select' && this.props.onMemberSelect) {
            this.props.onMemberSelect(member);
          } else if (member && actionType === 'edit' && this.props.onMemberEdit) {
            this.props.onMemberEdit(member);
          }
        });
      });
    });
  }

  private updateModalContent(): void {
    if (!this.modal || !this.memberList) return;

    // Clear existing members
    this.memberList.innerHTML = '';

    // Add updated members
    this.props.members.forEach((member) => {
      this.memberList.appendChild(this.createMemberItem(member));
    });
  }

  private updateModalHeader(): void {
    if (!this.modal) return;

    // Update header count
    const title = this.modal.querySelector('.modal-title');
    if (title) {
      title.textContent = `👥 Team Members (${this.props.members.length})`;
    }
  }

  private closeModal(): void {
    if (!this.isModalOpen) return;

    this.isModalOpen = false;

    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
      this.modal = null as any;
    }
  }
}

// Register the custom element
if (!customElements.get('dominds-team-members')) {
  customElements.define('dominds-team-members', DomindsTeamMembers);
}
