import {
    FLEET_FILES_NAME_MAX_LENGTH,
    FLEET_FILES_PATH_MAX_LENGTH,
    isFleetFileName,
    isFleetFileRootId,
    normalizeFleetFileRelativePath,
    type FleetFileConflictView,
    type FleetFileEntryView,
    type FleetFileListView,
    type FleetFileRootsResponse,
} from '@ever-works/contracts';
import type { AgentProposalToolSource } from '../../agents/agent-domain-tool-sources';
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
 * one (FR-17: `permission_denied` for an Agent, no override).
 *
 * Phase 2 adds the two acts, both DESTRUCTIVE and both HELD as an Approval in
 * the owner's My Decisions (the Agent Action Approval Queue, CONTRACTS R-33)
 * — an Agent never moves or removes a file by itself:
 *
 *  - `fleet_files_copy` — class `confirm` (FR-37): the same-name entries at
 *    the destination are listed in the result first (when the port can read
 *    them); without `replace: true` they are skipped, with it they are
 *    replaced. A person's approval runs exactly the copy held, through the
 *    platform (the two computers never connect);
 *  - `fleet_files_delete` — class `confirm-destructive` (FR-38): held with the
 *    entries; it runs on the owner's approval, never on a name the Agent
 *    typed (a `confirmName` argument is ignored).
 *
 * `fleet_desktop_paste` is not offered: an Agent cannot hold control of a
 * desktop view yet (the desktop epic), and paste follows control (FR-39).
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
export const FLEET_FILES_COPY_TOOL_NAME = 'fleet_files_copy';
export const FLEET_FILES_DELETE_TOOL_NAME = 'fleet_files_delete';

/** The platform-written `payload.kind` of a held Agent copy / delete (the API's listener runs it on approval). */
export const FLEET_FILES_COPY_PROPOSAL_KIND = 'fleet-files-copy' as const;
export const FLEET_FILES_DELETE_PROPOSAL_KIND = 'fleet-files-delete' as const;

/** What a held copy stores, so a person's approval runs exactly it. */
export interface FleetFilesCopyProposalPayload {
    kind: typeof FLEET_FILES_COPY_PROPOSAL_KIND;
    agentId: string;
    from: { nodeId: string; root: string; path: string; entries: string[] };
    to: { nodeId: string; root: string; path: string };
    replace: boolean;
}

/** What a held delete stores. */
export interface FleetFilesDeleteProposalPayload {
    kind: typeof FLEET_FILES_DELETE_PROPOSAL_KIND;
    agentId: string;
    nodeId: string;
    root: string;
    path: string;
    entries: string[];
}

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
    [FLEET_FILES_COPY_TOOL_NAME]: { destructive: true, confirmationClass: 'confirm' },
    [FLEET_FILES_DELETE_TOOL_NAME]: { destructive: true, confirmationClass: 'confirm-destructive' },
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
    /** P2: the same-name entries a copy would meet (read-only; may be refused for an Agent). */
    listConflicts?(
        caller: FleetFilesAgentCaller,
        nodeId: string,
        input: { root: string; path: string; names: string[] },
    ): Promise<FleetFileConflictView[]>;
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

const NODE_ID = {
    type: 'string',
    description: 'The computer (its id, from list_fleet_nodes).',
} as const;
const ROOT = { type: 'string', description: 'A root id from fleet_files_roots.' } as const;
const PATH = {
    type: 'string',
    description: `A folder under the root, "/"-separated, e.g. "src/server" (empty for the root itself; at most ${FLEET_FILES_PATH_MAX_LENGTH} characters).`,
} as const;
/** fleet_files_copy's destination: a nested object schema, hoisted like the schedule tools' CADENCE_SCHEMA. */
const COPY_TO = {
    type: 'object',
    description:
        'Where to copy to: the destination computer, one of its roots and a folder under it.',
    properties: {
        nodeId: { type: 'string', description: 'The destination computer.' },
        root: {
            type: 'string',
            description: 'A root id of the destination (its fleet_files_roots).',
        },
        path: PATH,
    },
    required: ['nodeId', 'root'],
} as const;

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

/** Plain names of the folder, 1–5 000, or the refusal. */
function entriesOf(value: unknown): string[] | ToolError {
    if (!Array.isArray(value) || value.length === 0)
        return toolError('invalid', 'entries — name at least one item');
    if (value.length > 5000) return toolError('limit_exceeded', 'Select fewer than 5,000 items');
    if (!value.every(isFleetFileName)) return toolError('invalid', 'That path leaves its root');
    return [...new Set(value as string[])];
}

