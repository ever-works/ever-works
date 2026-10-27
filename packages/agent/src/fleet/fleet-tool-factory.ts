import {
    FLEET_OPERATION_STATES,
    fleetToolAnnotation,
    fleetToolEntry,
    isFleetOperationTerminal,
    isFleetToolName,
    redactSecrets,
    withFleetToolNoCreditsSentence,
    type FleetLinkErrorCode,
    type FleetOperationState,
    type FleetToolErrorBody,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { FleetService } from './fleet.service';
import type {
    FleetOperationsToolPort,
    FleetStatusReaderPort,
    FleetWakeToolPort,
} from './fleet-status';
import { FLEET_NODES_WAKE_TOOL } from './agent-fleet-health-tools';

/**
 * FL-19 (plan §9, T-04/T-05) — the Agent half of the fleet tool catalogue.
 *
 * Two jobs:
 *
 *  1. {@link decorateFleetTools} — every `fleet_*` descriptor a family epic
 *     built (sessions, logs, services, processes, Docker, ports, commands,
 *     checkouts, health) leaves the assembly carrying its catalogue
 *     annotation (spec FR-2), the no-credits sentence (FR-25), results that
 *     passed the secret scanner, and refusals in the CONTRACTS §8 envelope
 *     `{ error: { code, hint, details } }` (FR-5). The legacy
 *     `list_fleet_nodes` is never touched (FR-3).
 *  2. {@link buildFleetCoreTools} — the tools FL-19 owns itself:
 *     `fleet_status`, `fleet_nodes_list`, `fleet_nodes_get`,
 *     `fleet_operations_get`, `fleet_operations_list`. All read-only.
 *
 * The gate (grants → ladder → audience → consent) is not re-implemented here:
 * the run loop's AW-24 safety gate classifies each call by its tool name (the
 * catalogue fills `ENTRY_POINT_CATEGORY`), and every family service checks the
 * computer's audience and consent for the Agent's owner — see
 * `fleet-tool-gate.ts` for the published rule.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deepest a result is walked for redaction (results are small JSON views). */
const REDACT_MAX_DEPTH = 8;

/** Every string in a tool result passes the shared secret scanner (plan §11). */
export function redactFleetToolResult(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return redactSecrets(value).cleaned;
    if (value === null || typeof value !== 'object' || depth >= REDACT_MAX_DEPTH) return value;
    if (Array.isArray(value)) return value.map((item) => redactFleetToolResult(item, depth + 1));
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = redactFleetToolResult(item, depth + 1);
    }
    return out;
}

/** The CONTRACTS §8 code a free-text refusal most likely is. */
function codeFromMessage(message: string): FleetLinkErrorCode {
    const text = message.toLowerCase();
    if (text.includes('not found') || text.includes('no such')) return 'not_found';
    if (text.includes('kill switch') || text.includes('stopped')) return 'kill_switch';
    if (text.includes('consent') || text.includes('--manage') || text.includes('--work'))
        return 'consent_missing';
    if (text.includes('not allowed') || text.includes('forbidden') || text.includes('permission')) {
        return 'permission_denied';
    }
    if (
        text.includes('offline') ||
        text.includes('unreachable') ||
        text.includes('not connected')
    ) {
        return 'unreachable';
    }
    if (text.includes('invalid') || text.includes('must be')) return 'invalid';
    return 'internal';
}

/**
 * A family tool's reply, with a free-text refusal (`{ error: 'message' }`)
 * lifted into the typed envelope. A typed refusal and every result pass
 * through unchanged (apart from redaction, done by the caller).
 */
export function normalizeFleetToolReply(reply: unknown): unknown {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return reply;
    const error = (reply as { error?: unknown }).error;
    if (typeof error !== 'string') return reply;
    const body: FleetToolErrorBody = { code: codeFromMessage(error), hint: error.slice(0, 500) };
    return { ...(reply as Record<string, unknown>), error: body };
}

/** A throw from a family service as the typed envelope (an `HttpException` body, else `internal`). */
export function fleetToolErrorFromThrow(err: unknown): { error: FleetToolErrorBody } {
    const response = (err as { getResponse?: () => unknown } | null)?.getResponse?.();
    const envelope = (
        response as { error?: { code?: unknown; hint?: unknown; details?: unknown } } | null
    )?.error;
    if (envelope && typeof envelope.code === 'string') {
        const body: FleetToolErrorBody = {
            code: envelope.code as FleetLinkErrorCode,
            hint: typeof envelope.hint === 'string' ? envelope.hint : '',
        };
        if (envelope.details && typeof envelope.details === 'object') {
            body.details = envelope.details as Record<string, unknown>;
        }
        return { error: body };
    }
    const status = (err as { getStatus?: () => number } | null)?.getStatus?.();
    const message = err instanceof Error ? err.message : String(err);
    if (status === 404) return { error: { code: 'not_found', hint: 'no such computer' } };
    if (status === 403)
        return { error: { code: 'permission_denied', hint: message.slice(0, 300) } };
    if (status === 400) return { error: { code: 'invalid', hint: message.slice(0, 300) } };
    if (status === 423)
        return { error: { code: 'kill_switch', hint: 'clear it under Settings → Fleet' } };
    return { error: { code: codeFromMessage(message), hint: message.slice(0, 300) } };
}

