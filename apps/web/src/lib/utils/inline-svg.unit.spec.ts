import { describe, expect, it } from 'vitest';
import { sanitizeInlineSvg } from './inline-svg';

const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 7h18"/><circle cx="12" cy="12" r="3"/></svg>';

describe('sanitizeInlineSvg', () => {
    it('keeps a real icon byte-for-byte', () => {
        expect(sanitizeInlineSvg(ICON)).toBe(ICON);
    });

    it('strips the prolog, comments, scripts, styles, handlers and hrefs in one pass', () => {
        const out = sanitizeInlineSvg(
            '<?xml version="1.0"?><!DOCTYPE svg><svg onload="x()" viewBox="0 0 1 1"><!-- c --><script>x()</script><style>*{}</style><use href="#a"/><path d="M0 0"/></svg>',
        );
        // Element tags go, their text stays (it is inert outside a <script>).
        expect(out).toBe('<svg viewBox="0 0 1 1">x()<path d="M0 0"/></svg>');
    });

    it('fails closed when a removal splices a new construct together', () => {
        expect(sanitizeInlineSvg('<svg><scr<script></script>ipt>alert(1)</script></svg>')).toBe('');
        expect(sanitizeInlineSvg('<svg><!<!-- a -->-- b --></svg>')).toBe('');
    });

    it('strips a handler glued to the previous quoted value (the HTML parser accepts it)', () => {
        const out = sanitizeInlineSvg('<svg><rect x="1"onclick="alert(1)"/></svg>');
        expect(out).not.toMatch(/onclick/i);
        expect(out).toBe('<svg><rect x="1"/></svg>');
    });

    it('fails closed on an HTML element, inside <desc> too, and on a reference to another host', () => {
        expect(sanitizeInlineSvg('<svg><img src="x"onerror=alert(1)></svg>')).toBe('');
        expect(sanitizeInlineSvg('<svg><desc><img src="https://attacker.test/x"></desc></svg>')).toBe('');
        expect(sanitizeInlineSvg('<svg><filter id="f"/></svg>')).toBe('');
        expect(sanitizeInlineSvg('<svg><rect fill="url(https://attacker.test/p)"/></svg>')).toBe('');
        expect(sanitizeInlineSvg('<svg><rect fill="url(#grad)"/></svg>')).toBe('<svg><rect fill="url(#grad)"/></svg>');
    });

    it('fails closed when anything handler-shaped is left, and on oversized input', () => {
        expect(sanitizeInlineSvg('<svg><text>onclick=1</text></svg>')).toBe('');
        expect(sanitizeInlineSvg(`<svg>${'<a'.repeat(5_000)}</svg>`)).toBe('');
    });

    it('fails closed on a dangerous URL scheme that survives the scrub', () => {
        expect(sanitizeInlineSvg('<svg><path fill="url(javascript:alert(1))"/></svg>')).toBe('');
        expect(sanitizeInlineSvg('<svg><path d="data:text/html,x"/></svg>')).toBe('');
    });

    it('answers an empty string for a non-string', () => {
        expect(sanitizeInlineSvg(undefined)).toBe('');
        expect(sanitizeInlineSvg(null)).toBe('');
    });
});
