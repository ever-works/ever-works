import { Injectable, Optional } from '@nestjs/common';
import {
    FleetAuditService,
    FleetNodeRepository,
    FleetService,
    type FleetFilesAgentCaller,
    type FleetFilesReaderPort,
} from '@ever-works/agent/fleet';
import {
    FLEET_FILES_LIST_AUDIT_WINDOW_MS,
    FLEET_FILES_MESSAGES,
    FLEET_FILES_REQUEST_TIMEOUT_MS,
    FLEET_FILES_ROOTS_VERB,
    fleetFileBaseName,
    isFleetFileName,
    normalizeFleetFileRelativePath,
    sanitizeFleetFileConflicts,
    sanitizeFleetFileEntry,
    sanitizeFleetFileRootsResult,
    sanitizeFleetFilesDownloadCheck,
    sanitizeFleetFilesListResult,
    isFleetFileRootId,
    type FleetAuditAction,
    type FleetFileConflictView,
    type FleetFileEntryView,
    type FleetFileListView,
    type FleetFileRootsResponse,
    type FleetFilesDeleteResult,
    type FleetFilesDownloadCheck,
    type FleetLinkReply,
} from '@ever-works/contracts';
import { randomUUID } from 'crypto';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkException, fleetLinkError } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import {
    describeFleetLinkCaller,
    fleetLinkCallerUserId,
    type FleetLinkCaller,
} from '../../fleet-link/fleet-link.types';

/**
 * Files on computers (FL-11, plan §5, T-08/T-10) — the platform's half of
 * browsing: roots, list, stat, conflicts and delete. Transfers live beside it
 * in `FleetFilesTransferService`.
 *
 * Nothing is stored here but `fleet_audit` rows (README §1): entries travel
 * from the machine to the reader and nowhere else.
 *
 * Every path goes through FL-02's authoriser first (`FleetLinkService`) —
 * existence (404), kill switch (`kill_switch`), consent (`consent_missing`
 * naming `--manage`), the `files` family audience (`permission_denied`) —
 * then reachability (`unreachable`). The machine re-checks every path (R-18).
 *
 * **Confirmations** (CONTRACTS §2.2, no tokens): delete is
 * `confirm-destructive` — without `confirmName`, or with one that is not the
 * target's name (the entry's, or the folder's for several), it answers 409
 * `confirmation_required` with the class and what the dialog shows; the
 * caller's audience and consent are checked BEFORE that answer, so a caller
 * who may not act learns nothing about the target.
 *
 * **Audit** (FR-19, CONTRACTS §7): `node.files.list` once per person, computer
 * and root per {@link FLEET_FILES_LIST_AUDIT_WINDOW_MS} (a "visit" — server
 * side, so a client cannot skip it; per API replica, lane log decision 6);
 * `node.files.delete` per delete, refused ones included. Details carry the
 * root, the path, counts and the requester — never contents.
 */

export interface FleetFilesLocation {
    root: string;
    /** A folder under the root, `/`-separated (`''` = the root). */
    path: string;
}

/** A location off a request, normalised; `invalid` when it could leave its root (U4). */
export function parseFleetFilesLocation(root: unknown, path: unknown): FleetFilesLocation {
    if (!isFleetFileRootId(root)) {
        throw fleetLinkError('invalid', 'root — pick one from the roots list', { field: 'root' });
    }
    const normalized = normalizeFleetFileRelativePath(path ?? '');
    if (normalized === null) {
        throw fleetLinkError('invalid', 'That path leaves its root', { field: 'path' });
    }
    return { root, path: normalized };
}

/** Names inside the folder: every one a plain name, or `invalid` naming the field. */
export function parseFleetFilesNames(value: unknown, field: string, max: number): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw fleetLinkError('invalid', `${field} — select at least one item`, { field });
    }
    if (value.length > max) {
        throw fleetLinkError(
            'limit_exceeded',
            `Select fewer than ${max.toLocaleString('en-US')} items`,
            {
                limit: max,
            },
        );
    }
    const names = [...new Set(value)];
    for (const name of names) {
        if (!isFleetFileName(name))
            throw fleetLinkError('invalid', 'That path leaves its root', { field });
    }
    return names as string[];
}

