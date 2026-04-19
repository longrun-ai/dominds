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

function syncElementAttributes(live: Element, next: Element): boolean {
  let changed = false;
  for (const attr of Array.from(live.attributes)) {
    if (!next.hasAttribute(attr.name)) {
      live.removeAttribute(attr.name);
      changed = true;
    }
  }
  for (const attr of Array.from(next.attributes)) {
    if (live.getAttribute(attr.name) !== attr.value) {
      live.setAttribute(attr.name, attr.value);
      changed = true;
    }
  }
  return changed;
}

function syncOptionalAttribute(element: Element, name: string, nextValue: string | null): boolean {
  if (nextValue === null) {
    if (element.hasAttribute(name)) {
      element.removeAttribute(name);
      return true;
    }
    return false;
  }
  if (element.getAttribute(name) !== nextValue) {
    element.setAttribute(name, nextValue);
    return true;
  }
  return false;
}

function cloneRenderedNode(node: Node): Node {
  return node.cloneNode(true);
}

function maybeAddPostprocessTarget(targets: Set<Element>, node: Node): void {
  if (node instanceof HTMLAnchorElement) {
    targets.add(node);
    return;
  }
  if (node instanceof Element) {
    targets.add(node);
  }
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

  private canSkipNode(live: Node, next: Node): boolean {
    if (!this.canReuseNode(live, next)) return false;
    if (live instanceof Text && next instanceof Text) {
      return live.data === next.data;
    }
    if (!(live instanceof HTMLElement) || !(next instanceof HTMLElement)) {
      return false;
    }
    if (isCodeBlockElement(live) && isCodeBlockElement(next)) {
      return (
        (live.getAttribute('language') ?? '') === (next.getAttribute('language') ?? '') &&
        live.code === (next.textContent ?? '')
      );
    }
    if (isMermaidBlockElement(live) && isMermaidBlockElement(next)) {
      return live.definition === (next.textContent ?? '');
    }
    if (isMathBlockElement(live) && isMathBlockElement(next)) {
      return (
        (live.getAttribute('display') ?? '') === (next.getAttribute('display') ?? '') &&
        live.tex === (next.textContent ?? '')
      );
    }
    return live.isEqualNode(next);
  }

  private reconcileCustomElement(
    live: HTMLElement,
    next: HTMLElement,
  ): 'not-custom' | 'changed' | 'unchanged' {
    if (isCodeBlockElement(live) && isCodeBlockElement(next)) {
      const attrChanged = syncOptionalAttribute(live, 'language', next.getAttribute('language'));
      const nextCode = next.textContent ?? '';
      if (live.code !== nextCode) {
        live.code = nextCode;
        return 'changed';
      }
      return attrChanged ? 'changed' : 'unchanged';
    }
    if (isMermaidBlockElement(live) && isMermaidBlockElement(next)) {
      const nextDefinition = next.textContent ?? '';
      if (live.definition !== nextDefinition) {
        live.definition = nextDefinition;
        return 'changed';
      }
      return 'unchanged';
    }
    if (isMathBlockElement(live) && isMathBlockElement(next)) {
      const attrChanged = syncOptionalAttribute(live, 'display', next.getAttribute('display'));
      const nextTex = next.textContent ?? '';
      if (live.tex !== nextTex) {
        live.tex = nextTex;
        return 'changed';
      }
      return attrChanged ? 'changed' : 'unchanged';
    }
    return 'not-custom';
  }

  private reconcileNode(live: Node, next: Node, postprocessTargets: Set<Element>): boolean {
    if (live instanceof Text && next instanceof Text) {
      if (live.data !== next.data) {
        live.data = next.data;
        return true;
      }
      return false;
    }

    if (!(live instanceof HTMLElement) || !(next instanceof HTMLElement)) {
      return false;
    }

    if (this.canSkipNode(live, next)) {
      return false;
    }

    const customResult = this.reconcileCustomElement(live, next);
    if (customResult !== 'not-custom') {
      return customResult === 'changed';
    }

    const attrChanged = syncElementAttributes(live, next);
    const childrenChanged = this.reconcileChildren(live, next, postprocessTargets);
    if (attrChanged || childrenChanged) {
      if (live instanceof HTMLAnchorElement) {
        postprocessTargets.add(live);
      }
      return true;
    }
    return false;
  }

  private reconcileChildren(
    liveParent: Element,
    nextParent: Element,
    postprocessTargets: Set<Element>,
  ): boolean {
    const liveChildren = Array.from(liveParent.childNodes);
    const nextChildren = Array.from(nextParent.childNodes);
    let prefixLength = 0;
    while (
      prefixLength < liveChildren.length &&
      prefixLength < nextChildren.length &&
      this.canSkipNode(liveChildren[prefixLength]!, nextChildren[prefixLength]!)
    ) {
      prefixLength += 1;
    }

    let liveTailIndex = liveChildren.length - 1;
    let nextTailIndex = nextChildren.length - 1;
    while (
      liveTailIndex >= prefixLength &&
      nextTailIndex >= prefixLength &&
      this.canSkipNode(liveChildren[liveTailIndex]!, nextChildren[nextTailIndex]!)
    ) {
      liveTailIndex -= 1;
      nextTailIndex -= 1;
    }

    const tailReference =
      liveTailIndex + 1 < liveChildren.length ? (liveChildren[liveTailIndex + 1] ?? null) : null;
    let changed = false;
    const limit = Math.max(liveTailIndex - prefixLength + 1, nextTailIndex - prefixLength + 1);

    for (let index = 0; index < limit; index += 1) {
      const logicalIndex = prefixLength + index;
      const live = logicalIndex <= liveTailIndex ? (liveChildren[logicalIndex] ?? null) : null;
      const next = logicalIndex <= nextTailIndex ? (nextChildren[logicalIndex] ?? null) : null;

      if (live === null && next !== null) {
        const clone = cloneRenderedNode(next);
        liveParent.insertBefore(clone, tailReference);
        maybeAddPostprocessTarget(postprocessTargets, clone);
        changed = true;
        continue;
      }
      if (live !== null && next === null) {
        live.remove();
        changed = true;
        continue;
      }
      if (live === null || next === null) {
        continue;
      }

      if (!this.canReuseNode(live, next)) {
        const clone = cloneRenderedNode(next);
        live.replaceWith(clone);
        maybeAddPostprocessTarget(postprocessTargets, clone);
        changed = true;
        continue;
      }

      if (this.reconcileNode(live, next, postprocessTargets)) {
        changed = true;
      }
    }

    return changed;
  }

  private normalizePostprocessTargets(targets: Set<Element>): readonly Element[] {
    const allTargets = Array.from(targets);
    return allTargets.filter((target) => {
      for (const other of allTargets) {
        if (other === target) continue;
        if (other.contains(target)) {
          return false;
        }
      }
      return true;
    });
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

    const postprocessTargets = new Set<Element>();
    this.reconcileChildren(contentEl, nextTree, postprocessTargets);
    for (const target of this.normalizePostprocessTargets(postprocessTargets)) {
      postprocessRenderedDomindsMarkdown(target);
    }
    contentEl.setAttribute('data-raw-md', this.accumulatedRawMarkdown);
  }
}

if (!customElements.get('dominds-markdown-section')) {
  customElements.define('dominds-markdown-section', DomindsMarkdownSection);
}
