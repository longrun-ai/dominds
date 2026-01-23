/**
 * Custom Web Component for Markdown Section
 * Supports chunk-based incremental rendering
 */

import { renderDomindsMarkdown } from './dominds-markdown-render';

export class DomindsMarkdownSection extends HTMLElement {
  private accumulatedRawMarkdown: string = '';

  constructor() {
    super();
    // Add base class for styling (matches existing CSS in dominds-dialog-container)
    this.classList.add('markdown-section');
    this.innerHTML = '<div class="markdown-content"></div>';
  }

  /**
   * Public API: Append a markdown chunk and re-render
   */
  public appendChunk(chunk: string): void {
    this.accumulatedRawMarkdown += chunk;
    this.render();
  }

  /**
   * Public API: Get the accumulated raw markdown
   */
  public getRawMarkdown(): string {
    return this.accumulatedRawMarkdown;
  }

  /**
   * Public API: Set the raw markdown directly (e.g. for reconstruction)
   */
  public setRawMarkdown(markdown: string): void {
    this.accumulatedRawMarkdown = markdown;
    this.render();
  }

  /**
   * Internal render logic
   */
  private render(): void {
    const contentEl = this.querySelector('.markdown-content') as HTMLElement | null;
    if (contentEl) {
      contentEl.innerHTML = renderDomindsMarkdown(this.accumulatedRawMarkdown);
      // Store raw content in data attribute for persistence/reconstruction
      contentEl.setAttribute('data-raw-md', this.accumulatedRawMarkdown);
    }
  }
}

// Register the custom element
if (!customElements.get('dominds-markdown-section')) {
  customElements.define('dominds-markdown-section', DomindsMarkdownSection);
}
