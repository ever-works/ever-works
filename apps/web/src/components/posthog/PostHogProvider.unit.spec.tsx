import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * Tests for the platform's client-side PostHog wiring.
 *
 * The provider is fail-open: when `NEXT_PUBLIC_POSTHOG_KEY` is unset
 * (the OSS-fork case) `posthog.init` MUST NOT be called. When the key
 * is set we expect `init` with the right host. Init runs at MODULE LOAD
 * time (not in an effect) — see the comment in PostHogProvider.tsx for
 * why — so these tests use `vi.resetModules()` plus a dynamic
 * `await import(...)` to observe the side effect of the module's top-
 * level code under each env-var configuration.
 *
 * The companion pageview component must emit `$pageview` on every App
 * Router navigation, since `capture_pageview: false` disables PostHog's
 * built-in handler. The identify component must call `posthog.reset()`
 * on unmount so logout (which tears down the dashboard layout) clears
 * the distinct_id.
 */

const mockPathname = vi.fn<() => string>();
const mockSearchParams = vi.fn<() => URLSearchParams>();

vi.mock('next/navigation', () => ({
    usePathname: () => mockPathname(),
    useSearchParams: () => mockSearchParams(),
}));

// `posthog-js/react` <PostHogProvider> tries to mount things against the
// real `posthog` global; for unit tests we don't care about its internals
// and just render children as-is.
vi.mock('posthog-js/react', () => ({
    PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const initSpy = vi.fn();
const captureSpy = vi.fn();
const identifySpy = vi.fn();
const resetSpy = vi.fn();
vi.mock('posthog-js', () => ({
    default: {
        init: (...args: unknown[]) => initSpy(...args),
        capture: (...args: unknown[]) => captureSpy(...args),
        identify: (...args: unknown[]) => identifySpy(...args),
        reset: (...args: unknown[]) => resetSpy(...args),
        debug: () => undefined,
    },
}));

// jsdom doesn't set `window.origin` reliably across versions; pin it so
// the assertion on `$current_url` is deterministic.
Object.defineProperty(window, 'origin', {
    configurable: true,
    value: 'http://localhost:3000',
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    initSpy.mockReset();
    captureSpy.mockReset();
    identifySpy.mockReset();
    resetSpy.mockReset();
    mockPathname.mockReturnValue('/dashboard');
    mockSearchParams.mockReturnValue(new URLSearchParams());
    process.env = { ...ORIGINAL_ENV };
    // Module-scope init runs once per import. Reset the registry so the
    // dynamic import in each test re-evaluates against the current env.
    vi.resetModules();
});

afterEach(() => {
    cleanup();
    process.env = ORIGINAL_ENV;
});

describe('PostHogProvider', () => {
    it('initializes posthog at module load when NEXT_PUBLIC_POSTHOG_KEY is set', async () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
        process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';

        // Importing the module is what triggers `posthog.init(...)` —
        // assert BEFORE rendering anything to prove init does not
        // depend on the component mounting.
        await import('./PostHogProvider');

        expect(initSpy).toHaveBeenCalledTimes(1);
        const [key, opts] = initSpy.mock.calls[0] as [string, Record<string, unknown>];
        expect(key).toBe('phc_test_key');
        expect(opts.api_host).toBe('https://us.i.posthog.com');
        // Manual pageview capture is the whole point — make sure we
        // didn't regress to PostHog's built-in handler.
        expect(opts.capture_pageview).toBe(false);
        expect(opts.capture_pageleave).toBe(true);
        expect(opts.autocapture).toBe(true);
        const replay = opts.session_recording as Record<string, unknown>;
        // Secure by default: mask every input regardless of `type`.
        // Per-type masking via `maskInputOptions` is unreliable when
        // sensitive fields render as `type="text"`.
        expect(replay.maskAllInputs).toBe(true);
        expect(replay.maskInputOptions).toBeUndefined();
    });

    it('does NOT initialize posthog when NEXT_PUBLIC_POSTHOG_KEY is empty (OSS-fork case)', async () => {
        delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

        await import('./PostHogProvider');

        expect(initSpy).not.toHaveBeenCalled();
    });
});

describe('PostHogPageview', () => {
    it('fires a $pageview capture on mount including query string', async () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
        mockPathname.mockReturnValue('/dashboard/works');
        mockSearchParams.mockReturnValue(new URLSearchParams('q=foo&page=2'));

        const { PostHogPageview } = await import('./PostHogProvider');
        // Module-scope init also fires when the module is imported;
        // clear capture spy AFTER import so we observe only the
        // pageview emitted by the component effect.
        captureSpy.mockReset();
        render(<PostHogPageview />);

        expect(captureSpy).toHaveBeenCalledTimes(1);
        const [event, props] = captureSpy.mock.calls[0] as [string, { $current_url: string }];
        expect(event).toBe('$pageview');
        expect(props.$current_url).toBe('http://localhost:3000/dashboard/works?q=foo&page=2');
    });

    it('fires $pageview again when the pathname changes (SPA navigation)', async () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';
        mockPathname.mockReturnValue('/dashboard');
        mockSearchParams.mockReturnValue(new URLSearchParams());

        const { PostHogPageview } = await import('./PostHogProvider');
        captureSpy.mockReset();
        const { rerender } = render(<PostHogPageview />);
        expect(captureSpy).toHaveBeenCalledTimes(1);

        mockPathname.mockReturnValue('/dashboard/works/abc');
        rerender(<PostHogPageview />);

        expect(captureSpy).toHaveBeenCalledTimes(2);
        const [, props] = captureSpy.mock.calls[1] as [string, { $current_url: string }];
        expect(props.$current_url).toBe('http://localhost:3000/dashboard/works/abc');
    });

    it('does NOT fire pageview when NEXT_PUBLIC_POSTHOG_KEY is empty', async () => {
        delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
        mockPathname.mockReturnValue('/dashboard');

        const { PostHogPageview } = await import('./PostHogProvider');
        render(<PostHogPageview />);

        expect(captureSpy).not.toHaveBeenCalled();
    });
});

describe('PostHogIdentify', () => {
    it('calls posthog.reset() on unmount so logout clears the distinct_id', async () => {
        process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test_key';

        const { PostHogIdentify } = await import('./PostHogIdentify');
        const { unmount } = render(
            <PostHogIdentify userId="u1" email="u1@example.com" name="U One" />,
        );

        // Identify ran on mount.
        expect(identifySpy).toHaveBeenCalledTimes(1);
        expect(resetSpy).not.toHaveBeenCalled();

        unmount();

        // Unmount cleanup fires reset, even though `userId` never
        // transitioned to falsy.
        expect(resetSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT call posthog on unmount when NEXT_PUBLIC_POSTHOG_KEY is empty', async () => {
        delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

        const { PostHogIdentify } = await import('./PostHogIdentify');
        const { unmount } = render(<PostHogIdentify userId="u1" />);
        unmount();

        expect(identifySpy).not.toHaveBeenCalled();
        expect(resetSpy).not.toHaveBeenCalled();
    });
});
