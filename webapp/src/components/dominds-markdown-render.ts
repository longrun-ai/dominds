import { marked } from 'marked';
import './dominds-code-block';
import './dominds-math-block';
import './dominds-mermaid-block';

export function renderDomindsMarkdown(input: string): string {
  try {
    // Pre-process math before markdown parsing
    const processedInput = input
      // Block math: $$ ... $$
      .replace(
        /\$\$\s*([\s\S]*?)\s*\$\$/g,
        '<dominds-math-block display="block">$1</dominds-math-block>',
      )
      // Inline math: $ ... $
      .replace(/\$([^\$\n]+?)\$/g, '<dominds-math-block display="inline">$1</dominds-math-block>');

    const renderer = new marked.Renderer();

    renderer.code = ({ text, lang }) => {
      const language = lang || '';
      if (language === 'mermaid') {
        return `<dominds-mermaid-block>${text}</dominds-mermaid-block>`;
      }
      return `<dominds-code-block language="${language}">${text}</dominds-code-block>`;
    };

    return marked.parse(processedInput, {
      breaks: true,
      gfm: true,
      renderer,
    }) as string;
  } catch (error) {
    console.error('Markdown rendering error:', error);
    return input;
  }
}
