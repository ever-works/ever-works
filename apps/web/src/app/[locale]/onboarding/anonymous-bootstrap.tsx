'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTurnstile } from '@/components/onboarding/use-turnstile';
import { startAnonymousOnboarding } from '@/app/actions/onboarding/anonymous';

type Phase = 'starting' | 'error';

// Cross-mount guard key. If a mint "succeeds" but the session doesn't take and
// we land back here, we must NOT auto-remint (that loops until the 5/hour/IP
// throttle) — show the manual fallback instead.
const SESSION_GUARD = 'ew_anon_onboarding_attempted';

function readHashParam(hash: string, key: string): string | null {
    if (!hash) return null;
    try {
        return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get(key);
    } catch {
        return null;
    }
}

export function AnonymousOnboardingBootstrap() {
    const router = useRouter();
    const { getToken, ready } = useTurnstile();
    const [phase, setPhase] = useState<Phase>('starting');
    const [message, setMessage] = useState<string | null>(null);
    const startedRef = useRef(false);
    // If Turnstile never becomes ready (CSP-blocked / ad-blocked), attempt anyway
    // after a grace period so the user isn't stuck on a spinner — the server 400s
    // (captcha) and we fall through to the sign-up affordance.
    const [forceAttempt, setForceAttempt] = useState(false);

    const run = useCallback(async () => {
        // Defer past the effect commit so no setState runs synchronously inside
        // an effect body (matches the use-turnstile queueMicrotask convention).
        await Promise.resolve();

        let alreadyTried = false;
        try {
            alreadyTried = sessionStorage.getItem(SESSION_GUARD) === '1';
            sessionStorage.setItem(SESSION_GUARD, '1');
        } catch {
            /* private mode — ref guard still prevents same-mount double-run */
        }
        if (alreadyTried) {
            setPhase('error');
            setMessage('We couldn’t start a guest session. Please sign up to continue.');
            return;
        }

        setPhase('starting');
        setMessage(null);
        const corrId =
            typeof window !== 'undefined' ? readHashParam(window.location.hash, 'corrId') : null;
        const captchaToken = await getToken(); // '' when Turnstile unavailable
        const result = await startAnonymousOnboarding({
            captchaToken: captchaToken || undefined,
            correlationId: corrId || undefined,
        });
        if (result.success) {
            // Cookie is set. Re-render THIS url (hash preserved — router.refresh
            // never touches the URL) so the server page takes the authed branch
            // and mounts the wizard, which then reads #prompt from the hash.
            router.refresh();
            return;
        }
        setPhase('error');
        setMessage(result.error ?? 'Something went wrong.');
    }, [getToken, router]);

    useEffect(() => {
        const t = setTimeout(() => setForceAttempt(true), 8000);
        return () => clearTimeout(t);
    }, []);

    useEffect(() => {
        if (startedRef.current) return;
        if (!ready && !forceAttempt) return;
        startedRef.current = true;
        void run();
    }, [ready, forceAttempt, run]);

    const retry = useCallback(() => {
        try {
            sessionStorage.removeItem(SESSION_GUARD);
        } catch {
            /* private mode */
        }
        startedRef.current = true; // effect already fired; drive run() directly
        setPhase('starting');
        setMessage(null);
        void run();
    }, [run]);

    if (phase === 'error') {
        return (
            <main className="min-h-screen grid place-items-center bg-surface dark:bg-surface-dark px-6">
                <div className="max-w-md text-center space-y-4">
                    <h1 className="text-lg font-semibold text-text dark:text-text-dark">
                        Let’s get you started
                    </h1>
                    <p className="text-sm text-text/60 dark:text-text-dark/60">{message}</p>
                    <div className="flex items-center justify-center gap-3">
                        <button
                            type="button"
                            onClick={retry}
                            className="px-4 py-2 rounded-md text-sm bg-text text-white dark:bg-white dark:text-black"
                        >
                            Try again
                        </button>
                        <Link
                            href={ROUTES.AUTH_REGISTER}
                            className="px-4 py-2 rounded-md text-sm border border-border dark:border-border-dark text-text dark:text-text-dark"
                        >
                            Sign up
                        </Link>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="min-h-screen grid place-items-center bg-surface dark:bg-surface-dark">
            <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-text dark:border-border-dark dark:border-t-white" />
                <p className="text-sm text-text/60 dark:text-text-dark/60">Setting up your workspace…</p>
            </div>
        </main>
    );
}
