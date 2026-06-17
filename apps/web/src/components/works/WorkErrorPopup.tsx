'use client';

import { AlertCircle, AlertTriangle, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ROUTES } from '@/lib/constants';

/** Map a known error message to the most relevant settings page. */
export function getSettingsLink(
    error: string,
    workId: string,
): { label: string; href: string } | null {
    const m = error.toLowerCase();
    if (
        m.includes('ai provider') || m.includes('baseurl') ||
        m.includes('apikey') || m.includes('api key') ||
        m.includes('openai') || m.includes('anthropic')
    ) {
        return { label: 'Configure AI provider', href: ROUTES.DASHBOARD_WORK_PLUGINS(workId) };
    }
    if (
        m.includes('no connected account') || m.includes('provider github') ||
        m.includes('github app') || m.includes('installation')
    ) {
        return { label: 'Connect GitHub', href: ROUTES.DASHBOARD_SETTINGS_GITHUB_APP };
    }
    if (
        m.includes('git provider') || m.includes('git credentials') ||
        m.includes('authentication') || m.includes('unauthorized')
    ) {
        return { label: 'Update Git settings', href: ROUTES.DASHBOARD_WORK_PLUGINS(workId) };
    }
    if (m.includes('quota') || m.includes('budget') || m.includes('limit exceeded')) {
        return { label: 'View usage & budgets', href: ROUTES.DASHBOARD_WORK_SETTINGS_BUDGETS(workId) };
    }
    if (m.includes('configure') || m.includes('settings') || m.includes('plugin') || m.includes('missing')) {
        return { label: 'Go to plugins', href: ROUTES.DASHBOARD_WORK_PLUGINS(workId) };
    }
    return null;
}

interface WorkErrorPopupProps {
    workId: string;
    /** Error message (generation error or config-sync error) */
    message?: string | null;
    /** Warnings list from generateStatus */
    warnings?: string[];
    /** Use warning icon/title instead of error */
    isWarn?: boolean;
}

/**
 * Popup card shown on hover over a work's error/warning status badge.
 * Shared between WorkCard and WorkSwitcher.
 */
export function WorkErrorPopup({ workId, message, warnings, isWarn = false }: WorkErrorPopupProps) {
    const t = useTranslations('dashboard.workCard');
    const settingsLink = message ? getSettingsLink(message, workId) : null;
    const activityHref = ROUTES.DASHBOARD_WORK_ACTIVITY(workId);

    return (
        <div className="w-72 rounded-lg bg-card dark:bg-zinc-950 border border-white/10 shadow-xl p-1">
            {/* Title row */}
            <div className="flex items-center gap-2 px-3 py-2">
                {isWarn
                    ? <AlertTriangle className="w-3.5 h-3.5 text-text-secondary dark:text-zinc-400 shrink-0" />
                    : <AlertCircle className="w-3.5 h-3.5 text-text-secondary dark:text-zinc-400 shrink-0" />
                }
                <span className="text-xs font-semibold text-text dark:text-zinc-200">
                    {isWarn ? t('statusPopup.warningsTitle') : t('statusPopup.errorTitle')}
                </span>
            </div>

            {/* Divider */}
            <div className="mx-3 border-t border-black/5 dark:border-white/10" />

            {/* Message / warnings */}
            <div className="px-3 py-2">
                {message && !isWarn && (
                    <p className="text-[11px] leading-relaxed text-text-secondary dark:text-zinc-400 wrap-break-word">
                        {message}
                    </p>
                )}
                {isWarn && warnings && (
                    <ul className="flex flex-col gap-0.5">
                        {warnings.map((w, i) => (
                            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-text-secondary dark:text-zinc-400">
                                <span className="shrink-0 mt-px">•</span>
                                {w}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Links */}
            <div className="px-3 py-2 flex flex-col gap-1.5">
                {settingsLink && (
                    <a
                        href={settingsLink.href}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline underline-offset-2"
                    >
                        {settingsLink.label}
                        <ArrowRight className="w-3 h-3 shrink-0" />
                    </a>
                )}
                <a
                    href={activityHref}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-[11px] text-text-muted dark:text-zinc-500 hover:underline underline-offset-2"
                >
                    {t('statusPopup.viewDetails')}
                    <ArrowRight className="w-3 h-3 shrink-0" />
                </a>
            </div>
        </div>
    );
}
