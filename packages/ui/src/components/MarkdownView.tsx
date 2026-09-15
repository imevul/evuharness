import { type ReactNode, useEffect, useId, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

let mermaidModule: Promise<typeof import('mermaid')> | undefined;

function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidModule ??= import('mermaid').then((mod) => {
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
    });
    return mod;
  });
  return mermaidModule;
}

export interface MarkdownViewProps {
  text: string;
  className?: string;
}

const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp)(?:;|,)/i;

/**
 * Sanitized rich text for completed transcript rows.
 *
 * No `rehype-raw`: HTML in the source is treated as text and then stripped by
 * the sanitizer. Images must be `https:` or a raster `data:image/*`. Mermaid
 * fences lazy-load the renderer with `securityLevel: 'strict'`.
 */
export function MarkdownView({ text, className }: MarkdownViewProps) {
  return (
    <div className={className} data-harness="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function isAllowedImageSrc(src: string | undefined): boolean {
  if (src === undefined || src === '') return false;
  if (ALLOWED_DATA_IMAGE.test(src)) return true;
  try {
    return new URL(src).protocol === 'https:';
  } catch {
    return false;
  }
}

const components: Components = {
  img({ src, alt }) {
    if (!isAllowedImageSrc(typeof src === 'string' ? src : undefined)) {
      return <span data-harness="markdown-img-rejected">{alt ?? ''}</span>;
    }
    return <img src={src} alt={alt ?? ''} />;
  },
  code({ className, children }) {
    const language = languageOf(className);
    const source = textOf(children).replace(/\n$/, '');
    if (language === 'mermaid') {
      return <MermaidBlock source={source} />;
    }
    return <code className={className}>{children}</code>;
  },
};

function languageOf(className: string | undefined): string | undefined {
  const match = className?.match(/language-([\w-]+)/);
  return match?.[1];
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children === 'number') return String(children);
  return '';
}

function MermaidBlock({ source }: { source: string }) {
  const reactId = useId().replace(/:/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadMermaid()
      .then(async (mod) => {
        const rendered = await mod.default.render(`harness-mermaid-${reactId}`, source);
        if (!cancelled) setSvg(rendered.svg);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reactId, source]);

  if (failed || svg === null) {
    return (
      <pre data-harness="mermaid" data-pending={svg === null && !failed ? 'true' : undefined}>
        {source}
      </pre>
    );
  }

  return (
    <div
      data-harness="mermaid"
      // SVG comes from mermaid with securityLevel: 'strict' and no click callbacks.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid emits SVG; strict mode is the control
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
