import mermaid from 'mermaid';

/**
 * Custom Web Component for Mermaid Diagrams
 */
export class DomindsMermaidBlock extends HTMLElement {
  private _definition: string = '';
  private _id: string = `mermaid-${Math.random().toString(36).substr(2, 9)}`;

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
      // Mermaid requires a unique ID for each diagram
      const { svg } = await mermaid.render(this._id, this._definition);
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
      this.innerHTML = `<pre class="mermaid-error">${this._definition}</pre>`;
    }
  }
}

if (!customElements.get('dominds-mermaid-block')) {
  customElements.define('dominds-mermaid-block', DomindsMermaidBlock);
}
