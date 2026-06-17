'use client';

import { useState, useCallback } from 'react';
import { AlertCircle, AlertTriangle, ArrowRight, Check, Clipboard } from 'lucide-react';
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

/** Returns a compact relative time string, e.g. "3h ago", "2d ago". */
function relativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface WorkErrorPopupProps {
    workId: string;
    /** Error message (generation error or config-sync error) */
    message?: string | null;
    /** Warnings list from generateStatus */
    warnings?: string[];
    /** Use warning icon/title instead of error */
    isWarn?: boolean;
    /** ISO timestamp of when the error/warning occurred */
    updatedAt?: string | null;
}

/**
 * Popup card shown on hover over a work's error/warning status badge.
 * Shared between WorkCard and WorkSwitcher.
 */
export function WorkErrorPopup({ workId, message, warnings, isWarn = false, updatedAt }: WorkErrorPopupProps) {
    const t = useTranslations('dashboard.workCard');
    const [copied, setCopied] = useState(false);
    const settingsLink = message ? getSettingsLink(message, workId) : null;
    const activityHref = ROUTES.DASHBOARD_WORK_ACTIVITY(workId);

    const handleCopy = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const text = message ?? warnings?.join('\n') ?? '';
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [message, warnings]);

    return (
        <div className="w-72 rounded-lg bg-card dark:bg-zinc-950 border border-white/10 shadow-xl p-1">
            {/* Title row + timestamp */}
            <div className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                    {isWarn
                        ? <AlertTriangle className="w-3.5 h-3.5 text-text-secondary dark:text-zinc-400 shrink-0" />
                        : <AlertCircle className="w-3.5 h-3.5 text-text-secondary dark:text-zinc-400 shrink-0" />
                    }
                    <span className="text-xs font-semibold text-text dark:text-zinc-200 truncate">
                        {isWarn ? t('statusPopup.warningsTitle') : t('statusPopup.errorTitle')}
                    </span>
                </div>
                {updatedAt && (
                    <span className="text-[10px] text-text-muted dark:text-zinc-500 shrink-0">
                        {relativeTime(updatedAt)}
                    </span>
                )}
            </div>

            {/* Divider */}
            <div className="mx-3 border-t border-black/5 dark:border-white/10" />

            {/* Message / warnings + copy button */}
            <div className="px-3 py-2 group relative">
                {message && !isWarn && (
                    <p className="text-[11px] leading-relaxed text-text-secondary dark:text-zinc-400 wrap-break-word pr-6">
                        {message}
                    </p>
                )}
                {isWarn && warnings && (
                    <ul className="flex flex-col gap-0.5 pr-6">
                        {warnings.map((w, i) => (
                            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-text-secondary dark:text-zinc-400">
                                <span className="shrink-0 mt-px">•</span>
                                {w}
                            </li>
                        ))}
                    </ul>
                )}

                {/* Copy button — appears on hover of the message area */}
                <button
                    type="button"
                    onClick={handleCopy}
                    title={copied ? 'Copied!' : 'Copy error'}
                    className="absolute top-2 right-0 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity text-text-muted dark:text-zinc-500 hover:text-text dark:hover:text-zinc-200"
                >
                    {copied
                        ? <Check className="w-3 h-3 text-green-500" />
                        : <Clipboard className="w-3 h-3" />
                    }
                </button>
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
