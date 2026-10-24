'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { FleetNodeView } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { useMounted } from '@/lib/hooks/use-mounted';
import { absoluteTime, relativeTime } from '../fleet-hub.shared';
import {
    consentFlag,
    consentStartCommand,
    consentsInForce,
    consentsOf,
    linkBytesLabel,
    linkDotFilled,
    linkStateMessageKey,
    linkStateOf,
    missingConsents,
    shouldNameMissingConsent,
} from './link.shared';

/**
 * Fleet node link (FL-02, spec §5.1, FR-28, FR-41, FR-42) — the line under a
 * computer's header that says what its link is doing, as the platform's own
 * socket sees it:
 *
 *   Link ● connected · work · manage · 12.4 MB this link
 *   Link ○ reconnecting… (last connected 20 seconds ago)
 *   Link ○ not open — this computer only reports health
 *   Link ○ not accepted by this deployment
 *   Link — not available on this kind of computer yet
 *
 * and, while a consent is off, which flag is off with the exact command in
 * its tooltip (the Overview's consents card carries the copy button). Nothing
 * renders when the API reported no link for this view (a build without the
 * link, a cluster row, a computer shared with you). A `status` region (§5.8).
 */
export function LinkLine({ node }: { node: FleetNodeView }) {
    const t = useTranslations('fleet.link');
    const tc = useTranslations('fleet.consents');
    const locale = useLocale();
    const mounted = useMounted();
    const state = linkStateOf(node);
    if (!state || !node.link) return null;

    const consents = consentsOf(node);
    const inForce = consentsInForce(consents);
    const missing = missingConsents(consents);
    const messageKey = linkStateMessageKey(state, consents);
    const since = node.link.since ?? null;
    const ago = state === 'reconnecting' ? relativeTime(since, new Date(), locale) : null;
    const bytes = linkBytesLabel(node.link);
    const nameMissing = shouldNameMissingConsent(state, consents);
    const command = nameMissing ? consentStartCommand(consents, missing) : null;

    return (
        <p
            role="status"
            aria-label={t('regionLabel', { name: node.name })}
            className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted dark:text-text-muted-dark"
            data-testid="fleet-computer-link"
            data-state={state}
        >
            <span className="inline-flex items-center gap-1.5 font-medium text-text dark:text-text-dark">
                {t('label')}
                {state === 'unsupported-kind' ? (
                    <span aria-hidden="true">—</span>
                ) : (
                    <span
                        className={cn(
                            'w-2 h-2 rounded-full border',
                            linkDotFilled(state)
                                ? 'bg-success border-success'
                                : 'bg-transparent border-text-muted dark:border-text-muted-dark',
                        )}
                        aria-hidden="true"
                    />
                )}
            </span>
            <span
                data-testid="fleet-computer-link-state"
                title={
                    state === 'connected' && mounted && since
                        ? t('since', { time: absoluteTime(since, locale) ?? since })
                        : undefined
                }
                suppressHydrationWarning
            >
                {messageKey === 'reconnecting' && ago
                    ? t('states.reconnectingSince', { time: ago })
                    : t(`states.${messageKey}`)}
            </span>
            {state === 'connected' &&
                inForce.map((key) => (
                    <span key={key} className="inline-flex items-center gap-2">
                        <span aria-hidden="true">·</span>
                        <span data-testid={`fleet-computer-link-consent-${key}`}>
                            {tc(`short.${key}`)}
                        </span>
                    </span>
                ))}
            {state === 'connected' && bytes && (
                <>
                    <span aria-hidden="true">·</span>
                    <span data-testid="fleet-computer-link-bytes">{t('bytes', { bytes })}</span>
                </>
            )}
            {nameMissing && command && (
                <>
                    <span aria-hidden="true">·</span>
                    <span
                        data-testid="fleet-computer-link-missing"
                        title={t('missingTooltip', { name: node.name, command })}
                    >
                        {t('missing', { flags: missing.map(consentFlag).join(' ') })}
                        <span className="sr-only">
                            {` — ${t('missingTooltip', { name: node.name, command })}`}
                        </span>
                    </span>
                </>
            )}
        </p>
    );
}