/**
 * Annotate, describe, redact and type every catalogued `fleet_*` tool
 * (spec FR-2, FR-5, FR-25). A descriptor whose name is not in the catalogue
 * (or is a legacy name) is returned as it is.
 */
export function decorateFleetTools<T extends TaskToolDescriptor>(tools: readonly T[]): T[] {
    return tools.map((tool) => decorateFleetTool(tool));
}

export function decorateFleetTool<T extends TaskToolDescriptor>(tool: T): T {
    if (!isFleetToolName(tool.name)) return tool;
    const entry = fleetToolEntry(tool.name);
    if (!entry) return tool;
    const original = tool.invoke;
    return {
        ...tool,
        description: withFleetToolNoCreditsSentence(tool.description),
        annotations: tool.annotations ?? fleetToolAnnotation(tool.name),
        invoke: async (args: unknown) => {
            let reply: unknown;
            try {
                reply = await original(args);
            } catch (err) {
                return fleetToolErrorFromThrow(err);
            }
            return redactFleetToolResult(normalizeFleetToolReply(reply));
        },
    } as T;
}

// ─── FL-19's own tools ──────────────────────────────────────────────────────

export interface BuildFleetCoreToolsArgs {
    /** The Agent's owner: every read runs as them. */
    userId: string;
    agentId: string;
    service: Pick<FleetService, 'listVisibleForUser' | 'getVisibleForUser'>;
    /** `fleet_status` — unbound (no API status reader), the tool is not offered. */
    status?: FleetStatusReaderPort | null;
    /** `fleet_operations_*` — unbound (no node link), the tools are not offered. */
    operations?: FleetOperationsToolPort | null;
}

export interface FleetNodesListArgs {
    kind?: string;
    status?: string;
    /** `own` (my computers) or `visible` (also those shared with me through an Organization). Default visible. */
    scope?: string;
    limit?: number;
}

const NODE_KINDS = ['desktop-node', 'node', 'k8s'];
const NODE_STATUSES = ['enrolling', 'online', 'offline', 'disabled'];

function invalid(field: string, hint: string): { error: FleetToolErrorBody } {
    return { error: { code: 'invalid', hint, details: { field } } };
}

export function buildFleetCoreTools(args: BuildFleetCoreToolsArgs): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    if (args.status) {
        const status = args.status;
        out.push({
            name: 'fleet_status',
            description:
                "How is the user's fleet, in one call: every computer they may see (name, status, platform, consents, CPU / memory / disk, live sessions), what needs a look on them (with the fix for each), whether the fleet kill switch is on, and the server time. Read-only; use it first when asked how the computers are doing.",
            parameters: { type: 'object', properties: {}, required: [] },
            invoke: async () => status.status(args.userId),
        });
    }

    out.push({
        name: 'fleet_nodes_list',
        description:
            "List the user's computers — their own, and (scope visible, the default) those other people share with them through an Organization, each with the user's role on it. Each carries kind, online/offline status, capability tags, platform, consents and last-seen time. Read-only.",
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
                scope: {
                    type: 'string',
                    description: 'own (only my computers) or visible (default: also shared ones).',
                },
                limit: {
                    type: 'integer',
                    description: 'Max computers (default 50, capped at 100).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as FleetNodesListArgs;
            if (a.kind !== undefined && !NODE_KINDS.includes(a.kind))
                return invalid('kind', 'kind is desktop-node, node or k8s');
            if (a.status !== undefined && !NODE_STATUSES.includes(a.status)) {
                return invalid('status', 'status is enrolling, online, offline or disabled');
            }
            if (a.scope !== undefined && a.scope !== 'own' && a.scope !== 'visible') {
                return invalid('scope', 'scope is own or visible');
            }
            const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 100);
            let nodes = await args.service.listVisibleForUser(args.userId);
            if (a.scope === 'own')
                nodes = nodes.filter((node) => (node.viewerRole ?? 'owner') === 'owner');
            if (a.kind) nodes = nodes.filter((node) => node.kind === a.kind);
            if (a.status) nodes = nodes.filter((node) => node.status === a.status);
            return { nodes: nodes.slice(0, limit), total: nodes.length };
        },
    });

    out.push({
        name: 'fleet_nodes_get',
        description:
            "One of the user's computers by id: status, platform, version, capability tags, consents, its last health snapshot and the user's role on it. A computer the user may not see reads as not_found. Read-only.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: {
                    type: 'string',
                    description: 'The computer (its id, from fleet_nodes_list or fleet_status).',
                },
            },
            required: ['nodeId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown };
            if (typeof a.nodeId !== 'string' || !UUID.test(a.nodeId))
                return invalid('nodeId', 'nodeId must be a computer id');
            const { view, role } = await args.service.getVisibleForUser(args.userId, a.nodeId);
            return { node: view, role };
        },
    });

    if (args.operations) {
        const operations = args.operations;
        out.push({
            name: 'fleet_operations_get',
            description:
                "A long operation on one of the user's computers (started by a tool that answered with an operationId): its state — running, done, failed, cancelled or interrupted — progress, and the result or the error. An interrupted operation never reads done. Read-only; poll it every few seconds while it is running.",
            parameters: {
                type: 'object',
                properties: {
                    operationId: {
                        type: 'string',
                        description: 'The operation id a tool answered with.',
                    },
                },
                required: ['operationId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { operationId?: unknown };
                if (
                    typeof a.operationId !== 'string' ||
                    a.operationId.length === 0 ||
                    a.operationId.length > 100
                ) {
                    return invalid('operationId', 'operationId is the id a tool answered with');
                }
                const view = operations.get(a.operationId, args.userId);
                return { operation: view, finished: isFleetOperationTerminal(view.state) };
            },
        });

        out.push({
            name: 'fleet_operations_list',
            description:
                "The user's recent long operations on their computers (kept one hour after they end), newest first, optionally only one state or one computer. Read-only.",
            parameters: {
                type: 'object',
                properties: {
                    state: {
                        type: 'string',
                        description: 'Optional: running, done, failed, cancelled or interrupted.',
                    },
                    nodeId: { type: 'string', description: 'Optional: only this computer.' },
                    limit: {
                        type: 'integer',
                        description: 'Max operations (default 20, capped at 100).',
                    },
                },
                required: [],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { state?: string; nodeId?: string; limit?: number };
                if (
                    a.state !== undefined &&
                    !(FLEET_OPERATION_STATES as readonly string[]).includes(a.state)
                ) {
                    return invalid(
                        'state',
                        'state is running, done, failed, cancelled or interrupted',
                    );
                }
                if (a.nodeId !== undefined && !UUID.test(a.nodeId))
                    return invalid('nodeId', 'nodeId must be a computer id');
                const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
                const list = operations.listForUser(args.userId, {
                    ...(a.state ? { state: a.state as FleetOperationState } : {}),
                    ...(a.nodeId ? { nodeId: a.nodeId } : {}),
                    limit,
                });
                return { operations: list };
            },
        });
    }

    return out;
}

