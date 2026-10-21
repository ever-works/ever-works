import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
    fleetCheckoutDisplayPath,
    fleetCheckoutName,
    fleetFamilyAllows,
    FLEET_CHECKOUT_LISTED_REFRESH_MS,
    FLEET_CHECKOUT_MANUAL_REFRESH_MIN_MS,
    FLEET_CHECKOUT_RECONCILE_MS,
    FLEET_CHECKOUT_STDERR_HEAD_MAX_LENGTH,
    FLEET_CHECKOUT_WRITES_PER_MINUTE,
    isFleetCheckoutSyncOp,
    parseFleetCheckoutsListReply,
    parseFleetCheckoutsSyncResult,
    type FleetActionFamily,
    type FleetAuditAction,
    type FleetCheckoutArchiveRequest,
    type FleetCheckoutLastCommand,
    type FleetCheckoutListResponse,
    type FleetCheckoutOperationResponse,
    type FleetCheckoutSyncRequest,
    type FleetCheckoutView,
    type FleetCheckoutsListParams,
    type FleetCheckoutsListReply,
    type FleetLinkError,
    type FleetNodeCheckoutBusyReason,
    type FleetNodeCheckoutRecord,
    type FleetNodeCheckoutsMeta,
    type FleetNodeCheckoutsResponse,
    type FleetOperationView,
} from '@ever-works/contracts';
import type { FleetCheckout } from '../../entities/fleet-checkout.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { Work } from '../../entities/work.entity';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { readFleetSessionError } from '../sessions/fleet-session.errors';
import { FleetSessionRepository } from '../sessions/fleet-session.repository';
import { matchCheckoutWork, type FleetCheckoutWorkCandidate } from './checkout-remote-match';
import { fleetCheckoutError, FleetCheckoutException } from './fleet-checkout.errors';
import {
    FLEET_CHECKOUT_NODE_PORT,
    type FleetCheckoutNodeOutcome,
    type FleetCheckoutNodePort,
    type FleetCheckoutNodeRequest,
    type FleetCheckoutPortCaller,
} from './fleet-checkout-node.port';
import {
    checkoutPatchFromRecord,
    checkoutSizeBytes,
    createdByFromOrigin,
    isCheckoutFolderRemoved,
    isCreatingStale,
    isOmittedRowMissing,
    refreshAllowedAt,
    staleCreatingCommand,
} from './fleet-checkout.policy';
import {
    FLEET_CHECKOUT_LIST_DEFAULT_LIMIT,
    FLEET_CHECKOUT_LIST_MAX_LIMIT,
    FleetCheckoutRepository,
    type FleetCheckoutListQuery,
} from './fleet-checkout.repository';
import { toFleetCheckoutView, type FleetCheckoutLiveFacts } from './fleet-checkout.view';

/**
 * Checkouts on computers (FL-14) — the platform's one writer of
 * `fleet_checkouts` (CONTRACTS §4.3, §7; spec FR-1 … FR-15, FR-28, FR-30).
 *
 * Every act runs, in order: existence and the Node's family audience
 * (FL-01's role derivation — a stranger gets the 404 of an unknown id, a
 * member outside the audience `permission_denied` naming who to ask), the
 * per-user write rate (CONTRACTS §10.1), the kill switch (fail-closed), the
 * act's own rules, then the machine through the node link, then the row, then
 * one `fleet_audit` row with `family: 'checkouts'`, the checkout's path as
 * `target`, the requester and the confirmation class — never a credential or
 * a remote URL (spec FR-28).
 *
 * The NODE is the source of truth for the folder, the platform for the bin:
 * a list the node sends is folded in with the pure rules of
 * `fleet-checkout.policy.ts`; nothing the node says takes a row out of the
 * bin. A computer that cannot be reached keeps its rows as last known,
 * dimmed with their age (spec FR-15) — the list routes say why
 * (`stale`) instead of failing.
 */

/** Who acts. P1: a person; P2 adds Agents (their owner's audience applies, CONTRACTS §2.1). */
export interface FleetCheckoutActor {
    userId: string;
    /** Set when an Agent acts for its owner. */
    agentId?: string;
}

/** What one node last said about its checkouts — kept per API process, not stored (CONTRACTS §4.3 has no column). */
interface NodeListState {
    meta: Omit<FleetNodeCheckoutsMeta, 'nodeId' | 'totalSizeBytes' | 'count'>;
    /** Busy and reaper facts by path, from the last list. */
    live: Map<string, FleetCheckoutLiveFacts>;
    /** Epoch ms of the last list that asked for git lines. */
    refreshedAt: number | null;
}

/** How long one list request waits for the machine's first answer (it turns into an operation after 2 s). */
const LIST_TIMEOUT_MS = 10_000;
/** How long a sync request waits for the machine's first answer. */
const SYNC_TIMEOUT_MS = 15_000;
/** Most nodes one reconcile pass asks for a list. */
const RECONCILE_MAX_NODES = 100;

