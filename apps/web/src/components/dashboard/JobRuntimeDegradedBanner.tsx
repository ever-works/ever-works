'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, X } from 'lucide-react';

const DISMISS_KEY = 'ew-job-runtime-banner-dismissed';

/**
 * Loud-degradation banner: shown when the API's health reports that NO
 * background job runtime is configured (`job_runtime.configured=false`),
 * which means Agent runs silently cannot execute — the worst failure
 * mode of a local install. Dismissible per browser via localStorage;
 * `configured === null` (health unreachable/unparseable) renders
 * nothing — this banner reports a KNOWN misconfiguration, it does not
 * speculate.
 *
 * Same hydration-gating pattern as the header onboarding badge: render
 * nothing until localStorage has been consulted so previously-dismissed
 * users never see a one-frame flash.
 */
export function JobRuntimeDegradedBanner({ configured }: { configured: boolean | null }) {
    const t = useTranslations('dashboard.jobRuntimeBanner');
    const [dismissed, setDismissed] = useState(true);

    useEffect(() => {
        try {
            setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1');
        } catch {
            // localStorage unavailable (private mode, quota) — show the
            // banner; a misconfigured install matters more than a flash.
            setDismissed(false);
        }
    }, []);

    if (configured !== false || dismissed) {
        return null;
    }

    const dismiss = () => {
        setDismissed(true);
        try {
            window.localStorage.setItem(DISMISS_KEY, '1');
        } catch {
            // Best-effort persistence; state above already hides it.
        }
    };

    return (
        <div
            role="status"
            data-testid="job-runtime-degraded-banner"
            className="flex items-start gap-3 border-b border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-sm text-amber-900 dark:text-amber-200"
        >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <span className="font-medium">{t('title')}</span>{' '}
                <span className="text-amber-800/90 dark:text-amber-200/80">{t('message')}</span>{' '}
                <a
                    href="https://docs.ever.works/"
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:no-underline"
                >
                    {t('docsLink')}
                </a>
            </div>
            <button
                type="button"
                onClick={dismiss}
                aria-label={t('dismiss')}
                data-testid="job-runtime-banner-dismiss"
                className="shrink-0 rounded p-1 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
                <X className="h-4 w-4" aria-hidden="true" />
            </button>
        </div>
    );
}
