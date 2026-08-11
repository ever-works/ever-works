import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTurnstile, TURNSTILE_SITEKEY } from './use-turnstile';

/**
 * Guard for the options handed to `window.turnstile.render()`.
 *
 * The hook passed `size: 'invisible'`. Cloudflare accepts exactly `normal`,
 * `compact` and `flexible` there, so `render()` threw before a widget ever
 * existed:
 *
 *     Uncaught TurnstileError: [Cloudflare Turnstile] Invalid value for
 *     parameter "size", expected "compact", "flexible", or "normal",
 *     got "invisible".
 *
 * No widget meant no token, so `/onboarding` — the page the marketing site's
 * prompt hand-off lands on — showed "We couldn't verify your browser. Please
 * sign up to continue." for every anonymous visitor. Observed live on
 * app.ever.works.
 *
 * Invisibility is not a size: it comes from `appearance: 'execute'` +
 * `execution: 'execute'`, which the hook already sets, with the container
 * parked off-screen. So the option was invalid AND redundant.
 *
 * These tests assert the OPTIONS OBJECT rather than any rendered output,
 * because the defect lives entirely in the argument we hand to a third-party
 * script. A test that stubs `render()` as a no-op returning an id would pass
 * against the bug — the real Cloudflare script is what rejected it — so the
 * allowed-value list is pinned here explicitly.
 */

/** The only values Cloudflare documents for `size`. */
const CLOUDFLARE_ALLOWED_SIZES = ['normal', 'compact', 'flexible'];

type RenderOptions = Record<string, unknown>;

describe('useTurnstile — render options', () => {
    let renderSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        renderSpy = vi.fn(() => 'widget-id-1');
        (window as unknown as { turnstile?: unknown }).turnstile = {
            render: renderSpy,
            execute: vi.fn(),
            reset: vi.fn(),
            remove: vi.fn(),
            getResponse: vi.fn(),
        };

        // The hook injects the Cloudflare script and waits for its load event
        // before rendering. Resolve that immediately so the effect proceeds.
        const realCreate = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
            const el = realCreate(tag as 'div');
            if (tag === 'script') {
                queueMicrotask(() => el.dispatchEvent(new Event('load')));
            }
            return el;
        }) as typeof document.createElement);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete (window as unknown as { turnstile?: unknown }).turnstile;
        document.getElementById('ew617-turnstile-container')?.remove();
    });

    async function capturedOptions(): Promise<RenderOptions> {
        renderHook(() => useTurnstile(TURNSTILE_SITEKEY));
        await waitFor(() => expect(renderSpy).toHaveBeenCalled());
        return renderSpy.mock.calls[0][1] as RenderOptions;
    }

    it('never sends a size Cloudflare would reject', async () => {
        const options = await capturedOptions();

        // Control: the call really did carry options, so a passing assertion
        // cannot be one that inspected nothing.
        expect(Object.keys(options).length).toBeGreaterThan(0);

        if ('size' in options && options.size !== undefined) {
            expect(CLOUDFLARE_ALLOWED_SIZES).toContain(options.size);
        }
        expect(options.size).not.toBe('invisible');
    });

    it('gets its invisibility from appearance/execution, not from size', async () => {
        const options = await capturedOptions();

        expect(options.appearance).toBe('execute');
        expect(options.execution).toBe('execute');
    });

    it('renders against the configured sitekey', async () => {
        const options = await capturedOptions();

        expect(options.sitekey).toBe(TURNSTILE_SITEKEY);
    });
});