/** A node reply as a result, or the node's own refusal as the same typed error. */
export function replyResult(reply: FleetLinkReply): unknown {
    if ('error' in reply) throw new FleetLinkException(reply.error);
    if ('result' in reply) return reply.result;
    throw fleetLinkError(
        'operation_failed',
        'the computer answered with an operation where a result was expected',
    );
}

@Injectable()
export class FleetFilesService implements FleetFilesReaderPort {
    /** `userId|nodeId|root` → when its last `node.files.list` row was written. */
    private readonly listAudited = new Map<string, number>();

    constructor(
        private readonly fleet: FleetService,
        private readonly nodes: FleetNodeRepository,
        private readonly link: FleetLinkService,
        @Optional() private readonly audit?: FleetAuditService,
    ) {}

    // ─── Roots ─────────────────────────────────────────────────────────────

    async rootsForUser(userId: string, nodeId: string): Promise<FleetFileRootsResponse> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.roots({ kind: 'user', userId }, nodeId);
    }

    async roots(caller: FleetLinkCaller, nodeId: string): Promise<FleetFileRootsResponse> {
        const outcome = await this.link.request({
            nodeId,
            verb: FLEET_FILES_ROOTS_VERB,
            caller,
            requirement: { actionFamily: 'files', stateChanging: false },
            timeoutMs: FLEET_FILES_REQUEST_TIMEOUT_MS,
        });
        if (outcome.operationId !== undefined) {
            throw fleetLinkError(
                'unreachable',
                'the computer did not list its folders in time; try again',
                {
                    nodeId,
                },
            );
        }
        return { nodeId, ...sanitizeFleetFileRootsResult(outcome.result) };
    }

    // ─── One request on a short-lived `files` channel ──────────────────────

    /**
     * Open a `files` channel on `location`, send one request, close it. Read
     * requests open it as not state-changing (no `node.link.channel-open`
     * row — the files audit is the record); the kill switch still refuses
     * the open (the authoriser refuses every act while the fleet is stopped).
     */
    async requestOnce(
        caller: FleetLinkCaller,
        nodeId: string,
        location: FleetFilesLocation,
        type: string,
        params: Record<string, unknown>,
        options: { stateChanging?: boolean; timeoutMs?: number } = {},
    ): Promise<unknown> {
        const channel: FleetLinkChannel = await this.link.openChannel({
            nodeId,
            family: 'files',
            params: { root: location.root, path: location.path },
            caller,
            requirement: {
                actionFamily: 'files',
                stateChanging: options.stateChanging === true,
                target: location.path || '/',
            },
        });
        try {
            const reply = await channel.request(type, params, {
                timeoutMs: options.timeoutMs ?? FLEET_FILES_REQUEST_TIMEOUT_MS,
            });
            return replyResult(reply);
        } finally {
            if (!channel.isClosed) channel.close('normal');
        }
    }

    // ─── List, stat, conflicts ─────────────────────────────────────────────

    async listForUser(
        userId: string,
        nodeId: string,
        input: { root: unknown; path?: unknown; hidden?: boolean },
    ): Promise<FleetFileListView> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.listAs({ kind: 'user', userId }, nodeId, input);
    }

    async listAs(
        caller: FleetLinkCaller,
        nodeId: string,
        input: { root: unknown; path?: unknown; hidden?: boolean },
    ): Promise<FleetFileListView> {
        const location = parseFleetFilesLocation(input.root, input.path);
        const result = sanitizeFleetFilesListResult(
            await this.requestOnce(caller, nodeId, location, FLEET_FILES_MESSAGES.list, {
                hidden: input.hidden === true,
            }),
        );
        await this.auditListOnce(caller, nodeId, location, result.entries.length);
        return { nodeId, root: location.root, path: location.path, ...result };
    }

    async statForUser(
        userId: string,
        nodeId: string,
        input: { root: unknown; path?: unknown; name: unknown },
    ): Promise<FleetFileEntryView> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.statAs({ kind: 'user', userId }, nodeId, input);
    }

    async statAs(
        caller: FleetLinkCaller,
        nodeId: string,
        input: { root: unknown; path?: unknown; name: unknown },
    ): Promise<FleetFileEntryView> {
        const location = parseFleetFilesLocation(input.root, input.path);
        if (!isFleetFileName(input.name)) {
            throw fleetLinkError('invalid', 'That path leaves its root', { field: 'name' });
        }
        const result = (await this.requestOnce(
            caller,
            nodeId,
            location,
            FLEET_FILES_MESSAGES.stat,
            {
                name: input.name,
            },
        )) as { entry?: unknown } | null;
        const entry = sanitizeFleetFileEntry(result?.entry);
        if (!entry) throw fleetLinkError('not_found', `${input.name} is gone`);
        return entry;
    }

    async conflictsForUser(
        userId: string,
        nodeId: string,
        input: { root: unknown; path?: unknown; names: unknown },
    ): Promise<FleetFileConflictView[]> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.conflictsAs({ kind: 'user', userId }, nodeId, input);
    }

    async conflictsAs(
        caller: FleetLinkCaller,
        nodeId: string,
        input: { root: unknown; path?: unknown; names: unknown },
    ): Promise<FleetFileConflictView[]> {
        const location = parseFleetFilesLocation(input.root, input.path);
        const names = parseFleetFilesNames(input.names, 'names', 5000);
        return sanitizeFleetFileConflicts(
            await this.requestOnce(caller, nodeId, location, FLEET_FILES_MESSAGES.conflicts, {
                names,
            }),
        );
    }

    // ─── Download check (FR-16, FR-17 before the browser starts) ───────────

    async checkDownloadForUser(
        userId: string,
        nodeId: string,
        input: { root: unknown; path?: unknown; entries: unknown },
    ): Promise<FleetFilesDownloadCheck> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        const location = parseFleetFilesLocation(input.root, input.path);
        const names = parseFleetFilesNames(input.entries, 'entries', 5000);
        return sanitizeFleetFilesDownloadCheck(
            await this.requestOnce(
                { kind: 'user', userId },
                nodeId,
                location,
                FLEET_FILES_MESSAGES.pack,
                { entries: names, dryRun: true },
                { timeoutMs: 120_000 },
            ),
        );
    }

    // ─── Delete (FR-18, confirm-destructive) ───────────────────────────────

    async deleteForUser(
        userId: string,
        nodeId: string,
        input: { root: unknown; path?: unknown; entries: unknown; confirmName?: unknown },
    ): Promise<FleetFilesDeleteResult> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.deleteAs({ kind: 'user', userId }, nodeId, input);
    }

    async deleteAs(
        caller: FleetLinkCaller,
        nodeId: string,
        input: { root: unknown; path?: unknown; entries: unknown; confirmName?: unknown },
    ): Promise<FleetFilesDeleteResult> {
        const location = parseFleetFilesLocation(input.root, input.path);
        const names = parseFleetFilesNames(input.entries, 'entries', 5000);
        // The gate first (existence, kill switch, --manage, the files audience): the
        // dialog's details are only for someone who may act.
        const node = await this.link.authorizeRequest({
            nodeId,
            verb: 'files.delete',
            caller,
            requirement: {
                actionFamily: 'files',
                stateChanging: true,
                target: location.path || '/',
            },
        });
        const expected =
            names.length === 1
                ? names[0]
                : fleetFileBaseName(location.path) ||
                  (await this.rootFolderName(caller, nodeId, location.root));
        const confirmed =
            typeof input.confirmName === 'string' &&
            expected !== null &&
            input.confirmName === expected;
        if (!confirmed) {
            const where = location.path ? ` from ${location.path}` : '';
            throw fleetLinkError(
                'confirmation_required',
                names.length === 1
                    ? `Delete ${names[0]} from ${node.name}? Type its name to confirm.`
                    : `Delete ${names.length} items${where} on ${node.name}? Type the folder's name${expected ? ` (${expected})` : ''} to confirm.`,
                {
                    class: 'confirm-destructive',
                    summary: names.length === 1 ? names[0] : `${names.length} items`,
                    confirmName: expected,
                    entries: names.length,
                },
            );
        }
        const transferId = randomUUID();
        try {
            const result = (await this.requestOnce(
                caller,
                nodeId,
                location,
                FLEET_FILES_MESSAGES.delete,
                { entries: names, confirmationClass: 'confirm-destructive' },
                { stateChanging: true, timeoutMs: 120_000 },
            )) as { removed?: unknown } | null;
            const removed = typeof result?.removed === 'number' ? result.removed : 0;
            await this.record('node.files.delete', caller, node.id, node.userId, {
                root: location.root,
                path: location.path,
                entries: names.length,
                removed,
                confirmationClass: 'confirm-destructive',
                confirmed: true,
                outcome: 'done',
            });
            return { transferId, removed };
        } catch (error) {
            await this.record('node.files.delete', caller, node.id, node.userId, {
                root: location.root,
                path: location.path,
                entries: names.length,
                confirmationClass: 'confirm-destructive',
                confirmed: true,
                outcome: 'refused',
                code: error instanceof FleetLinkException ? error.code : 'internal',
            });
            throw error;
        }
    }

    /** Several entries at a root's top: the folder to type is the root's own folder name. */
    private async rootFolderName(
        caller: FleetLinkCaller,
        nodeId: string,
        rootId: string,
    ): Promise<string | null> {
        const roots = await this.roots(caller, nodeId).catch(() => null);
        const root = roots?.roots.find((candidate) => candidate.id === rootId);
        if (!root) return null;
        const segments = root.path.split(/[\\/]/).filter((segment) => segment.length > 0);
        return segments[segments.length - 1] ?? null;
    }

    // ─── The Agent port (FL-19 assembles the tools) ────────────────────────

    listFiles(
        caller: FleetFilesAgentCaller,
        nodeId: string,
        input: { root: string; path: string; hidden: boolean },
    ): Promise<FleetFileListView> {
        return this.listAs(
            { kind: 'agent', agentId: caller.agentId, ownerUserId: caller.ownerUserId },
            nodeId,
            input,
        );
    }

    statFile(
        caller: FleetFilesAgentCaller,
        nodeId: string,
        input: { root: string; path: string; name: string },
    ): Promise<FleetFileEntryView> {
        return this.statAs(
            { kind: 'agent', agentId: caller.agentId, ownerUserId: caller.ownerUserId },
            nodeId,
            input,
        );
    }

    listRoots(caller: FleetFilesAgentCaller, nodeId: string): Promise<FleetFileRootsResponse> {
        return this.roots(
            { kind: 'agent', agentId: caller.agentId, ownerUserId: caller.ownerUserId },
            nodeId,
        );
    }

    // ─── Audit ─────────────────────────────────────────────────────────────

    private async auditListOnce(
        caller: FleetLinkCaller,
        nodeId: string,
        location: FleetFilesLocation,
        entries: number,
    ): Promise<void> {
        if (!this.audit) return;
        const key = `${describeFleetLinkCaller(caller)}|${nodeId}|${location.root}`;
        const now = Date.now();
        const last = this.listAudited.get(key);
        if (last !== undefined && now - last < FLEET_FILES_LIST_AUDIT_WINDOW_MS) return;
        this.listAudited.set(key, now);
        if (this.listAudited.size > 5000) {
            for (const [stale, at] of this.listAudited) {
                if (now - at >= FLEET_FILES_LIST_AUDIT_WINDOW_MS) this.listAudited.delete(stale);
            }
        }
        const node = await this.nodes.findById(nodeId).catch(() => null);
        await this.record('node.files.list', caller, nodeId, node?.userId ?? null, {
            root: location.root,
            path: location.path,
            entries,
            confirmationClass: 'plain',
            outcome: 'read',
        });
    }

    async record(
        action: FleetAuditAction,
        caller: FleetLinkCaller,
        nodeId: string,
        ownerUserId: string | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId: fleetLinkCallerUserId(caller),
            ownerUserId,
            nodeId,
            details: { family: 'files', requestedBy: describeFleetLinkCaller(caller), ...details },
        });
    }
}
