'use client';

import { useTranslations } from 'next-intl';
import { ShieldAlert } from 'lucide-react';
import type { FleetHelperStatusView, FleetHelperTrust } from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07, FR-17, R-8) — the "Reduced trust" note: the
 * screen helper on this computer is hash-pinned (the owner checked its
 * fingerprint), not signed. Shown on the Desktop tab whenever that is the
 * helper's trust; a signed helper shows nothing (P3, T-44). When this node
 * version publishes a signed helper for the machine (`signedAvailable`), the
 * note says so and names the command that approves it by its signature.
 */
export function DesktopHelperNote({
    nodeName,
    trust,
    helper,
}: {
    nodeName: string;
    trust: FleetHelperTrust;
    helper: FleetHelperStatusView | null;
}) {
    const t = useTranslations('fleet.desktop.helper');
    if (trust !== 'hash-pinned') return null;
    return (
        <p
            className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            data-testid="desktop-reduced-trust"
        >
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span>
                {t('reducedTrust', { name: nodeName })}
                {helper?.fingerprintPrefix
                    ? ` ${t('fingerprint', { prefix: helper.fingerprintPrefix })}`
                    : ''}
                {helper?.published === false ? ` ${t('unpublished')}` : ''}
                {helper?.signedAvailable ? (
                    <>
                        {' '}
                        <span data-testid="desktop-signed-available">
                            {t('signedAvailable')}{' '}
                            <code className="rounded bg-muted px-1 font-mono text-xs">
                                ever-works-node helper admit --signed
                            </code>
                        </span>
                    </>
                ) : null}
            </span>
        </p>
    );
}
