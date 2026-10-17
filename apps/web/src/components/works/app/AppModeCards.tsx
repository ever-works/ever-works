'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { AppModeAvailability, AppRepositoryMode } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { isAppSourceReasonCode } from '@ever-works/contracts';
import type { AppSourceReasonParams } from '@/lib/work-kinds/app-source-reasons';

/** The order the three cards render in (spec §6.2's drawing: Fork, Private copy, Link). */
export const APP_MODE_CARD_ORDER: readonly AppRepositoryMode[] = ['fork', 'private-copy', 'link'];

export interface AppModeCardsProps {
    modes: Record<AppRepositoryMode, AppModeAvailability>;
    value: AppRepositoryMode | null;
    onChange: (mode: AppRepositoryMode) => void;
    /** Every placeholder a reason's copy may interpolate. */
    reasonParams: AppSourceReasonParams;
    /** The pasted repository is the member's own fork (spec §6.2 "Link (on own fork)"). */
    ownFork?: boolean;
    disabled?: boolean;
}

/**
 * APW-01 T22 — the Link / Fork / Private copy cards (spec §6.2, §6.6).
 *
 * A radio group: an unavailable mode is rendered, disabled, with its reason as
 * TEXT (never colour alone) wired to the card through `aria-describedby`, so
 * assistive technology announces why. `↑` / `↓` move between AVAILABLE modes
 * only; a disabled card is skipped but still read out.
 */
export function AppModeCards({
    modes,
    value,
    onChange,
    reasonParams,
    ownFork,
    disabled,
}: AppModeCardsProps) {
    const t = useTranslations('dashboard.workCreation.app');
    const tReason = useTranslations('dashboard.workCreation.app.reasons');
    const refs = useRef<Partial<Record<AppRepositoryMode, HTMLButtonElement | null>>>({});

    const available = APP_MODE_CARD_ORDER.filter((mode) => modes[mode]?.available);

    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: AppRepositoryMode) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (available.length === 0) return;
        const index = available.indexOf(current);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = index === -1 ? 0 : (index + step + available.length) % available.length;
        const next = available[nextIndex];
        onChange(next);
        refs.current[next]?.focus();
    };

    return (
        <div role="radiogroup" aria-label={t('modesTitle')} className="space-y-2">
            <p className="text-sm font-medium text-text dark:text-text-dark">{t('modesTitle')}</p>
            {APP_MODE_CARD_ORDER.map((mode) => {
                const availability = modes[mode] ?? { available: false };
                const isAvailable = availability.available === true;
                const checked = value === mode;
                const reasonCode =
                    !isAvailable && isAppSourceReasonCode(availability.reason)
                        ? availability.reason
                        : null;
                const reasonId = `app-work-mode-${mode}-reason`;
                const title =
                    mode === 'link' && ownFork
                        ? t('modes.link.titleOwnFork')
                        : t(`modes.${mode}.title`);
                return (
                    <button
                        key={mode}
                        ref={(node) => {
                            refs.current[mode] = node;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-disabled={!isAvailable || disabled}
                        aria-describedby={reasonCode ? reasonId : undefined}
                        // Only the selected (or first available) card is in the tab order,
                        // the arrow keys move within the group (WAI-ARIA radio group).
                        tabIndex={checked || (!value && mode === available[0]) ? 0 : -1}
                        data-testid={`app-work-mode-${mode}`}
                        onClick={() => {
                            if (isAvailable && !disabled) onChange(mode);
                        }}
                        onKeyDown={(event) => onKeyDown(event, mode)}
                        className={cn(
                            'w-full text-left rounded-lg border p-3 transition-colors',
                            checked
                                ? 'border-primary bg-primary/5 dark:border-gray-100'
                                : 'border-card-border dark:border-border-secondary-dark',
                            !isAvailable && 'opacity-60 cursor-not-allowed',
                        )}
                    >
                        <span className="flex items-start gap-2">
                            <span
                                aria-hidden="true"
                                className={cn(
                                    'mt-1 h-3 w-3 shrink-0 rounded-full border',
                                    checked ? 'bg-primary border-primary' : 'border-text-muted',
                                )}
                            />
                            <span className="space-y-0.5">
                                <span className="block text-sm font-semibold text-text dark:text-text-dark">
                                    {title}
                                </span>
                                <span className="block text-xs text-text-secondary dark:text-text-secondary-dark">
                                    {t(`modes.${mode}.description`)}
                                </span>
                                {reasonCode && (
                                    <span
                                        id={reasonId}
                                        data-testid={`app-work-mode-${mode}-reason`}
                                        className="block text-xs text-text-muted dark:text-text-muted-dark"
                                    >
                                        {tReason(reasonCode, reasonParams)}
                                    </span>
                                )}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
