import React, { useEffect, useState } from 'react';

/**
 * Lazy code-block renderer.
 *
 * react-syntax-highlighter (Prism + vscDarkPlus) is ~120 KB gz. It only
 * matters when the assistant emits a fenced code block. We:
 *   1. Render raw <pre><code> immediately so the user sees content.
 *   2. Dynamically import Prism + the dark-plus theme on the first render.
 *   3. Once loaded, swap to the highlighted version.
 *
 * Cached promise — the import resolves once per session, not per code block.
 */

type HighlighterModule = {
  Prism: React.ComponentType<any>;
  vscDarkPlus: any;
};

let highlighterPromise: Promise<HighlighterModule> | null = null;

function loadHighlighter(): Promise<HighlighterModule> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import('react-syntax-highlighter'),
      import('react-syntax-highlighter/dist/esm/styles/prism'),
    ]).then(([rsh, styles]) => ({
      Prism: rsh.Prism as React.ComponentType<any>,
      vscDarkPlus: (styles as any).vscDarkPlus,
    }));
  }
  return highlighterPromise;
}

export interface CodeBlockProps {
  code: string;
  language: string;
  // passthrough for any extra props from react-markdown's code component
  passthrough?: Record<string, any>;
}

export function CodeBlockRenderer({ code, language, passthrough }: CodeBlockProps) {
  const [hl, setHl] = useState<HighlighterModule | null>(null);

  useEffect(() => {
    let alive = true;
    loadHighlighter()
      .then((mod) => {
        if (alive) setHl(mod);
      })
      .catch(() => {
        // Swallow — fallback <pre> stays visible.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!hl) {
    // Pre-load fallback: raw code, no syntax colors. Mirrors the highlighted
    // container so layout doesn't reflow when the highlighter resolves.
    return (
      <pre
        style={{
          margin: 0,
          padding: '1rem',
          background: 'transparent',
          fontSize: '0.875rem',
          color: '#d4d4d4',
          overflowX: 'auto',
        }}
      >
        <code>{code}</code>
      </pre>
    );
  }

  const { Prism, vscDarkPlus } = hl;
  return (
    <Prism
      {...(passthrough || {})}
      style={vscDarkPlus}
      language={language}
      PreTag="div"
      customStyle={{ margin: 0, padding: '1rem', background: 'transparent', fontSize: '0.875rem' }}
    >
      {code}
    </Prism>
  );
}

export default CodeBlockRenderer;
