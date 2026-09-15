import { isAllowedImageSrc, MarkdownView } from '@evu/harness-ui';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('isAllowedImageSrc', () => {
  it('allows https and raster data images', () => {
    expect(isAllowedImageSrc('https://example.test/a.png')).toBe(true);
    expect(isAllowedImageSrc('data:image/png;base64,abc')).toBe(true);
  });

  it('rejects javascript, http, and relative src', () => {
    expect(isAllowedImageSrc('javascript:alert(1)')).toBe(false);
    expect(isAllowedImageSrc('http://example.test/a.png')).toBe(false);
    expect(isAllowedImageSrc('/local.png')).toBe(false);
  });
});

describe('MarkdownView', () => {
  it('strips raw HTML such as script tags', () => {
    const { container } = render(
      <MarkdownView text={'Hello <script>alert(1)</script> **world**'} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('world')).toBeTruthy();
  });

  it('rejects javascript: images and keeps the alt text', () => {
    render(<MarkdownView text={'![danger](javascript:alert(1))'} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('danger')).toBeTruthy();
  });

  it('treats mermaid fences as diagrams', async () => {
    render(<MarkdownView text={'```mermaid\ngraph LR\n  A --> B\n```'} />);

    await waitFor(() => {
      expect(document.querySelector('[data-harness="mermaid"]')).not.toBeNull();
    });
  });
});
