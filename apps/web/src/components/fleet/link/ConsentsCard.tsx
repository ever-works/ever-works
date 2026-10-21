'use client';

import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import type { FleetNodeView } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import type { FleetOverviewBlockProps } from '../registry';
import { desktopHasConsentWiring } from '../fleet-consents.shared';
import { CopyCommand } from './CopyCommand';
import {
    LINK_CONSENT_KEYS,
    consentFlag,
    consentStartCommand,
    consentsOf,
    consentsReported,
    missingConsents,
    type LinkConsentKey,
} from './link.shared';

/**
 * Kinds of computer that cannot give a consent yet (CONTRACTS R-10, spec
 * FR-40): the desktop app has no `--attend` / `--manage` wiring until FL-02's
 * desktop parity; a cluster row has no node at all. Only asked for a consent
 * that is OFF — a consent the computer reports as on is never "cannot".
 */
export function kindCannotGive(
    node: Pick<FleetNodeView, 'kind'> & Partial<Pick<FleetNodeView, 'link' | 'consents'>>,
    key: LinkConsentKey,
): boolean {
    if (node.kind === 'k8s') return true;
    if (node.kind === 'desktop-node') return key !== 'work' && !desktopHasConsentWiring(node);
    return false;
}

/**
 * Fleet node link (FL-02, spec §5.2, S1, S2, U12) — "What build-01 lets Ever
 * Works do", on a computer's Overview: ✔ / ✖ for Run work (`--work`), Live
 * viewing (`--attend`) and Manage (`--manage`), and for each one that is off
 * the exact command that turns it on while keeping the others — copyable,
 * never runnable from here. A computer shared with you names the flag and
 * asks you to ask its owner; a kind of computer that cannot give a consent
 * says so instead of offering a command it would not honour. A daemon older
 * than reported consents is read from what it advertises, and the card says
 * so (`effectiveConsents`). Registered as an Overview block for the computer
 * page (`modules/fl-02-link.ts`).
 */
export default function ConsentsCard({ nodes }: FleetOverviewBlockProps) {
    const t = useTranslations('fleet.consents');
    const node = nodes[0];
    if (!node || node.kind === 'k8s' || node.persisted === false) return null;

    const consents = consentsOf(node);
    const reported = consentsReported(node);
    const missing = missingConsents(consents);
    const owner = node.viewerRole === undefined || node.viewerRole === 'owner';
    const headingId = `fleet-consents-heading-${node.id}`;

    return (
        <section
            aria-labelledby={headingId}
            className="space-y-3 rounded-lg border border-border dark:border-border-dark p-4"
            data-testid="fleet-consents-card"
            data-reported={reported ? 'true' : 'false'}
        >
            <h2
                id={headingId}
                className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
            >
                {t('title', { name: node.name })}
            </h2>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {LINK_CONSENT_KEYS.map((key) => {
                    const granted = consents[key] === true;
                    const Icon = granted ? Check : X;
                    return (
                        <li
                            key={key}
                            className="inline-flex items-center gap-1.5"
                            data-testid={`fleet-consent-${key}`}
                            data-granted={granted ? 'true' : 'false'}
                        >
                            <Icon
                                className={cn(
                                    'w-4 h-4 shrink-0',
                                    granted
                                        ? 'text-success'
                                        : 'text-text-muted dark:text-text-muted-dark',
                                )}
                                aria-hidden="true"
                            />
                            <span className="text-text dark:text-text-dark">{t(key)}</span>
                            <code className="font-mono text-xs text-text-muted dark:text-text-muted-dark">
                                ({consentFlag(key)})
                            </code>
                            <span className="sr-only">
                                {` — ${granted ? t('granted') : t('notGranted')}`}
                            </span>
                        </li>
                    );
                })}
            </ul>
            {!reported && (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-consents-inferred"
                >
                    {t('inferred', { name: node.name })}
                </p>
            )}
            {missing.length === 0 ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('allGranted')}
                </p>
            ) : (
                <div className="space-y-3">
                    {missing.map((key) => {
                        const consent = t(key);
                        if (kindCannotGive(node, key)) {
                            return (
                                <p
                                    key={key}
                                    className="text-xs text-text-muted dark:text-text-muted-dark"
                                    data-testid={`fleet-consent-kind-cannot-${key}`}
                                >
                                    {t('kindCannot', { consent })}
                                </p>
                            );
                        }
                        if (node.kind === 'desktop-node') {
                            // The desktop app turns a consent on from its tray (FL-02 T-26).
                            return (
                                <p
                                    key={key}
                                    className="text-xs text-text-muted dark:text-text-muted-dark"
                                    data-testid={`fleet-consent-tray-${key}`}
                                >
                                    {owner
                                        ? t('trayHint', { consent, name: node.name })
                                        : t('missingHintShared', {
                                              consent,
                                              name: node.name,
                                              flag: consentFlag(key),
                                          })}
                                </p>
                            );
                        }
                        if (!owner) {
                            return (
                                <p
                                    key={key}
                                    className="text-xs text-text-muted dark:text-text-muted-dark"
                                    data-testid={`fleet-consent-ask-owner-${key}`}
                                >
                                    {t('missingHintShared', {
                                        consent,
                                        name: node.name,
                                        flag: consentFlag(key),
                                    })}
                                </p>
                            );
                        }
                        return (
                            <div key={key} className="space-y-1">
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('missingHint', { consent, name: node.name })}
                                </p>
                                <CopyCommand
                                    command={consentStartCommand(consents, key)}
                                    label={t('copyLabel', { consent })}
                                    testId={`fleet-consent-command-${key}`}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