// ─── FL-19 P2 — the acts (and the FL-15 read) the catalogue binds itself ────

export interface BuildFleetActToolsArgs {
    userId: string;
    agentId: string;
    /** `fleet_nodes_wake` — unbound, not offered. */
    wake?: FleetWakeToolPort | null;
    /** `fleet_operations_cancel` — needs the registry's cancel; unbound, not offered. */
    operations?: FleetOperationsToolPort | null;
}

/**
 * State-changing tools whose rows no family epic assembled for the Agent:
 *
 *  - `fleet_nodes_wake` (FL-03, `machines`, plain) — FL-03's descriptor bound to
 *    the wake route as the Agent's owner;
 *  - `fleet_operations_cancel` (FL-02, plain) — ask the computer to stop an
 *    operation the owner (or this Agent's calls) started.
 *
 * (`fleet_nodes_git_identity_get|set` are FL-15's own tools, `agent-fleet-task-tools.ts`.)
 *
 * Each is held or refused by the AW-24 ladder in the run loop like every
 * catalogued act (`ENTRY_POINT_CATEGORY` classifies it), and decorated at the
 * assembly point like every other fleet tool.
 */
export function buildFleetActTools(args: BuildFleetActToolsArgs): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];
    if (args.wake) {
        const wake = args.wake;
        out.push({
            name: FLEET_NODES_WAKE_TOOL.name,
            description: FLEET_NODES_WAKE_TOOL.description,
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The computer to wake (its id).' },
                },
                required: ['nodeId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { nodeId?: unknown };
                if (typeof a.nodeId !== 'string' || !UUID.test(a.nodeId)) {
                    return invalid('nodeId', 'nodeId must be a computer id');
                }
                return wake.wake(args.userId, a.nodeId);
            },
        });
    }

    const cancel = args.operations?.requestCancel?.bind(args.operations);
    if (cancel) {
        out.push({
            name: 'fleet_operations_cancel',
            description:
                'Ask the computer to stop a long operation that is still running (an operationId a tool answered with). It then reads cancelled; one that already ended is returned as it is. Plain: no confirmation.',
            parameters: {
                type: 'object',
                properties: {
                    operationId: { type: 'string', description: 'The operation to stop.' },
                },
                required: ['operationId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { operationId?: unknown };
                if (
                    typeof a.operationId !== 'string' ||
                    a.operationId.length === 0 ||
                    a.operationId.length > 100
                ) {
                    return invalid('operationId', 'operationId is the id a tool answered with');
                }
                return cancel(a.operationId, args.userId);
            },
        });
    }

    return out;
}
