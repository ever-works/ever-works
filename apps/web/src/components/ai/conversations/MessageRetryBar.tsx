'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, Paperclip, RotateCw } from 'lucide-react';
import { MAX_CONVERSATION_BODY_BYTES } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type { OutboxFailureCode } from '@/lib/hooks/use-conversation-outbox';

/** Size in the unit the person reads — KB, rounded up so 16.2 KB never reads as "16 of 16". */
export function formatKilobytes(bytes: number): string {
    return `${Math.ceil(bytes / 1024)} KB`;
}

/** The i18n key (under `dashboard.aiChat.sendFailure`) that explains a failure (FR-42, FR-46). */
export type SendFailureMessageKey =
    | 'rateLimited'
    | 'offline'
    | 'network'
    | 'secretDetected'
    | 'tooLong'
    | 'capacityLimited'
    | 'budgetRefused'
    | 'forbidden'
    | 'providerUnavailable';

export function failureMessageKey(code: OutboxFailureCode | null): SendFailureMessageKey {
    switch (code) {
        case 'rate_limited':
            return 'rateLimited';
        case 'offline':
            return 'offline';
        case 'network':
            return 'network';
        case 'secret_detected':
            return 'secretDetected';
        case 'too_large':
            return 'tooLong';
        case 'capacity_limited':
            return 'capacityLimited';
        case 'budget_exceeded':
            return 'budgetRefused';
        case 'forbidden':
            return 'forbidden';
        case 'provider_unavailable':
        default:
            return 'providerUnavailable';
    }
}

export interface MessageRetryBarProps {
    failureCode: OutboxFailureCode | null;
    /** The Agent a budget refusal names, and whose caps "Open caps" opens. */
    agentName: string;
    agentId?: string | null;
    /** Measured body size, for the too-long line. */
    size?: number;
    max?: number;
    /** A Retry is on its way — the row reads "Sending…" and both actions wait. */
    sending?: boolean;
    onRetry: () => void;
    onDiscard: () => void;
    /** Offered for a body too long to send: attach it as a file instead (FR-37). */
    onAttachInstead?: () => void;
}

const actionClass = cn(
    'inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium',
    'border-border dark:border-white/15 text-text-secondary dark:text-text-secondary-dark',
    'hover:bg-surface-secondary dark:hover:bg-white/5 transition-colors',
);

/**
 * The line under a message that did not send: why, in plain language, and
 * Retry / Discard (FR-42..FR-46). Nothing here retries on its own. A budget
 * refusal also links to the caps that stopped the reply (spec §6.11).
 */
export function MessageRetryBar({
    failureCode,
    agentName,
    agentId,
    size,
    max = MAX_CONVERSATION_BODY_BYTES,
    sending = false,
    onRetry,
    onDiscard,
    onAttachInstead,
}: MessageRetryBarProps) {
    const t = useTranslations('dashboard.aiChat.sendFailure');

    if (sending) {
        return (
            <div
                role="status"
                data-testid="conversation-message-sending"
                className="mt-1 flex items-center gap-1.5 text-[11px] text-text-muted dark:text-text-muted-dark"
            >
                <RotateCw className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t('sending')}
            </div>
        );
    }

    const key = failureMessageKey(failureCode);
    const line =
        key === 'tooLong'
            ? t('tooLong', { size: formatKilobytes(size ?? max), max: formatKilobytes(max) })
            : key === 'budgetRefused'
              ? t('budgetRefused', { agent: agentName })
              : t(key);

    return (
        <div
            role="alert"
            data-testid="conversation-message-failed"
            data-failure-code={failureCode ?? 'unknown'}
            className="mt-1 flex flex-col items-end gap-1.5"
        >
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-danger">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{line}</span>
            </p>
            <div className="flex items-center gap-2">
                {key === 'budgetRefused' && (
                    <Link
                        href={
                            agentId
                                ? ROUTES.DASHBOARD_AGENT_BUDGETS(agentId)
                                : ROUTES.DASHBOARD_AGENTS
                        }
                        className="text-[11px] font-medium text-primary hover:underline"
                    >
                        {t('openCaps')}
                    </Link>
                )}
                {key === 'tooLong' && onAttachInstead && (
                    <button type="button" onClick={onAttachInstead} className={actionClass}>
                        <Paperclip className="h-3 w-3" aria-hidden="true" />
                        {t('attachInstead')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onRetry}
                    onKeyDown={(event) => {
                        // Ctrl/Cmd+Enter on the failed message retries it (spec §6.12).
                        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault();
                            onRetry();
                        }
                    }}
                    className={cn(actionClass, 'text-text dark:text-white')}
                >
                    {t('retry')}
                </button>
                <button type="button" onClick={onDiscard} className={actionClass}>
                    {t('discard')}
                </button>
            </div>
        </div>
    );
}