export function buildFleetFilesTools(args: {
    agentId: string;
    /** The Agent's owner: the audience check and the audit row are about them. */
    userId: string;
    reader: FleetFilesReaderPort;
    /** P2: the Run the held acts belong to. */
    runId?: string | null;
    /** P2: the approval seam; null or absent = copy and delete are not offered (fail closed). */
    proposals?: AgentProposalToolSource | null;
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

    const proposals = args.proposals ?? null;
    if (!proposals) return out;

    out.push({
        name: FLEET_FILES_COPY_TOOL_NAME,
        description:
            "Copy files or folders from one of the user's computers to another (or to another folder), through Ever Works — the two computers never connect. Same-name entries at the destination are listed first and skipped unless replace is true. Held for the owner's approval in My Decisions; it runs when they approve. Credential-shaped files are never copied by an Agent.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: { ...NODE_ID, description: 'The source computer.' },
                root: ROOT,
                path: PATH,
                entries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Names of files or folders in that folder.',
                },
                to: COPY_TO,
                replace: {
                    type: 'boolean',
                    description:
                        'Replace same-name entries at the destination (default: skip them).',
                },
            },
            required: ['nodeId', 'root', 'entries', 'to'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as {
                nodeId?: unknown;
                root?: unknown;
                path?: unknown;
                entries?: unknown;
                to?: { nodeId?: unknown; root?: unknown; path?: unknown };
                replace?: unknown;
            };
            const from = location(a);
            if ('error' in from) return from;
            const to = location(a.to ?? {});
            if ('error' in to) return to;
            const entries = entriesOf(a.entries);
            if (!Array.isArray(entries)) return entries;
            const fromNode = a.nodeId as string;
            const toNode = (a.to?.nodeId as string) ?? '';
            if (fromNode === toNode && a.root === a.to?.root && from.path === to.path) {
                return toolError('invalid', 'Source and destination are the same folder');
            }
            let conflicts: FleetFileConflictView[] | null = null;
            if (args.reader.listConflicts) {
                conflicts = await args.reader
                    .listConflicts(caller, toNode, {
                        root: a.to?.root as string,
                        path: to.path,
                        names: entries,
                    })
                    .catch(() => null);
            }
            const payload: FleetFilesCopyProposalPayload = {
                kind: FLEET_FILES_COPY_PROPOSAL_KIND,
                agentId: args.agentId,
                from: { nodeId: fromNode, root: a.root as string, path: from.path, entries },
                to: { nodeId: toNode, root: a.to?.root as string, path: to.path },
                replace: a.replace === true,
            };
            try {
                const proposal = await proposals.propose(args.userId, {
                    agentId: args.agentId,
                    runId: args.runId ?? null,
                    title: (
                        'Copy ' +
                        (entries.length === 1 ? entries[0] : entries.length + ' items') +
                        ' to another computer'
                    ).slice(0, 200),
                    payload: { ...payload },
                    subjectKey: null,
                });
                return {
                    held: true,
                    proposalId: proposal.id,
                    status: proposal.status,
                    conflicts,
                    replace: payload.replace,
                    hint:
                        conflicts && conflicts.length > 0 && !payload.replace
                            ? 'held for the owner’s approval; the same-name entries listed are skipped (call again with replace: true to replace them)'
                            : 'held for the owner’s approval in My Decisions; it runs when they approve it',
                };
            } catch (err) {
                return refusal(err);
            }
        },
    } satisfies TaskToolDescriptor);

    out.push({
        name: FLEET_FILES_DELETE_TOOL_NAME,
        description:
            "Delete files or folders in one folder of one of the user's computers. Always held for the owner's approval in My Decisions (it cannot be undone); it runs only when they approve, never on the Agent's own say-so. A link is removed, never its target.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: NODE_ID,
                root: ROOT,
                path: PATH,
                entries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Names in that folder to delete.',
                },
            },
            required: ['nodeId', 'root', 'entries'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as {
                nodeId?: unknown;
                root?: unknown;
                path?: unknown;
                entries?: unknown;
            };
            const where = location(a);
            if ('error' in where) return where;
            const entries = entriesOf(a.entries);
            if (!Array.isArray(entries)) return entries;
            const payload: FleetFilesDeleteProposalPayload = {
                kind: FLEET_FILES_DELETE_PROPOSAL_KIND,
                agentId: args.agentId,
                nodeId: a.nodeId as string,
                root: a.root as string,
                path: where.path,
                entries,
            };
            try {
                const proposal = await proposals.propose(args.userId, {
                    agentId: args.agentId,
                    runId: args.runId ?? null,
                    title: (
                        'Delete ' +
                        (entries.length === 1 ? entries[0] : entries.length + ' items') +
                        (where.path ? ' from ' + where.path : '')
                    ).slice(0, 200),
                    payload: { ...payload },
                    subjectKey: null,
                });
                return {
                    held: true,
                    proposalId: proposal.id,
                    status: proposal.status,
                    hint: 'held for the owner’s approval in My Decisions; nothing is deleted until they approve it',
                };
            } catch (err) {
                return refusal(err);
            }
        },
    } satisfies TaskToolDescriptor);

    return out;
}
