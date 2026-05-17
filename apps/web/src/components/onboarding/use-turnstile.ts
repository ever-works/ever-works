'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * EW-617 G7 — Cloudflare Turnstile (Managed mode) client hook.
 *
 * Loads the Turnstile script once (idempotent: re-mounting components
 * reuses the global script), renders a hidden Turnstile widget in
 * `execution: 'execute'` mode, and exposes `getToken()` so the caller
 * can request a fresh token immediately before each captcha-gated
 * API call.
 *
 * Why programmatic execute (vs auto-render):
 *   - The wizard has multiple gated calls (`/api/auth/anonymous`,
 *     `/api/works/quick-create`) at different moments. A single
 *     widget with on-demand `execute()` produces one fresh token per
 *     call, which is what Turnstile expects (tokens are single-use
 *     with a ~5min TTL).
 *   - Managed-mode UX: clean traffic gets an invisible verification,
 *     suspicious traffic gets an interactive challenge in the
 *     widget's hidden iframe (the iframe pops up only when needed).
 *
 * Empty / unset sitekey ⇒ hook resolves `getToken()` with an empty
 * string immediately and lets the server fall through to its no-op
 * captcha path. This keeps dev/preview environments unblocked.
 */

// Public Turnstile sitekey for the `ever.works` / `app.ever.works` /
// `appstage.ever.works` Managed widget (EW-617 G7, created
// 2026-05-15). Cloudflare validates the calling hostname against the
// widget's allowed-domains list, so the sitekey is safe to embed.
export const TURNSTILE_SITEKEY = '0x4AAAAAADQBelkvZYTPpR4t';

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const CONTAINER_ID = 'ew617-turnstile-container';

type TurnstileRenderOptions = {
    sitekey: string;
    appearance: 'always' | 'execute' | 'interaction-only';
    execution: 'render' | 'execute';
    size: 'normal' | 'compact' | 'invisible';
    callback?: (token: string) => void;
    'error-callback'?: (errorCode: string) => void;
    'expired-callback'?: () => void;
    retry?: 'auto' | 'never';
};

declare global {
    interface Window {
        turnstile?: {
            render: (container: HTMLElement | string, options: TurnstileRenderOptions) => string;
            execute: (widgetId: string) => void;
            reset: (widgetId: string) => void;
            remove: (widgetId: string) => void;
            getResponse: (widgetId: string) => string | undefined;
        };
        onTurnstileLoad?: () => void;
    }
}

/**
 * Returns `getToken()` that resolves to a fresh Turnstile token (or
 * empty string if no sitekey is configured, captcha is server-disabled,
 * or the script failed to load). Errors during execution resolve as
 * empty too — never throw, since the server gracefully no-ops when
 * `CAPTCHA_PROVIDER` is unset.
 */
export function useTurnstile(sitekey: string = TURNSTILE_SITEKEY) {
    const widgetIdRef = useRef<string | null>(null);
    const pendingResolveRef = useRef<((token: string) => void) | null>(null);
    // Lazy init covers the "script already loaded by an earlier mount and
    // window.turnstile is up" case without needing a synchronous setState
    // inside the effect below (which trips the react-compiler rule).
    const [ready, setReady] = useState(
        () => typeof window !== 'undefined' && Boolean(window.turnstile),
    );

    // Lazy-load the Turnstile script once. The Cloudflare API auto-detects
    // duplicate loads, but we still guard against multiple <script> tags.
    useEffect(() => {
        if (!sitekey) return;
        if (typeof window === 'undefined') return;
        // Already initialised — make sure `ready` reflects that, then bail
        // before any DOM work. Covers the narrow window where another mount
        // loaded the script between our lazy-init read and this effect's
        // commit, which would otherwise leave us stuck on ready=false.
        // Defer via microtask to avoid triggering a synchronous cascading
        // render inside the effect (react-hooks/set-state-in-effect).
        if (window.turnstile) {
            queueMicrotask(() => setReady(true));
            return;
        }

        const existing = document.querySelector(`script[src^="${TURNSTILE_SCRIPT_SRC}"]`);
        if (existing) {
            existing.addEventListener('load', () => setReady(true), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = `${TURNSTILE_SCRIPT_SRC}?render=explicit`;
        script.async = true;
        script.defer = true;
        script.addEventListener('load', () => setReady(true), { once: true });
        document.head.appendChild(script);
    }, [sitekey]);

    // Render an invisible widget once the script is ready. We keep one
    // widget alive for the lifetime of the hook and re-use it via
    // execute()/reset() for each call.
    useEffect(() => {
        if (!ready || !sitekey) return;
        if (typeof window === 'undefined' || !window.turnstile) return;
        if (widgetIdRef.current) return;

        let container = document.getElementById(CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = CONTAINER_ID;
            container.style.position = 'absolute';
            container.style.left = '-9999px';
            container.style.top = '-9999px';
            document.body.appendChild(container);
        }

        widgetIdRef.current = window.turnstile.render(container, {
            sitekey,
            appearance: 'execute',
            execution: 'execute',
            size: 'invisible',
            retry: 'auto',
            callback: (token: string) => {
                pendingResolveRef.current?.(token);
                pendingResolveRef.current = null;
            },
            'error-callback': () => {
                pendingResolveRef.current?.('');
                pendingResolveRef.current = null;
            },
            'expired-callback': () => {
                if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
            },
        });

        return () => {
            if (widgetIdRef.current && window.turnstile) {
                window.turnstile.remove(widgetIdRef.current);
                widgetIdRef.current = null;
            }
        };
    }, [ready, sitekey]);

    const getToken = useCallback((): Promise<string> => {
        if (!sitekey) return Promise.resolve('');
        if (typeof window === 'undefined' || !window.turnstile || !widgetIdRef.current) {
            // Script not loaded yet or no widget — let the server fall back.
            return Promise.resolve('');
        }
        return new Promise<string>((resolve) => {
            pendingResolveRef.current = resolve;
            try {
                window.turnstile!.reset(widgetIdRef.current!);
                window.turnstile!.execute(widgetIdRef.current!);
            } catch {
                pendingResolveRef.current = null;
                resolve('');
            }
            // Safety net: if Turnstile never calls back, resolve empty
            // after 10s so the user isn't stuck. The server's per-IP
            // throttle is still in effect.
            setTimeout(() => {
                if (pendingResolveRef.current === resolve) {
                    pendingResolveRef.current = null;
                    resolve('');
                }
            }, 10_000);
        });
    }, [sitekey]);

    return { getToken, ready };
}
