import mermaid from 'mermaid';

/**
 * Custom Web Component for Mermaid Diagrams
 */
export class DomindsMermaidBlock extends HTMLElement {
  private _definition: string = '';
  private _id: string = `mermaid-${Math.random().toString(36).substr(2, 9)}`;

  private normalizeMermaidDefinition(definition: string): string {
    // Mermaid flowchart node labels require quoting when they include parser-significant characters.
    // Humans/LLMs often write `A[foo<br/>bar]` or `A[Registry (root only)]`, but Mermaid expects quotes.
    const normalizedNewlines = definition.replace(/\r\n/g, '\n');

    return normalizedNewlines.replace(
      /(\b[\w-]+)\[([^\]\n]*?)\]/g,
      (_full, rawId: string, rawLabel: string) => {
        const id = String(rawId);
        const label = String(rawLabel).trim();

        // Keep empty labels and already quoted labels intact.
        if (!label) return `${id}[]`;
        if (label.startsWith('"') || label.startsWith("'")) return `${id}[${label}]`;

        // Characters like `<`, `(`, `)` and `|` can break unquoted flowchart labels.
        if (!/[<>()|]/.test(label)) return `${id}[${label}]`;

        const escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `${id}["${escaped}"]`;
      },
    );
  }

  constructor() {
    super();
    this.style.display = 'block';
  }

  connectedCallback() {
    this.render();
  }

  public set definition(value: string) {
    this._definition = value;
    this.render();
  }

  public get definition(): string {
    return this._definition;
  }

  private async render() {
    if (!this._definition && this.textContent) {
      this._definition = this.textContent.trim();
    }

    if (!this._definition) return;

    try {
      const definition = this.normalizeMermaidDefinition(this._definition);
      // Mermaid requires a unique ID for each diagram
      const { svg } = await mermaid.render(this._id, definition);
      this.innerHTML = `
        <style>
          dominds-mermaid-block {
            display: block;
            margin: 0.75em 0;
            padding: 1em;
            background: white;
            border-radius: 6px;
            overflow: auto;
            display: flex;
            justify-content: center;
          }
          dominds-mermaid-block svg {
            max-width: 100%;
            height: auto;
          }
        </style>
        ${svg}
      `;
    } catch (error) {
      console.error('Mermaid rendering error:', error);
      this.innerHTML = `
        <style>
          dominds-mermaid-block {
            display: block;
            margin: 0.75em 0;
            padding: 1em;
            background: white;
            border-radius: 6px;
            overflow: auto;
          }
          .mermaid-error {
            white-space: pre;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
              'Courier New', monospace;
            font-size: calc(12px * var(--dominds-ui-scale, 1));
            line-height: 1.4;
          }
        </style>
        <pre class="mermaid-error"></pre>
      `;
      const pre = this.querySelector('.mermaid-error');
      if (pre instanceof HTMLElement) {
        pre.textContent = this._definition;
      }
    }
  }
}

if (!customElements.get('dominds-mermaid-block')) {
  customElements.define('dominds-mermaid-block', DomindsMermaidBlock);
}
