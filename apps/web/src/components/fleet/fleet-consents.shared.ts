import {
    effectiveConsents,
    normalizeFleetConsents,
    type FleetNodeView,
} from '@ever-works/contracts';
import type { FleetConsentsRead } from './registry';

/**
 * Fleet hub (FL-01) — which consents a computer reports, as far as this
 * build can tell (CONTRACTS §1.1).
 *
 * Delegates to FL-02's `effectiveConsents` (contracts), the one inference the
 * platform and the web share: a node that reported `consents` in its
 * heartbeat is taken at its word; one that never did (a daemon older than
 * FL-02) is read from what it already advertises — `attended` for
 * `--attend`, `--work` from the worker reporting a state at all (a node
 * started without `--work` runs no worker and reports none) — and is never
 * granted `--manage`, which did not exist before the field. Unknown is never
 * read as granted, so a tab shows the command to run rather than a view the
 * machine would refuse.
 */
export function readNodeConsents(
    node: Pick<FleetNodeView, 'capabilities' | 'workerState'> & { consents?: unknown },
): FleetConsentsRead {
    const consents = effectiveConsents({
        consents: node.consents,
        capabilities: node.capabilities ?? [],
        workerState: node.workerState ?? null,
    });
    return { work: consents.work, attend: consents.attend, manage: consents.manage };
}

/**
 * Fleet node link (FL-02) — true when the computer reported its consents
 * itself (a daemon, or desktop shell, with FL-02's heartbeat field), false
 * when {@link readNodeConsents} inferred them.
 */
export function nodeReportedConsents(node: { consents?: unknown }): boolean {
    return normalizeFleetConsents(node.consents) !== null;
}
