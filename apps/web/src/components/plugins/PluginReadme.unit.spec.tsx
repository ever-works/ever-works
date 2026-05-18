import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { PluginReadme } from './PluginReadme';

/**
 * H-12 — PluginReadme renders plugin README markdown that comes from
 * untrusted upstream sources (registry, third-party authors). The
 * component pairs `rehype-raw` (parse raw HTML inside markdown) with
 * `rehype-sanitize` to strip anything dangerous before it hits the DOM.
 *
 * These tests pin the sanitization wiring so a future refactor cannot
 * silently re-introduce an XSS vector (e.g., dropping rehype-sanitize,
 * or swapping the order so raw HTML lands in the tree unsanitized).
 *
 * We assert on the rendered DOM, not just on text content: stripping
 * <script> still leaves its text child node behind, which is fine —
 * what matters is that no <script>, <iframe>, or `onerror`-style event
 * handler attribute reaches the rendered output.
 */
describe('PluginReadme — XSS sanitization (H-12)', () => {
    it('strips inline <script> tags from raw HTML in markdown', () => {
        const { container } = render(
            <PluginReadme content={'Hello\n\n<script>alert(1)</script>\n\nWorld'} />,
        );

        // The dangerous element must not be in the DOM.
        expect(container.querySelector('script')).toBeNull();
        // Sanity: the safe surrounding content still rendered.
        expect(container.textContent).toContain('Hello');
        expect(container.textContent).toContain('World');
    });

    it('strips <img onerror=...> event-handler attributes', () => {
        const { container } = render(
            <PluginReadme content={'<img src="x" onerror="alert(1)" />'} />,
        );

        // If an <img> tag survives sanitization (it's allowed by the
        // default schema), the onerror handler attribute must not.
        const img = container.querySelector('img');
        if (img) {
            expect(img.getAttribute('onerror')).toBeNull();
            // Belt-and-suspenders: no element in the subtree should
            // carry an `onerror` attribute.
            expect(container.querySelector('[onerror]')).toBeNull();
        }
        // No <script> should have been injected as a fallback either.
        expect(container.querySelector('script')).toBeNull();
    });

    it('strips <iframe srcdoc="..."> entirely', () => {
        const { container } = render(
            <PluginReadme content={'<iframe srcdoc="<script>alert(1)</script>"></iframe>'} />,
        );

        expect(container.querySelector('iframe')).toBeNull();
        expect(container.querySelector('script')).toBeNull();
    });

    it('strips javascript: hrefs from anchors', () => {
        const { container } = render(<PluginReadme content={'[click me](javascript:alert(1))'} />);

        const anchor = container.querySelector('a');
        if (anchor) {
            const href = anchor.getAttribute('href') ?? '';
            expect(href.toLowerCase().startsWith('javascript:')).toBe(false);
        }
    });

    it('preserves safe content (paragraphs, code, links)', () => {
        const { container } = render(
            <PluginReadme
                content={'# Hello\n\nThis is a [link](https://example.com) and `inline code`.'}
            />,
        );

        expect(container.querySelector('h1')?.textContent).toBe('Hello');
        const link = container.querySelector('a');
        expect(link?.getAttribute('href')).toBe('https://example.com');
        expect(container.querySelector('code')?.textContent).toBe('inline code');
    });
});
