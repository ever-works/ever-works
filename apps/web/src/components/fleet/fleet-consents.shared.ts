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

/**
 * Fleet node link (FL-02 T-26, CONTRACTS R-10) — true when a desktop-app
 * computer runs a build with the consents wiring (wizard step, tray toggles,
 * the node link): it has opened a link (connected now, or reconnecting), or
 * it reports live viewing or management on. Until then a desktop app cannot
 * give `--attend` / `--manage`, and the hub says "not available on this kind
 * of computer yet" instead of a command it would not honour. Such a computer
 * turns a consent on from its tray, never with a command line.
 */
export function desktopHasConsentWiring(node: {
    kind?: string;
    link?: { state?: string } | null;
    consents?: unknown;
}): boolean {
    if (node.kind !== 'desktop-node') return false;
    const state = node.link?.state;
    if (state === 'connected' || state === 'reconnecting') return true;
    const reported = normalizeFleetConsents(node.consents);
    return Boolean(reported && (reported.attend || reported.manage));
}