function describeAgo(since: Date | string | null | undefined, now: number): string | null {
    if (!since) return null;
    const at = since instanceof Date ? since.getTime() : Date.parse(since);
    if (!Number.isFinite(at)) return null;
    const minutes = Math.max(0, Math.round((now - at) / 60_000));
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}

function firstLine(text: string | null | undefined): string | null {
    if (!text) return null;
    const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
    return line ? line.slice(0, FLEET_CHECKOUT_STDERR_HEAD_MAX_LENGTH) : null;
}

@Injectable()
export class FleetCheckoutService {
    private readonly logger = new Logger(FleetCheckoutService.name);
    private readonly lists = new Map<string, NodeListState>();
    /** Last manual refresh per checkout (spec FR-9: once per 10 s). */
    private readonly refreshes = new Map<string, number>();
    /** Write timestamps per user, for the 30-per-minute rate (CONTRACTS §10.1). */
    private readonly writes = new Map<string, number[]>();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly checkouts: FleetCheckoutRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        @InjectRepository(Work) private readonly works: Repository<Work>,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() @Inject(FLEET_CHECKOUT_NODE_PORT) private readonly node?: FleetCheckoutNodePort,
        @Optional() private readonly sessions?: FleetSessionRepository,
    ) {}

    // ─── Reads ─────────────────────────────────────────────────────────────

    /** Every checkout on every Node the person may see (Fleet → Checkouts), or one Node's. */
    async list(
        actor: FleetCheckoutActor,
        query: FleetCheckoutListQuery & { nodeId?: string } = {},
    ): Promise<FleetCheckoutListResponse> {
        const nodeIds = query.nodeId
            ? [(await this.nodeFor(query.nodeId, actor, 'view')).node.id]
            : await this.visibleNodeIds(actor);
        const limit = Math.min(
            FLEET_CHECKOUT_LIST_MAX_LIMIT,
            Math.max(1, Math.floor(query.limit ?? FLEET_CHECKOUT_LIST_DEFAULT_LIMIT)),
        );
        const [rows, bin] = await Promise.all([
            this.checkouts.listForNodes(nodeIds, { ...query, limit }),
            this.checkouts.countArchived(nodeIds),
        ]);
        const last = rows.length === limit ? rows[rows.length - 1] : undefined;
        return {
            data: await this.views(rows, actor),
            meta: { nextCursor: last ? last.id : null, bin },
        };
    }

    /**
     * One Node's checkouts (the computer page's Checkouts tab). When the
     * computer is connected the node is asked first — its registry, and git
     * lines older than five minutes (spec FR-9) — and the answer folded in; a
     * `rescan` runs discovery too (spec S1, needs `--manage` and the
     * `checkouts` audience). A plain list that cannot reach the machine
     * answers the rows as last known with `stale` saying why (spec FR-15,
     * U1–U3); a rescan that cannot is refused with the reason.
     */
    async listForNode(
        nodeId: string,
        actor: FleetCheckoutActor,
        options: { rescan?: boolean; refresh?: boolean; state?: FleetCheckoutListQuery['state'] } = {},
    ): Promise<FleetNodeCheckoutsResponse> {
        const rescan = options.rescan === true;
        const { node } = await this.nodeFor(nodeId, actor, rescan ? 'checkouts' : 'view');
        if (rescan) {
            this.consumeWrite(actor.userId);
            if (await this.isStopped())
                throw fleetCheckoutError('kill_switch', 'clear it under Settings → Fleet');
        }
        let operationId: string | undefined;
        let stale: { code: string; hint: string } | undefined;
        const state = this.lists.get(node.id);
        const now = this.now();
        const refresh =
            rescan ||
            options.refresh === true ||
            !state?.refreshedAt ||
            now - state.refreshedAt >= FLEET_CHECKOUT_LISTED_REFRESH_MS;
        if (!this.node || !this.node.isConnected(node.id)) {
            const ago = describeAgo(node.lastHeartbeatAt, now);
            const error = {
                code: 'unreachable',
                hint: ago ? `${node.name} is offline; last seen ${ago} ago` : `${node.name} is offline`,
            };
            if (rescan) throw fleetCheckoutError('unreachable', error.hint, { nodeId: node.id });
            stale = error;
        } else {
            const params: FleetCheckoutsListParams = { rescan, refresh, measureSize: rescan };
            try {
                const outcome = await this.ask(node, actor, {
                    verb: 'checkouts.list',
                    params: { ...params },
                    consent: rescan ? 'manage' : undefined,
                    actionFamily: rescan ? 'checkouts' : 'view',
                    stateChanging: rescan,
                    timeoutMs: LIST_TIMEOUT_MS,
                });
                if (refresh) this.markRefreshed(node.id, now);
                if ('result' in outcome) await this.applyNodeList(node, outcome.result);
                else operationId = outcome.operationId;
                if (rescan) {
                    await this.record('node.checkout.sync', actor, node, null, {
                        op: 'rescan',
                        confirmationClass: 'plain',
                        outcome: operationId ? 'started' : 'done',
                    });
                }
            } catch (error) {
                const typed = this.typed(error);
                if (rescan) throw new FleetCheckoutException(typed);
                stale = { code: typed.code, hint: typed.hint };
            }
        }
        const [rows, bin] = await Promise.all([
            this.checkouts.listForNodes([node.id], {
                limit: FLEET_CHECKOUT_LIST_MAX_LIMIT,
                ...(options.state ? { state: options.state } : {}),
            }),
            this.checkouts.countArchived([node.id]),
        ]);
        const response: FleetNodeCheckoutsResponse = {
            data: await this.views(rows, actor),
            meta: { nextCursor: null, bin },
            node: this.metaFor(node.id, rows),
        };
        if (operationId) response.operationId = operationId;
        if (stale) response.stale = stale;
        return response;
    }

    /** One checkout. */
    async get(id: string, actor: FleetCheckoutActor): Promise<FleetCheckoutView> {
        const { checkout } = await this.resolve(id, actor, 'view');
        return this.view(checkout, actor);
    }

    // ─── Acts ──────────────────────────────────────────────────────────────

    /**
     * Recompute one checkout's git line on the machine now (spec FR-9: a
     * person's refresh, no more than once per 10 seconds per checkout). Never
     * contacts the remote (FR-10).
     */
    async refresh(id: string, actor: FleetCheckoutActor): Promise<FleetCheckoutOperationResponse> {
        const { checkout, node } = await this.resolve(id, actor, 'checkouts');
        const now = this.now();
        const retryAt = refreshAllowedAt(
            this.refreshes.get(checkout.id),
            now,
            FLEET_CHECKOUT_MANUAL_REFRESH_MIN_MS,
        );
        if (retryAt !== null) {
            throw fleetCheckoutError('limit_exceeded', 'one refresh per checkout every 10 seconds', {
                limit: '1 per 10 s',
                retryAt: new Date(retryAt).toISOString(),
            });
        }
        if (checkout.state === 'archived')
            throw fleetCheckoutError('invalid', 'this checkout is in the bin; restore it first');
        if (await this.isStopped())
            throw fleetCheckoutError('kill_switch', 'clear it under Settings → Fleet');
        this.refreshes.set(checkout.id, now);
        this.boundRefreshes(now);
        const outcome = await this.askOrThrow(node, actor, {
            verb: 'checkouts.list',
            params: { refresh: true, paths: [checkout.path] },
            actionFamily: 'checkouts',
            stateChanging: false,
            target: checkout.path,
            timeoutMs: LIST_TIMEOUT_MS,
        });
        if ('result' in outcome) await this.applyNodeList(node, outcome.result);
        const fresh = (await this.checkouts.findById(checkout.id)) ?? checkout;
        return {
            checkout: await this.view(fresh, actor),
            operationId: 'operationId' in outcome ? outcome.operationId : null,
        };
    }

    /**
     * Fetch (P1), pull and push (P2) on one checkout (spec FR-12, S5). Fetch
     * needs no confirmation and is allowed while a session runs in the
     * checkout; it refreshes the git line afterwards on the machine.
     */
    async sync(
        id: string,
        actor: FleetCheckoutActor,
        request: FleetCheckoutSyncRequest,
    ): Promise<FleetCheckoutOperationResponse> {
        const op = request?.op;
        if (!isFleetCheckoutSyncOp(op))
            throw fleetCheckoutError('invalid', 'op must be fetch, pull or push', { field: 'op' });
        const { checkout, node } = await this.resolve(id, actor, 'checkouts');
        if (op !== 'fetch') {
            throw fleetCheckoutError('invalid', 'Pull and push arrive with the next Checkouts release', {
                field: 'op',
            });
        }
        this.requireUsable(checkout, node);
        this.consumeWrite(actor.userId);
        if (await this.isStopped())
            throw fleetCheckoutError('kill_switch', 'clear it under Settings → Fleet');
        let outcome: FleetCheckoutNodeOutcome;
        try {
            outcome = await this.askOrThrow(node, actor, {
                verb: 'checkouts.sync',
                params: { path: checkout.path, op, checkoutId: checkout.id },
                actionFamily: 'checkouts',
                stateChanging: true,
                target: checkout.path,
                timeoutMs: SYNC_TIMEOUT_MS,
            });
        } catch (error) {
            const typed = error instanceof FleetCheckoutException ? error.checkoutError : null;
            await this.record('node.checkout.sync', actor, node, checkout.path, {
                op,
                confirmationClass: 'plain',
                outcome: 'refused',
                ...(typed ? { code: typed.code } : {}),
            });
            throw error;
        }
        const at = new Date(this.now()).toISOString();
        if ('result' in outcome) {
            await this.applySyncResult(node, outcome.result, checkout);
        } else {
            await this.checkouts.update(checkout.id, {
                lastCommand: { command: op, exitCode: null, at, operationId: outcome.operationId },
            });
        }
        const fresh = (await this.checkouts.findById(checkout.id)) ?? checkout;
        await this.record('node.checkout.sync', actor, node, checkout.path, {
            op,
            confirmationClass: 'plain',
            outcome:
                'operationId' in outcome
                    ? 'started'
                    : fresh.lastCommand?.exitCode === 0
                      ? 'done'
                      : 'failed',
        });
        return {
            checkout: await this.view(fresh, actor),
            operationId: 'operationId' in outcome ? outcome.operationId : null,
        };
    }

    /**
     * Move a checkout to the bin (spec FR-13, S8): class `confirm`; the folder
     * is never touched. Refused `busy` while a session runs in it (U9).
     * Idempotent: archiving an archived checkout answers it as it is.
     */
    async archive(
        id: string,
        actor: FleetCheckoutActor,
        request: FleetCheckoutArchiveRequest = {},
    ): Promise<FleetCheckoutView> {
        const { checkout, node } = await this.resolve(id, actor, 'checkouts');
        if (checkout.state === 'archived') return this.view(checkout, actor);
        if (checkout.state === 'creating')
            throw fleetCheckoutError('busy', 'this checkout is still being created');
        const name = fleetCheckoutDisplayPath(checkout.path);
        if (request?.confirm !== true) {
            throw fleetCheckoutError('confirmation_required', `Move ${name} on ${node.name} to the bin?`, {
                class: 'confirm',
                summary: `Move ${name} on ${node.name} to the bin? The folder is not touched; restore it from the bin any time.`,
            });
        }
        this.consumeWrite(actor.userId);
        if (await this.isStopped())
            throw fleetCheckoutError('kill_switch', 'clear it under Settings → Fleet');
        await this.refuseWhileSessionRuns(checkout, node);
        const now = new Date(this.now());
        await this.checkouts.update(checkout.id, { state: 'archived', archivedAt: now });
        await this.record('node.checkout.archive', actor, node, checkout.path, {
            confirmationClass: 'confirm',
            outcome: 'archived',
            from: checkout.state,
        });
        const fresh = (await this.checkouts.findById(checkout.id)) ?? checkout;
        return this.view(fresh, actor);
    }

    /**
     * Bring a checkout back from the bin (spec FR-13): only while its folder
     * is still on the machine — the node is asked, never assumed. A checkout
     * whose folder a delete removed has no Restore (FR-26).
     */
    async restore(id: string, actor: FleetCheckoutActor): Promise<FleetCheckoutView> {
        const { checkout, node } = await this.resolve(id, actor, 'checkouts');
        if (checkout.state !== 'archived') return this.view(checkout, actor);
        if (isCheckoutFolderRemoved(checkout)) {
            throw fleetCheckoutError(
                'operation_failed',
                'the folder was removed when this checkout was deleted; it cannot be restored',
            );
        }
        this.consumeWrite(actor.userId);
        if (await this.isStopped())
            throw fleetCheckoutError('kill_switch', 'clear it under Settings → Fleet');
        const outcome = await this.askOrThrow(node, actor, {
            verb: 'checkouts.list',
            params: { paths: [checkout.path] },
            actionFamily: 'checkouts',
            stateChanging: false,
            target: checkout.path,
            timeoutMs: LIST_TIMEOUT_MS,
        });
        const reply = 'result' in outcome ? parseFleetCheckoutsListReply(outcome.result) : null;
        if (!reply) {
            throw fleetCheckoutError(
                'operation_failed',
                `${node.name} did not answer in time; try again in a moment`,
            );
        }
        const record = reply.checkouts.find((entry) => entry.path === checkout.path);
        if (!record || !record.present) {
            await this.record('node.checkout.restore', actor, node, checkout.path, {
                confirmationClass: 'plain',
                outcome: 'refused',
                code: 'operation_failed',
            });
            throw fleetCheckoutError('operation_failed', `The folder is gone from ${node.name}`);
        }
        // Out of the bin first, then the node's facts folded in as for any list.
        await this.checkouts.update(checkout.id, { state: 'ready', archivedAt: null });
        await this.applyNodeList(node, { ...reply, complete: false });
        await this.record('node.checkout.restore', actor, node, checkout.path, {
            confirmationClass: 'plain',
            outcome: 'restored',
        });
        const fresh = (await this.checkouts.findById(checkout.id)) ?? checkout;
        return this.view(fresh, actor);
    }

    // ─── What the node reports ─────────────────────────────────────────────

    /**
     * Fold one `checkouts.list` reply into the rows (spec FR-7, FR-11, U14).
     * Never throws: an unreadable reply is logged and dropped.
     */
    async applyNodeList(node: FleetNode, raw: unknown): Promise<void> {
        const reply = parseFleetCheckoutsListReply(raw);
        if (!reply) {
            this.logger.warn(`Node ${node.id} sent a checkouts list this platform cannot read`);
            return;
        }
        try {
            await this.fold(node, reply);
        } catch (error) {
            this.logger.warn(
                `Folding the checkouts list of node ${node.id} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * A link operation ended (FL-02 `FleetOperationsService`): a slow list or
     * a sync finished on the machine. Only `machine` operations of the
     * checkouts verbs are read; anything else is ignored. Never throws.
     */
    async applyOperationEnded(view: FleetOperationView): Promise<void> {
        if (view.family !== 'machine' || !view.verb.startsWith('checkouts.')) return;
        try {
            const node = await this.nodes.findById(view.nodeId);
            if (!node) return;
            if (view.verb === 'checkouts.list') {
                if (view.state === 'done') await this.applyNodeList(node, view.result);
                return;
            }
            if (view.verb === 'checkouts.sync') {
                if (view.state === 'done') {
                    await this.applySyncResult(node, view.result, null);
                    return;
                }
                await this.failOperation(node, view.id, view.error ?? null);
            }
        } catch (error) {
            this.logger.warn(
                `Applying checkout operation ${view.id} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * The reconcile sweep (plan §10, every ten minutes): rows stuck in
     * `creating` for ten minutes become `missing` (never a phantom
     * `creating`, spec §6), and connected nodes not heard from for ten
     * minutes are asked for their list (spec FR-11). Idempotent: every write
     * is a compare-and-set on `updatedAt`.
     */
    async reconcile(): Promise<{ swept: number; asked: number }> {
        const now = this.now();
        let swept = 0;
        const stale = await this.checkouts.findCreatingBefore(
            new Date(now - FLEET_CHECKOUT_RECONCILE_MS),
        );
        for (const row of stale) {
            if (!isCreatingStale(row, now)) continue;
            const won = await this.checkouts.updateIfUnchanged(row, {
                state: 'missing',
                lastCommand: staleCreatingCommand(row, new Date(now)),
            });
            if (won) swept += 1;
        }
        let asked = 0;
        if (this.node) {
            const nodeIds = await this.checkouts.nodeIdsWithCheckouts();
            for (const nodeId of nodeIds.slice(0, RECONCILE_MAX_NODES)) {
                const listedAt = this.lists.get(nodeId)?.meta.listedAt;
                if (listedAt && now - Date.parse(listedAt) < FLEET_CHECKOUT_RECONCILE_MS) continue;
                if (!this.node.isConnected(nodeId)) continue;
                const node = await this.nodes.findById(nodeId);
                if (!node) continue;
                try {
                    const outcome = await this.node.request({
                        nodeId,
                        verb: 'checkouts.list',
                        params: {},
                        caller: { kind: 'system', job: 'fleet-checkout-reconcile' },
                        actionFamily: 'view',
                        stateChanging: false,
                        timeoutMs: LIST_TIMEOUT_MS,
                    });
                    asked += 1;
                    if ('result' in outcome) await this.applyNodeList(node, outcome.result);
                } catch (error) {
                    this.logger.debug(
                        `Reconcile could not list checkouts on node ${nodeId}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }
        }
        return { swept, asked };
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    private async fold(node: FleetNode, reply: FleetCheckoutsListReply): Promise<void> {
        const rows = await this.checkouts.findForNode(node.id);
        const byPath = new Map(rows.map((row) => [row.path, row]));
        const needsWorks = reply.checkouts.some((record) => record.remoteUrl);
        const works = needsWorks ? await this.worksOf(node.userId) : [];
        const now = new Date(this.now());
        const state: NodeListState = this.lists.get(node.id) ?? {
            meta: {
                codeFolders: null,
                scannedAt: null,
                truncated: false,
                checkoutsRoot: null,
                listedAt: null,
            },
            live: new Map<string, FleetCheckoutLiveFacts>(),
            refreshedAt: null,
        };
        for (const record of reply.checkouts) {
            const row = byPath.get(record.path) ?? null;
            const patch = checkoutPatchFromRecord(row, record, now);
            const remoteUrl = patch.remoteUrl !== undefined ? patch.remoteUrl : (row?.remoteUrl ?? null);
            const work = matchCheckoutWork(remoteUrl, works);
            if (work) patch.workId = work.id;
            else if (needsWorks && remoteUrl) patch.workId = null;
            state.live.set(record.path, { busy: record.busy, reaperNote: record.reaperNote });
            if (row) {
                await this.checkouts.update(row.id, patch);
                byPath.set(record.path, { ...row, ...patch } as FleetCheckout);
            } else {
                const created = await this.insert(node, record, patch);
                if (created) byPath.set(record.path, created);
            }
        }
        // Parents by path, once every row of this list exists.
        for (const record of reply.checkouts) {
            if (!record.parentPath) continue;
            const child = byPath.get(record.path);
            const parent = byPath.get(record.parentPath);
            if (child && parent && child.parentCheckoutId !== parent.id && child.id !== parent.id) {
                await this.checkouts.update(child.id, { parentCheckoutId: parent.id });
            }
        }
        if (reply.complete) {
            const reported = new Set(reply.checkouts.map((record) => record.path));
            for (const row of rows) {
                if (reported.has(row.path) || !isOmittedRowMissing(row, now.getTime())) continue;
                await this.checkouts.update(row.id, { state: 'missing' });
                state.live.delete(row.path);
            }
            state.meta.codeFolders = reply.codeFolders;
            state.meta.scannedAt = reply.scannedAt;
            state.meta.truncated = reply.truncated;
            state.meta.checkoutsRoot = reply.checkoutsRoot;
        }
        state.meta.listedAt = now.toISOString();
        this.lists.set(node.id, state);
    }

    private async insert(
        node: FleetNode,
        record: FleetNodeCheckoutRecord,
        patch: Partial<FleetCheckout>,
    ): Promise<FleetCheckout | null> {
        try {
            return await this.checkouts.create({
                nodeId: node.id,
                userId: node.userId,
                path: record.path,
                kind: record.kind,
                createdBy: createdByFromOrigin(record.origin),
                parentCheckoutId: null,
                ...patch,
            });
        } catch (error) {
            // `(nodeId, path)` is unique: another replica folded the same list first.
            const existing = await this.checkouts.findByPath(node.id, record.path);
            if (existing) {
                await this.checkouts.update(existing.id, patch);
                return { ...existing, ...patch } as FleetCheckout;
            }
            this.logger.warn(
                `Could not record checkout on node ${node.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }

    private async applySyncResult(
        node: FleetNode,
        raw: unknown,
        known: FleetCheckout | null,
    ): Promise<void> {
        const result = parseFleetCheckoutsSyncResult(raw);
        if (!result) {
            this.logger.warn(`Node ${node.id} sent a checkout sync result this platform cannot read`);
            return;
        }
        const row =
            known && known.path === result.path
                ? known
                : await this.checkouts.findByPath(node.id, result.path);
        if (!row) return;
        const lastCommand: FleetCheckoutLastCommand = {
            command: result.op,
            exitCode: result.exitCode,
            at: new Date(this.now()).toISOString(),
            stderrHead: result.exitCode === 0 ? null : firstLine(result.stderrHead),
            operationId: null,
        };
        await this.checkouts.update(row.id, { lastCommand });
        if (result.checkout) {
            await this.applyNodeList(node, {
                checkouts: [result.checkout],
                complete: false,
                truncated: false,
                codeFolders: [],
                scannedAt: null,
                checkoutsRoot: null,
            });
        }
    }

    /** A sync operation that failed, was cancelled or was interrupted: its row says so. */
    private async failOperation(
        node: FleetNode,
        operationId: string,
        error: FleetLinkError | null,
    ): Promise<void> {
        const details = error?.details as { path?: unknown } | undefined;
        const rows = await this.checkouts.findForNode(node.id);
        const row =
            rows.find((candidate) => candidate.lastCommand?.operationId === operationId) ??
            (typeof details?.path === 'string'
                ? rows.find((candidate) => candidate.path === details.path)
                : undefined);
        if (!row) return;
        await this.checkouts.update(row.id, {
            lastCommand: {
                command: row.lastCommand?.command ?? 'fetch',
                exitCode: 1,
                at: new Date(this.now()).toISOString(),
                stderrHead: firstLine(error?.hint) ?? 'the operation did not finish',
                operationId: null,
            },
        });
    }

    /** A checkout after the audience check, refusals in the CONTRACTS §8 envelope. */
    private async resolve(
        id: string,
        actor: FleetCheckoutActor,
        family: FleetActionFamily,
    ): Promise<{ checkout: FleetCheckout; node: FleetNode }> {
        const checkout = await this.checkouts.findById(id);
        if (!checkout) throw fleetCheckoutError('not_found', 'no such checkout');
        try {
            const { node } = await this.access.resolveForFamily(checkout.nodeId, actor.userId, family);
            return { checkout, node };
        } catch (error) {
            const typed = readFleetSessionError(error);
            if (typed?.code === 'permission_denied') {
                throw fleetCheckoutError(typed.code, typed.hint, typed.details);
            }
            // A checkout on a node the person may not see is as unknown as a missing one.
            throw fleetCheckoutError('not_found', 'no such checkout');
        }
    }

    /** A node after the audience check. */
    private async nodeFor(
        nodeId: string,
        actor: FleetCheckoutActor,
        family: FleetActionFamily,
    ): Promise<{ node: FleetNode }> {
        try {
            const { node } = await this.access.resolveForFamily(nodeId, actor.userId, family);
            return { node };
        } catch (error) {
            const typed = readFleetSessionError(error);
            if (typed?.code === 'permission_denied') {
                throw fleetCheckoutError(typed.code, typed.hint, typed.details);
            }
            throw fleetCheckoutError('not_found', 'no such computer');
        }
    }

    /** Refusals that need no machine: the folder's state (spec U1, S10). */
    private requireUsable(checkout: FleetCheckout, node: FleetNode): void {
        if (checkout.state === 'archived')
            throw fleetCheckoutError('invalid', 'this checkout is in the bin; restore it first');
        if (checkout.state === 'missing')
            throw fleetCheckoutError('invalid', `The folder is gone from ${node.name}`);
        if (checkout.state === 'creating')
            throw fleetCheckoutError('busy', 'this checkout is still being created');
    }

    /** U9: pull, push, delete and archive wait for the session working in the checkout. */
    private async refuseWhileSessionRuns(checkout: FleetCheckout, node: FleetNode): Promise<void> {
        const busy = this.lists.get(node.id)?.live.get(checkout.path)?.busy ?? null;
        let title: string | null = null;
        if (this.sessions) {
            try {
                const live = await this.sessions.findLiveForNode(node.id);
                const inside = live.find(
                    (session) => session.checkoutId === checkout.id || session.cwd === checkout.path,
                );
                if (inside) title = inside.title;
            } catch (error) {
                this.logger.debug(
                    `Live sessions of node ${node.id} could not be read: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        if (title !== null) {
            throw fleetCheckoutError('busy', `"${title}" is working in this checkout`, {
                reason: 'session',
            });
        }
        if (busy === 'session' || busy === 'lease' || busy === 'operation') {
            throw fleetCheckoutError('busy', this.busyHint(busy), { reason: busy });
        }
        if (busy === 'reaper') {
            throw fleetCheckoutError('busy', 'being tidied — try again in a minute', {
                reason: busy,
            });
        }
    }

    private busyHint(reason: FleetNodeCheckoutBusyReason): string {
        switch (reason) {
            case 'session':
                return 'a session is working in this checkout';
            case 'lease':
                return 'a Task run is working in this checkout';
            case 'operation':
                return 'another git command is running in this checkout';
            case 'reaper':
            default:
                return 'being tidied — try again in a minute';
        }
    }

    /** One request to the machine; a refusal becomes the CONTRACTS §8 error. */
    private async askOrThrow(
        node: FleetNode,
        actor: FleetCheckoutActor,
        input: Omit<FleetCheckoutNodeRequest, 'nodeId' | 'caller'>,
    ): Promise<FleetCheckoutNodeOutcome> {
        try {
            return await this.ask(node, actor, input);
        } catch (error) {
            throw new FleetCheckoutException(this.typed(error));
        }
    }

    private async ask(
        node: FleetNode,
        actor: FleetCheckoutActor,
        input: Omit<FleetCheckoutNodeRequest, 'nodeId' | 'caller'>,
    ): Promise<FleetCheckoutNodeOutcome> {
        if (!this.node) {
            throw fleetCheckoutError('unreachable', 'this deployment does not reach computers');
        }
        const caller: FleetCheckoutPortCaller = actor.agentId
            ? { kind: 'agent', agentId: actor.agentId, ownerUserId: actor.userId }
            : { kind: 'user', userId: actor.userId };
        return this.node.request({ ...input, nodeId: node.id, caller });
    }

    private typed(error: unknown): FleetLinkError {
        if (error instanceof FleetCheckoutException) return error.checkoutError;
        const typed = readFleetSessionError(error);
        if (typed) return typed;
        this.logger.warn(
            `Checkout request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { code: 'internal', hint: 'the request could not be completed' };
    }

    private markRefreshed(nodeId: string, at: number): void {
        const state = this.lists.get(nodeId);
        if (state) state.refreshedAt = at;
        else {
            this.lists.set(nodeId, {
                meta: {
                    codeFolders: null,
                    scannedAt: null,
                    truncated: false,
                    checkoutsRoot: null,
                    listedAt: null,
                },
                live: new Map(),
                refreshedAt: at,
            });
        }
    }

    private boundRefreshes(now: number): void {
        if (this.refreshes.size < 5000) return;
        for (const [key, at] of this.refreshes) {
            if (now - at >= FLEET_CHECKOUT_MANUAL_REFRESH_MIN_MS) this.refreshes.delete(key);
        }
    }

    /** CONTRACTS §10.1: 30 checkout writes per user per minute. */
    private consumeWrite(userId: string): void {
        const now = this.now();
        const recent = (this.writes.get(userId) ?? []).filter((at) => now - at < 60_000);
        if (recent.length >= FLEET_CHECKOUT_WRITES_PER_MINUTE) {
            throw fleetCheckoutError('limit_exceeded', '30 checkout changes per minute', {
                limit: `${FLEET_CHECKOUT_WRITES_PER_MINUTE} per minute`,
            });
        }
        recent.push(now);
        this.writes.set(userId, recent);
        if (this.writes.size > 10_000) {
            for (const [key, list] of this.writes) {
                if (list.every((at) => now - at >= 60_000)) this.writes.delete(key);
            }
        }
    }

    private metaFor(nodeId: string, rows: readonly FleetCheckout[]): FleetNodeCheckoutsMeta {
        const state = this.lists.get(nodeId);
        let totalSizeBytes = 0;
        let count = 0;
        for (const row of rows) {
            if (row.state === 'archived') continue;
            count += 1;
            totalSizeBytes += checkoutSizeBytes(row.sizeBytes) ?? 0;
        }
        return {
            nodeId,
            codeFolders: state?.meta.codeFolders ?? null,
            scannedAt: state?.meta.scannedAt ?? null,
            truncated: state?.meta.truncated ?? false,
            checkoutsRoot: state?.meta.checkoutsRoot ?? null,
            listedAt: state?.meta.listedAt ?? null,
            totalSizeBytes,
            count,
        };
    }

    private async view(row: FleetCheckout, actor: FleetCheckoutActor): Promise<FleetCheckoutView> {
        const [view] = await this.views([row], actor);
        return view;
    }

    /** Views, with Work names only for the viewer's own Works (anyone else sees that one is linked). */
    private async views(
        rows: readonly FleetCheckout[],
        actor: FleetCheckoutActor,
    ): Promise<FleetCheckoutView[]> {
        const workIds = [
            ...new Set(
                rows
                    .filter((row) => row.userId === actor.userId && row.workId)
                    .map((row) => row.workId as string),
            ),
        ];
        const names = new Map<string, string>();
        if (workIds.length > 0) {
            try {
                const works = await this.works.find({
                    where: { id: In(workIds), userId: actor.userId },
                    select: ['id', 'name'],
                });
                for (const work of works) names.set(work.id, work.name);
            } catch (error) {
                this.logger.debug(
                    `Work names for checkouts could not be read: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        return rows.map((row) =>
            toFleetCheckoutView(row, {
                workName: row.workId ? (names.get(row.workId) ?? null) : null,
                live: this.lists.get(row.nodeId)?.live.get(row.path),
            }),
        );
    }

    /** The node owner's Works, oldest first (stable matching), with only what matching reads. */
    private async worksOf(userId: string): Promise<FleetCheckoutWorkCandidate[]> {
        try {
            const works = await this.works.find({
                where: { userId },
                select: ['id', 'name', 'sourceRepository', 'createdAt'],
                order: { createdAt: 'ASC' },
                take: 2000,
            });
            return works.map((work) => ({
                id: work.id,
                name: work.name,
                sourceRepository: (work.sourceRepository ??
                    null) as FleetCheckoutWorkCandidate['sourceRepository'],
            }));
        } catch (error) {
            this.logger.debug(
                `Works of user ${userId} could not be read for checkout matching: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }
    }

    private async visibleNodeIds(actor: FleetCheckoutActor): Promise<string[]> {
        const own = await this.nodes.findByUser(actor.userId);
        const shared = await this.access.listSharedWith(actor.userId);
        const ids = own.filter((node) => node.status !== 'enrolling').map((node) => node.id);
        for (const { node, role } of shared) {
            if (fleetFamilyAllows(node, role, 'view') && !ids.includes(node.id)) ids.push(node.id);
        }
        return ids;
    }

    private async isStopped(): Promise<boolean> {
        try {
            return await this.killSwitch.isStopped();
        } catch {
            return true;
        }
    }

    private async record(
        action: FleetAuditAction,
        actor: FleetCheckoutActor,
        node: Pick<FleetNode, 'id' | 'userId'>,
        target: string | null,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId: actor.userId,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: {
                family: 'checkouts',
                target,
                ...(target ? { name: fleetCheckoutName(target) } : {}),
                requestedBy: actor.agentId ? `agent:${actor.agentId}` : `user:${actor.userId}`,
                ...details,
            },
        });
    }
}
