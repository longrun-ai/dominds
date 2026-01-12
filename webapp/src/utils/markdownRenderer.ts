/**
 * Markdown Renderer with Code Highlighting and Mermaid Support
 * Enhanced rendering for AI chat messages
 */

import hljs from 'highlight.js';
import { marked } from 'marked';
import mermaid from 'mermaid';

// Configure marked with custom options
marked.setOptions({
  breaks: false,
  gfm: true,
});

// Configure Mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose', // Allow some HTML for better compatibility
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
});

export interface RenderOptions {
  enableMermaid?: boolean;
  enableCodeHighlight?: boolean;
  customClasses?: Record<string, string>;
  escapeHtmlInput?: boolean;
}

export class MarkdownRenderer {
  private static instance: MarkdownRenderer;
  private isInitialized = false;

  private constructor() {}

  public static getInstance(): MarkdownRenderer {
    if (!MarkdownRenderer.instance) {
      MarkdownRenderer.instance = new MarkdownRenderer();
    }
    return MarkdownRenderer.instance;
  }

  /**
   * Initialize the markdown renderer
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Initialize Mermaid
      mermaid.initialize({
        startOnLoad: false,
        theme: this.getCurrentTheme(),
        securityLevel: 'loose',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });

      this.isInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize markdown renderer:', error);
    }
  }

  /**
   * Get current theme for Mermaid
   */
  private getCurrentTheme(): 'base' | 'dark' | 'default' | 'forest' | 'neutral' | 'null' {
    const theme = document.documentElement.getAttribute('data-theme');
    const isDark =
      theme === 'dark' ||
      (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    return isDark ? 'dark' : 'default';
  }

  /**
   * Render markdown content to HTML with code highlighting and Mermaid support
   */
  public async render(content: string, options: RenderOptions = {}): Promise<string> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // First, handle Mermaid diagrams
      let processedContent = content;
      if (options.enableMermaid !== false) {
        processedContent = this.extractMermaidDiagrams(processedContent);
      }

      // Treat input as markdown text, not raw HTML when requested
      if (options.escapeHtmlInput) {
        processedContent = this.escapeHtml(processedContent);
      }

      // Parse markdown to HTML
      const html = marked(processedContent) as string;

      // Post-process the HTML
      let finalHtml = this.postProcessHTML(html, options);

      return finalHtml;
    } catch (error) {
      console.error('❌ Markdown rendering error:', error);
      return this.escapeHtml(content);
    }
  }

  /**
   * Extract and process Mermaid diagrams
   */
  private extractMermaidDiagrams(content: string): string {
    // Match mermaid code blocks
    const mermaidRegex = /```mermaid\s*([\s\S]*?)```/g;

    return content.replace(mermaidRegex, (match, diagram) => {
      const diagramId = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Store the diagram for later rendering
      (window as any).__mermaidDiagrams = (window as any).__mermaidDiagrams || {};
      (window as any).__mermaidDiagrams[diagramId] = diagram.trim();

      return `<div class="mermaid-diagram" id="${diagramId}">
        <div class="mermaid-loading">Rendering diagram...</div>
      </div>`;
    });
  }

  /**
   * Post-process HTML for better styling and functionality
   */
  private postProcessHTML(html: string, options: RenderOptions): string {
    // Add custom classes for styling
    let processedHtml = html;

    // Wrap code blocks in proper containers
    processedHtml = processedHtml.replace(
      /<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g,
      '<div class="code-block-wrapper"><div class="code-header"><span class="language">$1</span><button class="copy-btn" title="Copy code">📋</button></div><pre><code class="language-$1">$2</code></pre></div>',
    );

    // Add copy functionality to code blocks
    processedHtml = this.addCopyFunctionality(processedHtml);

    // Add custom classes to common markdown elements
    processedHtml = this.addCustomClasses(processedHtml, options.customClasses);

    return processedHtml;
  }

  /**
   * Add copy functionality to code blocks
   */
  private addCopyFunctionality(html: string): string {
    // This will be handled by event listeners in the component
    return html;
  }

  /**
   * Add custom CSS classes
   */
  private addCustomClasses(html: string, customClasses?: Record<string, string>): string {
    if (!customClasses) return html;

    let processedHtml = html;
    for (const [selector, className] of Object.entries(customClasses)) {
      // Simple class addition for common elements
      switch (selector) {
        case 'table':
          processedHtml = processedHtml.replace(/<table>/g, `<table class="${className}">`);
          break;
        case 'blockquote':
          processedHtml = processedHtml.replace(
            /<blockquote>/g,
            `<blockquote class="${className}">`,
          );
          break;
      }
    }

    return processedHtml;
  }

  /**
   * Render any stored Mermaid diagrams
   */
  public async renderMermaidDiagrams(): Promise<void> {
    const diagrams = (window as any).__mermaidDiagrams;
    if (!diagrams) return;

    for (const [diagramId, diagram] of Object.entries(diagrams)) {
      try {
        const element = document.getElementById(diagramId);
        if (element) {
          const { svg } = await mermaid.render(diagramId, diagram as string);
          element.innerHTML = svg;
          element.classList.add('mermaid-rendered');
        }
      } catch (error) {
        console.error('❌ Mermaid rendering error:', error);
        const element = document.getElementById(diagramId);
        if (element) {
          element.innerHTML = `<div class="mermaid-error">❌ Failed to render diagram</div>`;
        }
      }
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Process raw text for basic formatting (fallback)
   */
  public processBasicFormatting(text: string): string {
    try {
      // First escape HTML special characters to prevent rendering issues
      let escapedText = this.escapeHtml(text);

      // Then apply basic markdown formatting
      return escapedText
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    } catch (error) {
      console.error('❌ Error processing basic formatting:', error);
      // Return escaped text as fallback to avoid breaking the UI
      return this.escapeHtml(text);
    }
  }
}

// Export singleton instance
export const markdownRenderer = MarkdownRenderer.getInstance();

// Export utility functions
export { hljs, marked, mermaid };
