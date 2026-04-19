/**
 * Custom Web Component for Markdown Section
 * Reconciles rendered DOM against an in-memory render tree so stable custom blocks survive
 * streaming updates.
 */

import {
  postprocessRenderedDomindsMarkdown,
  renderDomindsMarkdown,
} from './dominds-markdown-render';

type CodeBlockElement = HTMLElement & { code: string };
type MermaidBlockElement = HTMLElement & { definition: string };
type MathBlockElement = HTMLElement & { tex: string };

function isCodeBlockElement(node: Node | null): node is CodeBlockElement {
  return (
    node instanceof HTMLElement &&
    node.tagName === 'DOMINDS-CODE-BLOCK' &&
    typeof (node as Partial<CodeBlockElement>).code === 'string'
  );
}

function isMermaidBlockElement(node: Node | null): node is MermaidBlockElement {
  return (
    node instanceof HTMLElement &&
    node.tagName === 'DOMINDS-MERMAID-BLOCK' &&
    typeof (node as Partial<MermaidBlockElement>).definition === 'string'
  );
}

function isMathBlockElement(node: Node | null): node is MathBlockElement {
  return (
    node instanceof HTMLElement &&
    node.tagName === 'DOMINDS-MATH-BLOCK' &&
    typeof (node as Partial<MathBlockElement>).tex === 'string'
  );
}

function syncElementAttributes(live: Element, next: Element): void {
  for (const attr of Array.from(live.attributes)) {
    if (!next.hasAttribute(attr.name)) {
      live.removeAttribute(attr.name);
    }
  }
  for (const attr of Array.from(next.attributes)) {
    if (live.getAttribute(attr.name) !== attr.value) {
      live.setAttribute(attr.name, attr.value);
    }
  }
}

function syncOptionalAttribute(element: Element, name: string, nextValue: string | null): void {
  if (nextValue === null) {
    if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
    return;
  }
  if (element.getAttribute(name) !== nextValue) {
    element.setAttribute(name, nextValue);
  }
}

function cloneRenderedNode(node: Node): Node {
  return node.cloneNode(true);
}

export class DomindsMarkdownSection extends HTMLElement {
  private accumulatedRawMarkdown: string = '';

  constructor() {
    super();
    this.classList.add('markdown-section');
    this.innerHTML = '<div class="markdown-content"></div>';
  }

  public appendChunk(chunk: string): void {
    this.accumulatedRawMarkdown += chunk;
    this.render();
  }

  public getRawMarkdown(): string {
    return this.accumulatedRawMarkdown;
  }

  public setRawMarkdown(markdown: string): void {
    this.accumulatedRawMarkdown = markdown;
    this.render();
  }

  private canReuseNode(live: Node, next: Node): boolean {
    if (live.nodeType !== next.nodeType) return false;
    if (live instanceof Text && next instanceof Text) return true;
    if (live instanceof HTMLElement && next instanceof HTMLElement) {
      return live.tagName === next.tagName;
    }
    return false;
  }

  private reconcileCustomElement(live: HTMLElement, next: HTMLElement): boolean {
    if (isCodeBlockElement(live) && isCodeBlockElement(next)) {
      syncOptionalAttribute(live, 'language', next.getAttribute('language'));
      const nextCode = next.textContent ?? '';
      if (live.code !== nextCode) {
        live.code = nextCode;
      }
      return true;
    }
    if (isMermaidBlockElement(live) && isMermaidBlockElement(next)) {
      const nextDefinition = next.textContent ?? '';
      if (live.definition !== nextDefinition) {
        live.definition = nextDefinition;
      }
      return true;
    }
    if (isMathBlockElement(live) && isMathBlockElement(next)) {
      syncOptionalAttribute(live, 'display', next.getAttribute('display'));
      const nextTex = next.textContent ?? '';
      if (live.tex !== nextTex) {
        live.tex = nextTex;
      }
      return true;
    }
    return false;
  }

  private reconcileNode(live: Node, next: Node): void {
    if (live instanceof Text && next instanceof Text) {
      if (live.data !== next.data) {
        live.data = next.data;
      }
      return;
    }

    if (!(live instanceof HTMLElement) || !(next instanceof HTMLElement)) {
      return;
    }

    if (live.isEqualNode(next)) {
      return;
    }

    if (this.reconcileCustomElement(live, next)) {
      return;
    }

    syncElementAttributes(live, next);
    this.reconcileChildren(live, next);
  }

  private reconcileChildren(liveParent: Element, nextParent: Element): void {
    const liveChildren = Array.from(liveParent.childNodes);
    const nextChildren = Array.from(nextParent.childNodes);
    const limit = Math.max(liveChildren.length, nextChildren.length);

    for (let index = 0; index < limit; index += 1) {
      const live = liveChildren[index] ?? null;
      const next = nextChildren[index] ?? null;

      if (live === null && next !== null) {
        liveParent.appendChild(cloneRenderedNode(next));
        continue;
      }
      if (live !== null && next === null) {
        live.remove();
        continue;
      }
      if (live === null || next === null) {
        continue;
      }

      if (!this.canReuseNode(live, next)) {
        live.replaceWith(cloneRenderedNode(next));
        continue;
      }

      this.reconcileNode(live, next);
    }
  }

  private render(): void {
    const contentEl = this.querySelector('.markdown-content') as HTMLElement | null;
    if (!contentEl) return;

    const rendered = renderDomindsMarkdown(this.accumulatedRawMarkdown, {
      kind: 'chat',
      allowRelativeWorkspaceLinks: true,
    });
    const nextTree = document.createElement('div');
    nextTree.innerHTML = rendered;

    this.reconcileChildren(contentEl, nextTree);
    postprocessRenderedDomindsMarkdown(contentEl);
    contentEl.setAttribute('data-raw-md', this.accumulatedRawMarkdown);
  }
}

if (!customElements.get('dominds-markdown-section')) {
  customElements.define('dominds-markdown-section', DomindsMarkdownSection);
}
