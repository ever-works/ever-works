import { getLocale, getTranslations } from 'next-intl/server';
import { fleetAPI, type FleetNeedsALookResult } from '@/lib/api/fleet';
import { fetchFleetNodeNeedsALookAction } from '@/app/actions/settings/fleet';
import { formatBytes } from '@/components/dashboard/runner-status.shared';
import type { FleetComputerTabProps } from '../../registry';
import { NeedsALookList } from '../../overview/NeedsALookList';
import { FleetOverviewBlocks } from '../../overview/FleetOverviewBlocks';
import { absoluteTime } from '../../fleet-hub.shared';

/** Message keys of the node kinds (camelCase leaves, CONTRACTS §11.4). */
const KIND_KEYS = { 'desktop-node': 'desktopNode', node: 'node', k8s: 'k8s' } as const;

/**
 * Fleet hub (FL-01, spec §2 "ONE COMPUTER") — a computer's Overview tab: what
 * needs a look on THIS computer, the Overview blocks other epics register for
 * a computer (FL-03's health metrics, FL-04's sessions, FL-10's servers,
 * FL-16's "runs here", FL-18's runners), and the facts the registry already
 * knows. A server component: the needs-a-look read happens before paint and
 * fails on its own.
 */
export default async function OverviewTab({ node, flags }: FleetComputerTabProps) {
    const t = await getTranslations('fleet.computer.overview');
    const locale = await getLocale();
    let look: FleetNeedsALookResult | null = null;
    let lookError: string | null = null;
    try {
        look = await fleetAPI.nodeNeedsALook(node.id);
    } catch (error) {
        lookError = error instanceof Error ? error.message : 'failed';
    }

    const facts: Array<[string, string]> = [
        [t('facts.kind'), t(`kinds.${KIND_KEYS[node.kind]}`)],
        [t('facts.platform'), node.platform ?? t('facts.unknown')],
        [t('facts.version'), node.version ?? t('facts.unknown')],
        [t('facts.cli'), node.cliVersion ?? t('facts.unknown')],
        [t('facts.diskFree'), formatBytes(node.diskFreeBytes) ?? t('facts.unknown')],
        [
            t('facts.capabilities'),
            node.capabilities.length > 0 ? node.capabilities.join(', ') : t('facts.none'),
        ],
        [t('facts.enrolled'), absoluteTime(node.createdAt, locale) ?? t('facts.unknown')],
    ];

    return (
        <div className="space-y-8" data-testid="fleet-computer-overview">
            <NeedsALookList
                initial={look}
                initialError={lookError}
                nodes={[{ id: node.id, name: node.name }]}
                scope="computer"
                reload={fetchFleetNodeNeedsALookAction.bind(null, node.id)}
            />
            <FleetOverviewBlocks surface="computer" nodes={[node]} flags={flags} />
            <section aria-labelledby="fleet-computer-facts-heading" className="space-y-2">
                <h2
                    id="fleet-computer-facts-heading"
                    className="text-xs font-semibold uppercase tracking-wide text-text-muted dark:text-text-muted-dark"
                >
                    {t('facts.heading')}
                </h2>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border dark:border-border-dark p-4 text-sm">
                    {facts.map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-4 min-w-0">
                            <dt className="text-text-muted dark:text-text-muted-dark shrink-0">
                                {label}
                            </dt>
                            <dd
                                className="text-text dark:text-text-dark truncate text-right"
                                title={value}
                            >
                                {value}
                            </dd>
                        </div>
                    ))}
                </dl>
            </section>
        </div>
    );
}
