import {
    FLEET_FILES_NAME_MAX_LENGTH,
    FLEET_FILES_PATH_MAX_LENGTH,
    isFleetFileName,
    isFleetFileRootId,
    normalizeFleetFileRelativePath,
    type FleetFileEntryView,
    type FleetFileListView,
    type FleetFileRootsResponse,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';

/**
 * Files on computers (FL-11, plan §9, T-15) — the Agent shapes of browsing,
 * under the names CONTRACTS §11.3 fixes. Phase 1 is read-only:
 *
 *  - `fleet_files_roots` — the folders a computer lets Ever Works see (the
 *    root ids the other tools take);
 *  - `fleet_files_list` — the entries of one folder, flagged exactly as a
 *    person sees them (hidden, credential-shaped, links inside or outside the
 *    root) — FR-36;
 *  - `fleet_files_stat` — one entry.
 *
 * No tool downloads a file, and none ever will download a credential-shaped
 * one (FR-17: `permission_denied` for an Agent, no override). Copy, delete and
 * paste arrive in phase 2 as destructive tools behind approvals.
 *
 * The node link lives in the API, which this package must not import, so the
 * reads go through {@link FleetFilesReaderPort} (bound by the API's files
 * module under {@link FLEET_FILES_READER}). Gates (CONTRACTS §2.1): the
 * Agent's own grants are FL-19's (it assembles these tools behind them); the
 * port checks the computer's `files` audience for the Agent's OWNER and audits
 * a listing as `agent:<id>`. Errors are the CONTRACTS §8 envelope
 * `{ error: { code, hint } }`, the same sentences the Files tab shows. The
 * result's size enters the Run's receipt like any tool result (FR-40).
 */

export const FLEET_FILES_ROOTS_TOOL_NAME = 'fleet_files_roots';
export const FLEET_FILES_LIST_TOOL_NAME = 'fleet_files_list';
export const FLEET_FILES_STAT_TOOL_NAME = 'fleet_files_stat';

export const FLEET_FILES_TOOL_ANNOTATIONS = {
    [FLEET_FILES_ROOTS_TOOL_NAME]: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
    [FLEET_FILES_LIST_TOOL_NAME]: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
    [FLEET_FILES_STAT_TOOL_NAME]: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
} as const;

/** Who is asking: the Agent and the person it works for. */
export interface FleetFilesAgentCaller {
    agentId: string;
    ownerUserId: string;
}

/** The API's half: roots, list and stat over the node link, audited as `agent:<id>`. */
export interface FleetFilesReaderPort {
    listRoots(caller: FleetFilesAgentCaller, nodeId: string): Promise<FleetFileRootsResponse>;
    listFiles(
        caller: FleetFilesAgentCaller,
        nodeId: string,
        input: { root: string; path: string; hidden: boolean },
    ): Promise<FleetFileListView>;
    statFile(
        caller: FleetFilesAgentCaller,
        nodeId: string,
        input: { root: string; path: string; name: string },
    ): Promise<FleetFileEntryView>;
}

/** DI token the API binds to its files service. */
export const FLEET_FILES_READER = 'FLEET_FILES_READER' as const;

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

const NODE_ID = { type: 'string', description: 'The computer (its id, from list_fleet_nodes).' };
const ROOT = { type: 'string', description: 'A root id from fleet_files_roots.' };
const PATH = {
    type: 'string',
    description: `A folder under the root, "/"-separated, e.g. "src/server" (empty for the root itself; at most ${FLEET_FILES_PATH_MAX_LENGTH} characters).`,
};

function location(a: {
    nodeId?: unknown;
    root?: unknown;
    path?: unknown;
}): ToolError | { path: string } {
    if (typeof a.nodeId !== 'string' || !UUID.test(a.nodeId)) return toolError('invalid', 'nodeId');
    if (!isFleetFileRootId(a.root))
        return toolError('invalid', 'root — use an id from fleet_files_roots');
    const path = normalizeFleetFileRelativePath(a.path ?? '');
    if (path === null) return toolError('invalid', 'That path leaves its root');
    return { path };
}

export function buildFleetFilesTools(args: {
    agentId: string;
    /** The Agent's owner: the audience check and the audit row are about them. */
    userId: string;
    reader: FleetFilesReaderPort;
}): TaskToolDescriptor[] {
    const caller: FleetFilesAgentCaller = { agentId: args.agentId, ownerUserId: args.userId };
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: FLEET_FILES_ROOTS_TOOL_NAME,
        description:
            "List the folders one of the user's computers lets Ever Works see: its checkouts, the node's workspace folder and any folder its owner shared with --files-root (never the home directory unless shared). Each has an id to pass to fleet_files_list. Read-only; needs the computer to run with --manage.",
        parameters: { type: 'object', properties: { nodeId: NODE_ID }, required: ['nodeId'] },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown };
            if (typeof a.nodeId !== 'string' || !UUID.test(a.nodeId))
                return toolError('invalid', 'nodeId');
            try {
                return await args.reader.listRoots(caller, a.nodeId);
            } catch (err) {
                return refusal(err);
            }
        },
    } satisfies TaskToolDescriptor);

    out.push({
        name: FLEET_FILES_LIST_TOOL_NAME,
        description:
            "List one folder on one of the user's computers, inside a shared root: each entry's name, kind (file, folder, link, other), size and modification time, whether it is hidden, whether its name looks like a credential file, and for links whether they stay inside the root. At most 5 000 entries. Read-only; it never reads a file's contents.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: NODE_ID,
                root: ROOT,
                path: PATH,
                hidden: {
                    type: 'boolean',
                    description: 'Include hidden entries (names starting with a dot).',
                },
            },
            required: ['nodeId', 'root'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as {
                nodeId?: unknown;
                root?: unknown;
                path?: unknown;
                hidden?: unknown;
            };
            const where = location(a);
            if ('error' in where) return where;
            try {
                return await args.reader.listFiles(caller, a.nodeId as string, {
                    root: a.root as string,
                    path: where.path,
                    hidden: a.hidden === true,
                });
            } catch (err) {
                return refusal(err);
            }
        },
    } satisfies TaskToolDescriptor);

    out.push({
        name: FLEET_FILES_STAT_TOOL_NAME,
        description:
            "Describe one entry of a folder on one of the user's computers (kind, size, modification time and the same flags fleet_files_list gives). Read-only.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: NODE_ID,
                root: ROOT,
                path: PATH,
                name: {
                    type: 'string',
                    description: `The entry's name inside the folder (at most ${FLEET_FILES_NAME_MAX_LENGTH} characters).`,
                },
            },
            required: ['nodeId', 'root', 'name'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as {
                nodeId?: unknown;
                root?: unknown;
                path?: unknown;
                name?: unknown;
            };
            const where = location(a);
            if ('error' in where) return where;
            if (!isFleetFileName(a.name)) return toolError('invalid', 'That path leaves its root');
            try {
                return await args.reader.statFile(caller, a.nodeId as string, {
                    root: a.root as string,
                    path: where.path,
                    name: a.name,
                });
            } catch (err) {
                return refusal(err);
            }
        },
    } satisfies TaskToolDescriptor);

    return out;
}
