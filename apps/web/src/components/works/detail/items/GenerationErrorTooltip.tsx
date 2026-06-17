'use client';

import React, { useMemo, useCallback, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle, ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
    getErrorSettingsPath,
    type GenerationErrorCode,
    type GenerationErrorDetail,
} from '@/lib/items/generation-error-codes';
import { HoverPopup } from './HoverPopup';

interface GenerationErrorTooltipProps {
    /** The classified error code */
    errorCode: GenerationErrorCode;
    /**
     * Optional work ID used to build work-specific settings URLs
     * (e.g. `/works/{id}/plugins`).
     */
    workId?: string;
    className?: string;
}

/**
 * Inline error badge with a rich hover/touch popup.
 *
 * Rendered into a React portal so it escapes any overflow:auto/hidden ancestor
 * (including dialog scroll containers). Desktop opens on hover; mobile on tap.
 */
export function GenerationErrorTooltip({
    errorCode,
    workId,
    className,
}: GenerationErrorTooltipProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.workDetail.items.generationErrors');

    const detail = useMemo<GenerationErrorDetail>(() => {
        const settingsPath = getErrorSettingsPath(errorCode, workId);
        switch (errorCode) {
            case 'GIT_PROVIDER_NOT_CONFIGURED':
                return {
                    title: t('GIT_PROVIDER_NOT_CONFIGURED.title'),
                    message: t('GIT_PROVIDER_NOT_CONFIGURED.message'),
                    settingsPath,
                    settingsLabel: t('GIT_PROVIDER_NOT_CONFIGURED.settingsLabel'),
                };
            case 'GIT_AUTH_FAILED':
                return {
                    title: t('GIT_AUTH_FAILED.title'),
                    message: t('GIT_AUTH_FAILED.message'),
                    settingsPath,
                    settingsLabel: t('GIT_AUTH_FAILED.settingsLabel'),
                };
            case 'GIT_REPO_NOT_CONFIGURED':
                return {
                    title: t('GIT_REPO_NOT_CONFIGURED.title'),
                    message: t('GIT_REPO_NOT_CONFIGURED.message'),
                    settingsPath,
                    settingsLabel: settingsPath ? t('GIT_REPO_NOT_CONFIGURED.settingsLabel') : undefined,
                };
            case 'GIT_CLONE_FAILED':
                return {
                    title: t('GIT_CLONE_FAILED.title'),
                    message: t('GIT_CLONE_FAILED.message'),
                    settingsPath,
                    settingsLabel: settingsPath ? t('GIT_CLONE_FAILED.settingsLabel') : undefined,
                };
            case 'GIT_PUSH_FAILED':
                return {
                    title: t('GIT_PUSH_FAILED.title'),
                    message: t('GIT_PUSH_FAILED.message'),
                    settingsPath,
                    settingsLabel: settingsPath ? t('GIT_PUSH_FAILED.settingsLabel') : undefined,
                };
            case 'GIT_BRANCH_FAILED':
                return {
                    title: t('GIT_BRANCH_FAILED.title'),
                    message: t('GIT_BRANCH_FAILED.message'),
                    settingsPath,
                    settingsLabel: settingsPath ? t('GIT_BRANCH_FAILED.settingsLabel') : undefined,
                };
            case 'ITEM_NOT_FOUND':
                return { title: t('ITEM_NOT_FOUND.title'), message: t('ITEM_NOT_FOUND.message') };
            case 'ITEM_ALREADY_EXISTS':
                return { title: t('ITEM_ALREADY_EXISTS.title'), message: t('ITEM_ALREADY_EXISTS.message') };
            case 'AI_PROVIDER_NOT_CONFIGURED':
                return {
                    title: t('AI_PROVIDER_NOT_CONFIGURED.title'),
                    message: t('AI_PROVIDER_NOT_CONFIGURED.message'),
                    settingsPath,
                    settingsLabel: t('AI_PROVIDER_NOT_CONFIGURED.settingsLabel'),
                };
            case 'SCREENSHOT_NOT_CONFIGURED':
                return {
                    title: t('SCREENSHOT_NOT_CONFIGURED.title'),
                    message: t('SCREENSHOT_NOT_CONFIGURED.message'),
                    settingsPath,
                    settingsLabel: t('SCREENSHOT_NOT_CONFIGURED.settingsLabel'),
                };
            case 'RATE_LIMIT_EXCEEDED':
                return { title: t('RATE_LIMIT_EXCEEDED.title'), message: t('RATE_LIMIT_EXCEEDED.message') };
            case 'QUOTA_EXCEEDED':
                return {
                    title: t('QUOTA_EXCEEDED.title'),
                    message: t('QUOTA_EXCEEDED.message'),
                    settingsPath,
                    settingsLabel: t('QUOTA_EXCEEDED.settingsLabel'),
                };
            default:
                return { title: t('GENERIC_ERROR.title'), message: t('GENERIC_ERROR.message') };
        }
    }, [errorCode, workId, t]);

    const handleSettingsClick = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            if (detail.settingsPath) router.push(detail.settingsPath);
        },
        [detail.settingsPath, router],
    );

    return (
        <span className={cn('inline-flex items-center', className)}>
            <HoverPopup
                trigger={(ref, props) => (
                    <button
                        ref={ref as RefObject<HTMLButtonElement>}
                        type="button"
                        {...props}
                        aria-label={`Error details: ${errorCode}`}
                        className={cn(
                            'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
                            'text-xs font-mono font-medium cursor-help select-none',
                            'underline decoration-dotted underline-offset-2',
                            'text-red-700 dark:text-red-400',
                            'bg-red-100 dark:bg-red-900/30',
                            'border border-red-300 dark:border-red-700',
                            'hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500',
                        )}
                    >
                        <AlertCircle className="w-3 h-3 shrink-0" aria-hidden />
                        {errorCode}
                    </button>
                )}
                popupClassName="w-72 rounded-lg shadow-xl p-3 flex flex-col gap-2 bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-800"
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                        <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-px" aria-hidden />
                        <span className="text-sm font-semibold text-red-700 dark:text-red-300 leading-snug">
                            {detail.title}
                        </span>
                    </div>
                </div>

                {/* Description */}
                <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                    {detail.message}
                </p>

                {/* Settings link */}
                {detail.settingsPath && detail.settingsLabel && (
                    <a
                        href={detail.settingsPath}
                        onClick={handleSettingsClick}
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 transition-colors"
                    >
                        {detail.settingsLabel}
                        <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
                    </a>
                )}
            </HoverPopup>
        </span>
    );
}
