import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { FleetNodeKind, FleetNodeStatus } from '../entities/fleet-node.entity';
import type { FleetNodeView, FleetService } from './fleet.service';

/**
 * Fleet (Wave 12, slice 1) — chat tools for the fleet surface, per the
 * program DoD rule that every new entity ships with chat tools +
 * keyword slots.
 *
 * Mirrors `meetings/agent-meeting-tools.ts`: a descriptor-factory the
 * tool assembly concatenates at run time (type-only import of
 * `TaskToolDescriptor`, so the Tasks runtime graph is NOT pulled into
 * the fleet subpath).
 *
 * Keyword slots: "fleet", "nodes", "machines", "my computers",
 * "execution nodes", "which machines are online" style asks route
 * here.
 */

export interface ListFleetNodesArgs {
    /** Optional kind filter: desktop-node | node | k8s. */
    kind?: string;
    /** Optional status filter: enrolling | online | offline | disabled. */
    status?: string;
    /** Max rows (default 50, capped at 100). */
    limit?: number;
}

const VALID_KINDS: readonly string[] = ['desktop-node', 'node', 'k8s'];
const VALID_STATUSES: readonly string[] = ['enrolling', 'online', 'offline', 'disabled'];

export function buildFleetTools(args: {
    /** Owner scope — tools only ever read this user's nodes. */
    userId: string;
    service: Pick<FleetService, 'listForUser'>;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'list_fleet_nodes',
        description:
            'List the current user’s fleet — the machines enrolled to execute their work (desktop nodes, headless nodes) plus live nodes of their own configured clusters. Each node carries kind, online/offline status, capability tags, platform and last-seen time. Use when the user asks which machines/nodes are available or online.',
        parameters: {
            type: 'object',
            properties: {
                kind: {
                    type: 'string',
                    description: 'Optional kind filter: desktop-node, node or k8s.',
                },
                status: {
                    type: 'string',
                    description: 'Optional status filter: enrolling, online, offline or disabled.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max nodes to return (default 50, capped at 100).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ListFleetNodesArgs;
            const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 100);
            try {
                let nodes = await args.service.listForUser(args.userId);
                if (a.kind && VALID_KINDS.includes(a.kind)) {
                    nodes = nodes.filter((node) => node.kind === (a.kind as FleetNodeKind));
                }
                if (a.status && VALID_STATUSES.includes(a.status)) {
                    nodes = nodes.filter((node) => node.status === (a.status as FleetNodeStatus));
                }
                return { nodes: nodes.slice(0, limit) };
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<ListFleetNodesArgs, { nodes: FleetNodeView[] }>);

    return out;
}
