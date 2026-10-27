import {
    FLEET_LOGS_FILTER_MAX_LENGTH,
    FLEET_LOGS_INITIAL_LINES,
    clampFleetLogsLines,
    isFleetLogSourceId,
    type FleetLogSourcesResponse,
    type FleetLogsReadResult,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';

/**
 * Logs on computers (FL-08, plan §9, T-16) — the Agent shapes of logs, under
 * the names CONTRACTS §11.3 fixes:
 *
 *  - `fleet_logs_sources` — read-only: the log sources of one computer
 *    (System, Files, Containers, Services), as the Logs tab lists them.
 *  - `fleet_logs_read` — read-only: up to 500 lines of ONE source, already
 *    secret-scanned on the machine, optionally filtered. It never follows
 *    (an Agent reads at most what a person sees on first open — spec S10),
 *    and a `follow` argument is refused, not ignored.
 *
 * The node link lives in the API, which this package must not import, so the
 * read goes through {@link FleetLogsReaderPort} (bound by the API's logs
 * module under {@link FLEET_LOGS_READER}). Gates (CONTRACTS §2.1): the Agent's
 * own grants are FL-19's (it assembles these tools behind them); the port
 * checks the computer's `logs` audience for the Agent's OWNER and audits the
 * read as `agent:<id>` (FR-31, ACC-FL08-14). Errors are the CONTRACTS §8
 * envelope `{ error: { code, hint } }`. Nothing here spends a model token.
 */

export const FLEET_LOGS_SOURCES_TOOL_NAME = 'fleet_logs_sources';
export const FLEET_LOGS_READ_TOOL_NAME = 'fleet_logs_read';

export const FLEET_LOGS_TOOL_ANNOTATIONS = {
    [FLEET_LOGS_SOURCES_TOOL_NAME]: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
    [FLEET_LOGS_READ_TOOL_NAME]: { readOnly: true, destructive: false, confirmationClass: 'plain' },
} as const;

/** Who is asking: the Agent and the person it works for. */
export interface FleetLogsAgentCaller {
    agentId: string;
    ownerUserId: string;
}

/** The API's half: list and read over the node link, audited as `agent:<id>`. */
export interface FleetLogsReaderPort {
    listSources(caller: FleetLogsAgentCaller, nodeId: string): Promise<FleetLogSourcesResponse>;
    read(
        caller: FleetLogsAgentCaller,
        nodeId: string,
        input: { source: string; lines: number; filter: string | null },
    ): Promise<FleetLogsReadResult>;
}

/** DI token the API binds to its logs service. */
export const FLEET_LOGS_READER = 'FLEET_LOGS_READER' as const;

export interface FleetLogsSourcesArgs {
    nodeId: string;
}

export interface FleetLogsReadArgs {
    nodeId: string;
    source: string;
    lines?: number;
    filter?: string;
    /** Refused: an Agent never follows. */
    follow?: unknown;
}

type ToolError = { error: { code: string; hint: string } };

function toolError(code: string, hint: string): ToolError {
    return { error: { code, hint } };
}

/** A refusal from the port: the CONTRACTS §8 envelope it threw, else a 404/403 by status, else `internal`. */
function refusal(err: unknown): ToolError {
    const response = (err as { getResponse?: () => unknown } | null)?.getResponse?.();
    const envelope = (response as { error?: { code?: unknown; hint?: unknown } } | null)?.error;
    if (envelope && typeof envelope.code === 'string') {
        return toolError(envelope.code, typeof envelope.hint === 'string' ? envelope.hint : '');
    }
    const status = (err as { getStatus?: () => number } | null)?.getStatus?.();
    if (status === 404) return toolError('not_found', 'no such computer');
    if (status === 403)
        return toolError('permission_denied', err instanceof Error ? err.message : 'not allowed');
    return toolError('internal', err instanceof Error ? err.message : String(err));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildFleetLogsTools(args: {
    agentId: string;
    /** The Agent's owner: the audience check and the audit row are about them. */
    userId: string;
    reader: FleetLogsReaderPort;
}): TaskToolDescriptor[] {
    const caller: FleetLogsAgentCaller = { agentId: args.agentId, ownerUserId: args.userId };
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: FLEET_LOGS_SOURCES_TOOL_NAME,
        description:
            "List the log sources of one of the user's computers: its system log (journal, unified log or event logs), log files under the folders it shares, Docker containers and running services (failed ones first). Each source has an id to pass to fleet_logs_read. Read-only; needs the computer to run with --manage.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: {
                    type: 'string',
                    description: 'The computer (its id, from list_fleet_nodes).',
                },
            },
            required: ['nodeId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as FleetLogsSourcesArgs;
            if (typeof a.nodeId !== 'string' || !UUID.test(a.nodeId))
                return toolError('invalid', 'nodeId');
            try {
                return await args.reader.listSources(caller, a.nodeId);
            } catch (err) {
                return refusal(err);
            }
        },
    } satisfies TaskToolDescriptor);

    out.push({
        name: FLEET_LOGS_READ_TOOL_NAME,
        description: `Read the last lines (at most ${FLEET_LOGS_INITIAL_LINES}) of one log source on one of the user's computers — a service's log, a container's, a log file, the system log — to find out why something failed. Lines are secret-scanned on the machine (a secret reads [redacted secret]). Optionally keep only lines containing a text (case-insensitive). Read-only; it never follows a log.`,
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (its id).' },
                source: {
                    type: 'string',
                    description:
                        'The source id from fleet_logs_sources, e.g. service:nginx.service, container:acme-api, file:/var/log/syslog, system:journal.',
                },
                lines: {
                    type: 'integer',
                    description: `How many of the newest lines, 1–${FLEET_LOGS_INITIAL_LINES} (default ${FLEET_LOGS_INITIAL_LINES}).`,
                },
                filter: {
                    type: 'string',
                    description: 'Keep only lines containing this text (case-insensitive).',
                },
            },
            required: ['nodeId', 'source'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as FleetLogsReadArgs;
            if (a.follow !== undefined && a.follow !== false) {
                return toolError('invalid', 'an Agent reads a log once; it cannot follow it');
            }
            if (typeof a.nodeId !== 'string' || !UUID.test(a.nodeId))
                return toolError('invalid', 'nodeId');
            if (!isFleetLogSourceId(a.source)) {
                return toolError(
                    'invalid',
                    "source — use an id from fleet_logs_sources; only files under this computer's shared folders and standard log directories can be read",
                );
            }
            if (
                a.lines !== undefined &&
                (typeof a.lines !== 'number' || a.lines < 1 || a.lines > FLEET_LOGS_INITIAL_LINES)
            ) {
                return toolError('invalid', `lines must be 1–${FLEET_LOGS_INITIAL_LINES}`);
            }
            const filter =
                typeof a.filter === 'string' && a.filter.trim().length > 0
                    ? a.filter.slice(0, FLEET_LOGS_FILTER_MAX_LENGTH)
                    : null;
            try {
                return await args.reader.read(caller, a.nodeId, {
                    source: a.source,
                    lines: clampFleetLogsLines(a.lines),
                    filter,
                });
            } catch (err) {
                return refusal(err);
            }
        },
    } satisfies TaskToolDescriptor);

    return out;
}
