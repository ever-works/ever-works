'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { resolveHelpTarget, type HelpTarget } from '@/lib/help/help-target';
import { captureHelpEvent, type HelpLinkSurface } from '@/lib/help/help-telemetry';
import { useHelpCenter } from './HelpCenterProvider';

export type HelpLinkVariant = 'emptyState' | 'error';

interface HelpLinkProps {
    /** `<article>` or `<article>#<heading>` — a type error when this build has no such article. */
    target: HelpTarget;
    /** `emptyState` reads "How this works"; `error` reads "Why am I seeing this?" (spec FR-24). */
    variant: HelpLinkVariant;
    /** Surface kind for analytics; defaults from the variant. */
    surface?: HelpLinkSurface;
    className?: string;
}

/**
 * A help link (AW-25, spec FR-20–FR-25): the one way a screen points at the
 * manual. Opens the Help drawer in place at the article and heading — never a
 * navigation, never a new tab — and always reads as a secondary, text-weight
 * control so it never competes with the surface's own call to action.
 *
 * Renders nothing at all when the target does not resolve in this build or
 * when there is no dashboard shell to open Help in (spec FR-22, S-16), so the
 * surface it sits on looks exactly as it did without it.
 */
export function HelpLink({ target, variant, surface, className }: HelpLinkProps) {
    const t = useTranslations('dashboard.helpCenter.link');
    const help = useHelpCenter();
    const resolved = resolveHelpTarget(target);

    useEffect(() => {
        if (!resolved && process.env.NODE_ENV === 'development') {
            console.warn(
                `[help] help link "${target}" does not resolve to an article in this build`,
            );
        }
    }, [resolved, target]);

    if (!resolved || !help) return null;

    return (
        <button
            type="button"
            data-testid="help-link"
            data-help-target={target}
            onClick={() => {
                captureHelpEvent({
                    name: 'help_deep_link_followed',
                    properties: {
                        target,
                        surface:
                            surface ?? (variant === 'emptyState' ? 'empty_state' : 'error_banner'),
                    },
                });
                help.openHelpAt(target);
            }}
            className={cn(
                'inline-flex cursor-pointer items-center text-xs font-normal underline underline-offset-2',
                'text-text-secondary hover:text-text dark:text-text-secondary-dark dark:hover:text-text-dark',
                'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                className,
            )}
        >
            {variant === 'emptyState' ? t('howThisWorks') : t('whyAmISeeingThis')}
        </button>
    );
}
