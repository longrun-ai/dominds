/**
 * Custom Web Component for Markdown Section
 * Supports chunk-based incremental rendering
 */

import { marked } from 'marked';
import './dominds-code-block';
import './dominds-math-block';
import './dominds-mermaid-block';

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
      contentEl.innerHTML = this.renderMarkdown(this.accumulatedRawMarkdown);
      // Store raw content in data attribute for persistence/reconstruction
      contentEl.setAttribute('data-raw-md', this.accumulatedRawMarkdown);
    }
  }

  /**
   * Use 'marked' library for markdown rendering
   */
  private renderMarkdown(input: string): string {
    try {
      // Pre-process math before markdown parsing
      let processedInput = input
        // Block math: $$ ... $$
        .replace(
          /\$\$\s*([\s\S]*?)\s*\$\$/g,
          '<dominds-math-block display="block">$1</dominds-math-block>',
        )
        // Inline math: $ ... $ (avoid matching $ in code blocks if possible, but marked handles that)
        .replace(
          /\$([^\$\n]+?)\$/g,
          '<dominds-math-block display="inline">$1</dominds-math-block>',
        );

      const renderer = new marked.Renderer();

      // Custom code block renderer
      renderer.code = ({ text, lang }) => {
        const language = lang || '';
        if (language === 'mermaid') {
          return `<dominds-mermaid-block>${text}</dominds-mermaid-block>`;
        }
        return `<dominds-code-block language="${language}">${text}</dominds-code-block>`;
      };

      // Configure marked for consistent rendering
      return marked.parse(processedInput, {
        breaks: true,
        gfm: true,
        renderer,
      }) as string;
    } catch (error) {
      console.error('Markdown rendering error:', error);
      return input; // Fallback to raw text on error
    }
  }
}

// Register the custom element
if (!customElements.get('dominds-markdown-section')) {
  customElements.define('dominds-markdown-section', DomindsMarkdownSection);
}
