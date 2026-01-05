import katex from 'katex';

/**
 * Custom Web Component for Math Rendering using KaTeX
 */
export class DomindsMathBlock extends HTMLElement {
  private _tex: string = '';
  private _displayMode: boolean = true;

  static get observedAttributes() {
    return ['display'];
  }

  constructor() {
    super();
    this.style.display = 'inline-block';
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (name === 'display' && oldValue !== newValue) {
      this._displayMode = newValue !== 'inline';
      this.render();
    }
  }

  public set tex(value: string) {
    this._tex = value;
    this.render();
  }

  public get tex(): string {
    return this._tex;
  }

  private render() {
    if (!this._tex && this.textContent) {
      this._tex = this.textContent.trim();
    }

    if (!this._tex) return;

    try {
      this.innerHTML = `
        <style>
          dominds-math-block[display="block"] {
            display: block;
            margin: 0.75em 0;
            text-align: center;
          }
          dominds-math-block[display="inline"] {
            display: inline-block;
            padding: 0 2px;
          }
        </style>
        ${katex.renderToString(this._tex, {
          displayMode: this._displayMode,
          throwOnError: false,
        })}
      `;
    } catch (error) {
      console.error('KaTeX rendering error:', error);
      this.textContent = this._tex;
    }
  }
}

if (!customElements.get('dominds-math-block')) {
  customElements.define('dominds-math-block', DomindsMathBlock);
}
