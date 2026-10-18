import type { FleetNodeView } from '@ever-works/contracts';
import type { FleetConsentsRead } from './registry';

/**
 * Fleet hub (FL-01) — which consents a computer reports, as far as this
 * build can tell (CONTRACTS §1.1).
 *
 * The heartbeat's `consents` object arrives with FL-02 (`FleetNodeView.consents`
 * there). Until a node reports it — an older node, or FL-02 not on this
 * deployment yet — the answer is read from the capability tags the node
 * already advertises: `attended` for `--attend` and `managed` for
 * `--manage`; `--work` from the worker reporting a state at all (a node
 * started without `--work` runs no worker and reports none). Unknown is
 * never read as granted, so a tab shows the command to run rather than a
 * view the machine would refuse.
 *
 * Seam: when FL-02's `effectiveConsents` lands on `develop`, this delegates
 * to it.
 */
export function readNodeConsents(
    node: Pick<FleetNodeView, 'capabilities' | 'workerState'> & { consents?: unknown },
): FleetConsentsRead {
    const reported = node.consents;
    if (reported && typeof reported === 'object' && !Array.isArray(reported)) {
        const value = reported as Record<string, unknown>;
        return {
            work: value.work === true,
            attend: value.attend === true,
            manage: value.manage === true,
        };
    }
    const tags = new Set(node.capabilities ?? []);
    return {
        work: node.workerState !== null && node.workerState !== undefined,
        attend: tags.has('attended'),
        manage: tags.has('managed'),
    };
}
