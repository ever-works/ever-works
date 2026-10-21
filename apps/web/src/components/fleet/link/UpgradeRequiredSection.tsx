'use client';

import { useTranslations } from 'next-intl';
import { ArrowUpCircle } from 'lucide-react';
import type { FleetNodeView } from '@ever-works/contracts';
import { useMounted } from '@/lib/hooks/use-mounted';
import { absoluteTime } from '../fleet-hub.shared';
import { CopyCommand } from './CopyCommand';
import { nodeUpgradeCommand, selfUpdateMessageKey, upgradeCommandRestarts } from './link.shared';

/**
 * Fleet node link (FL-02, T-24, spec §5.4, S11, S12, U16, FR-36 – FR-38) —
 * the "Node version" section of a computer's Settings tab:
 *
 *   build-02 runs ever-works-node 0.2.1. This deployment needs 0.3.0 or newer.
 *   It keeps reporting health but takes no work until it is upgraded.
 *      npm install -g ever-works-node@latest && sudo systemctl restart …   [copy]
 *   Self-update: off on this computer. Start it with --auto-update …
 *
 * The state word ("Upgrade required") is FL-03's state mapping, shown on the
 * card and the header; this section carries the sentence, the exact command
 * for the OS the node reports (copy, never run — only that machine's
 * keyboard, or its own `--auto-update`, can upgrade it), and what its
 * self-update did last: "Self-update failed on build-02 at 09:12 — run the
 * command yourself". A computer at or above the floor gets one line and its
 * self-update state. Nothing for a cluster row.
 */
export function UpgradeRequiredSection({ node }: { node: FleetNodeView }) {
    const t = useTranslations('fleet.upgrade');
    // Instants in the reader's own locale and time zone, once mounted (the
    // server renders the ISO instant). No `useLocale`: the browser's own
    // formatting is what a person reads at that keyboard.
    const mounted = useMounted();
    if (node.kind === 'k8s' || node.persisted === false) return null;

    const required = node.upgradeRequired === true;
    const floor = node.minNodeVersion ?? null;
    const report = node.selfUpdate ?? null;
    const selfUpdateKey = selfUpdateMessageKey(report);
    const failedAt = report?.failedAt ?? null;
    const command = nodeUpgradeCommand(node.platform);
    const headingId = `fleet-upgrade-heading-${node.id}`;

    return (
        <section
            aria-labelledby={headingId}
            className="space-y-2 rounded-lg border border-border dark:border-border-dark p-4"
            data-testid="fleet-upgrade-section"
            data-required={required ? 'true' : 'false'}
        >
            <h2
                id={headingId}
                className="flex items-center gap-2 text-sm font-semibold text-text dark:text-text-dark"
            >
                <ArrowUpCircle
                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
                {t('heading')}
                {required && (
                    <span
                        className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
                        data-testid="fleet-upgrade-required"
                    >
                        {t('required')}
                    </span>
                )}
            </h2>
            <p
                className="text-sm text-text dark:text-text-dark"
                data-testid="fleet-upgrade-version"
            >
                {node.version
                    ? t('runs', { name: node.name, version: node.version })
                    : t('runsUnknown', { name: node.name })}{' '}
                {floor && (required ? t('needs', { floor }) : t('current', { floor }))}
            </p>
            {required && (
                <div className="space-y-1">
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('body')}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('runThis', { name: node.name })}
                    </p>
                    <CopyCommand
                        command={command}
                        label={t('copyLabel')}
                        testId="fleet-upgrade-command"
                    />
                    {!upgradeCommandRestarts(node.platform) && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('thenRestart', { name: node.name })}
                        </p>
                    )}
                </div>
            )}
            <p
                role="status"
                className={
                    selfUpdateKey === 'selfUpdateFailed'
                        ? 'text-xs text-danger'
                        : 'text-xs text-text-muted dark:text-text-muted-dark'
                }
                data-testid="fleet-upgrade-self-update"
                data-state={selfUpdateKey}
                suppressHydrationWarning
            >
                {selfUpdateKey === 'selfUpdateFailed'
                    ? t('selfUpdateFailed', {
                          name: node.name,
                          time: (mounted ? absoluteTime(failedAt) : null) ?? failedAt ?? '',
                      })
                    : t(selfUpdateKey)}
                {selfUpdateKey === 'selfUpdateFailed' && report?.error ? (
                    <span className="block">
                        {t('selfUpdateFailedReason', { error: report.error })}
                    </span>
                ) : null}
            </p>
            {report?.updatedAt && report.fromVersion && selfUpdateKey !== 'selfUpdateFailed' && (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-upgrade-last-update"
                    suppressHydrationWarning
                >
                    {t('updated', {
                        from: report.fromVersion,
                        time: (mounted ? absoluteTime(report.updatedAt) : null) ?? report.updatedAt,
                    })}
                </p>
            )}
        </section>
    );
}
