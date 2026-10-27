import { Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import {
    FleetAuditService,
    FleetNodeRepository,
    FleetService,
    type FleetLogsAgentCaller,
    type FleetLogsReaderPort,
} from '@ever-works/agent/fleet';
import {
    encodeFleetLinkAck,
    FLEET_LINK_FRAME_KINDS,
    FLEET_LOGS_INITIAL_LINES,
    FLEET_LOGS_MAX_CHANNELS_PER_VIEWER,
    FLEET_LOGS_MAX_LISTED_SOURCES,
    FLEET_LOGS_READ_ABANDON_MS,
    FLEET_LOGS_SOURCES_VERB,
    clampFleetLogsLines,
    fleetLogLineMatches,
    isFleetLinkErrorCode,
    isFleetLogSourceKind,
    parseFleetLogLines,
    parseFleetLogSourceId,
    parseFleetLogsChannelMessage,
    parseFleetLogsOpenParams,
    type FleetLinkCloseReason,
    type FleetLogLine,
    type FleetLogSource,
    type FleetLogSourceList,
    type FleetLogSourcesResponse,
    type FleetLogsAttachGrant,
    type FleetLogsInitialDone,
    type FleetLogsReadResult,
} from '@ever-works/contracts';
import { FleetLinkAttachService } from '../../fleet-link/fleet-link-attach.service';
import type { FleetLinkChannel } from '../../fleet-link/fleet-link-channel';
import { FleetLinkException, fleetLinkError } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import {
    describeFleetLinkCaller,
    fleetLinkCallerUserId,
    type FleetLinkCaller,
} from '../../fleet-link/fleet-link.types';
import {
    FleetLinkViewerGatewayService,
    type FleetLinkViewerHandle,
    type FleetLinkViewerObserver,
} from '../../fleet-link/fleet-link-viewer-gateway.service';

/**
 * Logs on computers (FL-08, plan §5, T-09/T-11) — the platform's half.
 *
 * Nothing is stored here but `fleet_audit` rows: lines travel from the
 * machine (already secret-scanned there) to the reader and nowhere else.
 *
 *  - **sources** — `logs.sources` on the node's `machine` channel (CONTRACTS
 *    §3.3 rev 4), sanitised and bounded;
 *  - **attach** — a 60-second viewer token for `/ws/fleet/logs/<nodeId>`
 *    through FL-02's ONE minter (`FleetLinkAttachService`), refused
 *    `limit_exceeded` when the person already holds
 *    {@link FLEET_LOGS_MAX_CHANNELS_PER_VIEWER} log channels on that computer
 *    (U11);
 *  - **read** — a one-shot batch (≤ 500 lines, never a follow) for the REST
 *    surface, MCP and Agents: a `logs` channel is opened, `logs.read` sent,
 *    `DATA` collected (with `ACK` credit back) until `logs.initial-done`, then
 *    closed.
 *
 * Every path goes through FL-02's authoriser first — existence (404), kill
 * switch (`kill_switch`), consent (`consent_missing` naming `--manage`),
 * the `logs` family audience (`permission_denied`) — then reachability
 * (`unreachable`). Errors are the CONTRACTS §8 envelope only (FR-30).
 *
 * **Audit** (FR-27, CONTRACTS §7): `node.logs.read` for every source open and
 * one-shot read, `node.logs.follow` for every follow — with the source,
 * its kind, the requester (`user:` / `agent:`), the line and redaction
 * counts, `confirmationClass: 'plain'` and the outcome, never a line. On the
 * browser path the counts come from the node's `logs.initial-done`, which
 * this service reads as the `logs` family's viewer observer (FL-02 gateway,
 * `nodeMessage`); the bytes themselves are never seen here.
 *
 * The per-viewer channel count is per API replica (lane log decision 8).
 */

interface ViewerSlot {
    userId: string;
    nodeId: string;
    sources: string[];
    follow: boolean;
    audited: boolean;
}

/** One `logs.sources` entry off the wire, bounded; null for anything malformed. */
function sanitizeSource(value: unknown): FleetLogSource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const ref = parseFleetLogSourceId(raw.id);
    if (!ref || !isFleetLogSourceKind(raw.kind) || raw.kind !== ref.kind) return null;
    const text = (input: unknown, max: number): string | undefined =>
        typeof input === 'string' && input.length > 0 ? input.slice(0, max) : undefined;
    const source: FleetLogSource = {
        id: raw.id as string,
        kind: ref.kind,
        label: text(raw.label, 400) ?? ref.key,
        group: text(raw.group, 400) ?? '',
        readable: raw.readable === true,
        supportsEarlier: raw.supportsEarlier === true,
    };
    if (
        raw.unreadableReason === 'root-only' ||
        raw.unreadableReason === 'needs-admin' ||
        raw.unreadableReason === 'group-membership' ||
        raw.unreadableReason === 'gone'
    ) {
        source.unreadableReason = raw.unreadableReason;
    }
    const hint = text(raw.hint, 300);
    if (hint) source.hint = hint;
    const state = text(raw.state, 80);
    if (state) source.state = state;
    if (raw.failed === true) source.failed = true;
    if (typeof raw.lastWrittenAt === 'string' && !Number.isNaN(Date.parse(raw.lastWrittenAt))) {
        source.lastWrittenAt = new Date(Date.parse(raw.lastWrittenAt)).toISOString();
    }
    if (typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) && raw.sizeBytes >= 0) {
        source.sizeBytes = Math.floor(raw.sizeBytes);
    }
    return source;
}

/** A `logs.sources` reply, sanitised: known shapes only, bounded counts. */
export function sanitizeFleetLogSourceList(value: unknown): FleetLogSourceList {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const sources = (Array.isArray(raw.sources) ? raw.sources : [])
        .slice(0, FLEET_LOGS_MAX_LISTED_SOURCES)
        .map(sanitizeSource)
        .filter((source): source is FleetLogSource => source !== null);
    const roots = (Array.isArray(raw.roots) ? raw.roots : [])
        .filter((root): root is string => typeof root === 'string' && root.length > 0)
        .slice(0, 64)
        .map((root) => root.slice(0, 400));
    return {
        platform: typeof raw.platform === 'string' ? raw.platform.slice(0, 32) : 'unknown',
        sources,
        roots,
        truncated: raw.truncated === true,
        listedAt:
            typeof raw.listedAt === 'string' && !Number.isNaN(Date.parse(raw.listedAt))
                ? new Date(Date.parse(raw.listedAt)).toISOString()
                : new Date().toISOString(),
    };
}

/** The close of a channel as a typed error (never `normal`, never an unknown code). */
function closeAsError(reason: FleetLinkCloseReason, hint: string | undefined, nodeName: string) {
    if (reason !== 'normal' && isFleetLinkErrorCode(reason)) {
        return fleetLinkError(reason, hint ?? `${nodeName} closed the log`);
    }
    return fleetLinkError('unreachable', `${nodeName} did not answer`);
}

@Injectable()
export class FleetLogsService
    implements OnApplicationBootstrap, FleetLinkViewerObserver, FleetLogsReaderPort
{
    /** Viewer handle id → its slot. */
    private readonly viewers = new Map<string, ViewerSlot>();

    constructor(
        private readonly fleet: FleetService,
        private readonly nodes: FleetNodeRepository,
        private readonly link: FleetLinkService,
        private readonly attach: FleetLinkAttachService,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() private readonly gateway?: FleetLinkViewerGatewayService,
    ) {}

    onApplicationBootstrap(): void {
        this.gateway?.registerObserver('logs', this);
    }

    // ─── Sources ───────────────────────────────────────────────────────────

    /** `GET /nodes/:id/logs/sources` for a person (visibility first: a stranger reads 404). */
    async sourcesForUser(userId: string, nodeId: string): Promise<FleetLogSourcesResponse> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.sources({ kind: 'user', userId }, nodeId);
    }

    async sources(caller: FleetLinkCaller, nodeId: string): Promise<FleetLogSourcesResponse> {
        const outcome = await this.link.request<FleetLogSourceList>({
            nodeId,
            verb: FLEET_LOGS_SOURCES_VERB,
            caller,
            requirement: { actionFamily: 'logs', stateChanging: false },
            timeoutMs: 15_000,
        });
        if (outcome.operationId !== undefined) {
            throw fleetLinkError(
                'unreachable',
                'the computer did not list its logs in time; try again',
                {
                    nodeId,
                },
            );
        }
        return { nodeId, ...sanitizeFleetLogSourceList(outcome.result) };
    }

    // ─── Attach (the browser's viewer) ─────────────────────────────────────

    async mintForUser(
        userId: string,
        nodeId: string,
        input: { source: string; sources?: string[]; lines?: number; follow?: boolean },
    ): Promise<FleetLogsAttachGrant> {
        const { view } = await this.fleet.getVisibleForUser(userId, nodeId);
        const parsed = parseFleetLogsOpenParams({
            source: input.source,
            ...(input.sources ? { sources: input.sources } : {}),
            lines: input.lines,
            follow: input.follow === true,
        });
        if (!parsed) {
            throw fleetLinkError(
                'invalid',
                'source — pick one from the list, or a path under a shared folder',
                {
                    field: 'source',
                },
            );
        }
        this.assertUnderChannelCap(userId, nodeId, view.name);
        const params: Record<string, unknown> = {
            source: parsed.sources[0],
            lines: parsed.lines,
            follow: parsed.follow,
        };
        if (parsed.sources.length > 1) params.sources = parsed.sources.slice(1);
        const grant = await this.attach.mint({
            nodeId,
            family: 'logs',
            target: nodeId,
            role: 'viewer',
            caller: { kind: 'user', userId },
            params,
            requirement: { actionFamily: 'logs', stateChanging: false },
        });
        return {
            token: grant.token,
            wsPath: grant.wsPath,
            expiresInSec: grant.expiresInSec,
            sources: parsed.sources,
            lines: parsed.lines,
            follow: parsed.follow,
        };
    }

    private assertUnderChannelCap(userId: string, nodeId: string, nodeName: string): void {
        let open = 0;
        for (const slot of this.viewers.values()) {
            if (slot.userId === userId && slot.nodeId === nodeId) open += 1;
        }
        if (open >= FLEET_LOGS_MAX_CHANNELS_PER_VIEWER) {
            throw fleetLinkError(
                'limit_exceeded',
                `Close one of the ${FLEET_LOGS_MAX_CHANNELS_PER_VIEWER} open logs on ${nodeName}`,
                { limit: FLEET_LOGS_MAX_CHANNELS_PER_VIEWER },
            );
        }
    }

    // ─── The viewer observer (FL-02 gateway, family `logs`) ────────────────

    async admit(viewer: FleetLinkViewerHandle): Promise<void> {
        const { userId, nodeId, params } = viewer.claims;
        const node = await this.nodes.findById(nodeId).catch(() => null);
        this.assertUnderChannelCap(userId, nodeId, node?.name ?? 'this computer');
        const parsed = parseFleetLogsOpenParams(params);
        this.viewers.set(viewer.id, {
            userId,
            nodeId,
            sources: parsed?.sources ?? [],
            follow: parsed?.follow === true,
            audited: false,
        });
    }

    closed(viewer: FleetLinkViewerHandle): void {
        this.viewers.delete(viewer.id);
    }

    nodeMessage(viewer: FleetLinkViewerHandle, message: Record<string, unknown>): void {
        const parsed = parseFleetLogsChannelMessage(message);
        if (parsed?.type !== 'logs.initial-done') return;
        const slot = this.viewers.get(viewer.id);
        if (!slot || slot.audited) return;
        slot.audited = true;
        void this.recordRead(
            slot.nodeId,
            { kind: 'user', userId: slot.userId },
            slot.sources,
            parsed,
            'viewer',
        );
    }

    // ─── One-shot read (REST, MCP, Agents) ─────────────────────────────────

    async readForUser(
        userId: string,
        nodeId: string,
        input: { source: string; lines?: number; filter?: string | null },
    ): Promise<FleetLogsReadResult> {
        await this.fleet.getVisibleForUser(userId, nodeId);
        return this.readOnce({ kind: 'user', userId }, nodeId, input);
    }

    /** {@link FleetLogsReaderPort}: the Agent tool's list (gated on the owner's `logs` audience). */
    listSources(caller: FleetLogsAgentCaller, nodeId: string): Promise<FleetLogSourcesResponse> {
        return this.sources(
            { kind: 'agent', agentId: caller.agentId, ownerUserId: caller.ownerUserId },
            nodeId,
        );
    }

    /** {@link FleetLogsReaderPort}: the Agent tool's read, audited `agent:<id>`. */
    read(
        caller: FleetLogsAgentCaller,
        nodeId: string,
        input: { source: string; lines: number; filter: string | null },
    ): Promise<FleetLogsReadResult> {
        return this.readOnce(
            { kind: 'agent', agentId: caller.agentId, ownerUserId: caller.ownerUserId },
            nodeId,
            input,
        );
    }

    async readOnce(
        caller: FleetLinkCaller,
        nodeId: string,
        input: { source: string; lines?: number; filter?: string | null },
    ): Promise<FleetLogsReadResult> {
        const ref = parseFleetLogSourceId(input.source);
        if (!ref) {
            await this.recordRefusal(nodeId, caller, input.source, 'invalid');
            throw fleetLinkError(
                'invalid',
                "Only files under this computer's shared folders and standard log directories can be read",
                { field: 'source' },
            );
        }
        const lines = clampFleetLogsLines(input.lines ?? FLEET_LOGS_INITIAL_LINES);
        const filter = input.filter && input.filter.length > 0 ? input.filter : null;
        const node = await this.nodes.findById(nodeId).catch(() => null);
        const nodeName = node?.name ?? 'the computer';

        const collected: FleetLogLine[] = [];
        let done: FleetLogsInitialDone | null = null;
        let closedWith: { reason: FleetLinkCloseReason; hint?: string } | null = null;
        let channelRef: FleetLinkChannel | null = null;
        let carry = '';
        const decoder = new TextDecoder();
        let finish: () => void = () => undefined;
        const finished = new Promise<void>((resolve) => {
            finish = resolve;
        });

        let channel: FleetLinkChannel;
        try {
            channel = await this.link.openChannel({
                nodeId,
                family: 'logs',
                params: { source: input.source, lines },
                caller,
                requirement: { actionFamily: 'logs', stateChanging: false },
                events: {
                    binary: (kind, payload) => {
                        if (kind !== FLEET_LINK_FRAME_KINDS.DATA) return;
                        carry += decoder.decode(payload, { stream: true });
                        const cut = carry.lastIndexOf('\n');
                        if (cut >= 0) {
                            for (const line of parseFleetLogLines(carry.slice(0, cut + 1))) {
                                if (collected.length < FLEET_LOGS_INITIAL_LINES)
                                    collected.push(line);
                            }
                            carry = carry.slice(cut + 1);
                        }
                        // Credit back what was consumed: a batch never stalls on the window.
                        const ack = encodeFleetLinkAck(payload.byteLength);
                        if (ack) channelRef?.sendBinary(FLEET_LINK_FRAME_KINDS.ACK, ack);
                    },
                    json: (message) => {
                        const parsed = parseFleetLogsChannelMessage(message);
                        if (parsed?.type === 'logs.initial-done') {
                            done = parsed;
                            finish();
                        }
                    },
                    close: (reason, hint) => {
                        closedWith = { reason, ...(hint ? { hint } : {}) };
                        finish();
                    },
                },
            });
        } catch (error) {
            if (error instanceof FleetLinkException) {
                await this.recordRefusal(nodeId, caller, input.source, error.code);
            }
            throw error;
        }
        channelRef = channel;
        const timer = setTimeout(finish, FLEET_LOGS_READ_ABANDON_MS);
        timer.unref?.();
        try {
            channel.sendJson({ type: 'logs.read', lines });
            await finished;
        } finally {
            clearTimeout(timer);
            if (!channel.isClosed) channel.close('normal');
        }

        const batch = done as FleetLogsInitialDone | null;
        if (!batch) {
            const close = closedWith as { reason: FleetLinkCloseReason; hint?: string } | null;
            const error = close
                ? closeAsError(close.reason, close.hint, nodeName)
                : fleetLinkError(
                      'unreachable',
                      `${nodeName} did not answer within ${FLEET_LOGS_READ_ABANDON_MS / 1000} seconds`,
                      { nodeId },
                  );
            await this.recordRefusal(nodeId, caller, input.source, error.code);
            throw error;
        }
        if (batch.error && collected.length === 0) {
            const code = isFleetLinkErrorCode(batch.error.code)
                ? batch.error.code
                : 'operation_failed';
            await this.recordRefusal(nodeId, caller, input.source, code);
            throw fleetLinkError(code, batch.error.hint || `${nodeName} could not read that log`);
        }
        await this.recordRead(nodeId, caller, [input.source], batch, 'read');
        const kept = collected.filter((line) => fleetLogLineMatches(line, filter));
        return {
            nodeId,
            source: input.source,
            lines: kept,
            count: collected.length,
            matched: kept.length,
            truncated: batch.scanLimited,
            redactions: collected.reduce((sum, line) => sum + line.redactions, 0),
            filter,
        };
    }

    // ─── Audit ─────────────────────────────────────────────────────────────

    private async recordRead(
        nodeId: string,
        caller: FleetLinkCaller,
        sources: readonly string[],
        batch: FleetLogsInitialDone,
        via: 'viewer' | 'read',
    ): Promise<void> {
        if (!this.audit) return;
        const node = await this.nodes.findById(nodeId).catch(() => null);
        const source = sources[0] ?? null;
        const ref = source ? parseFleetLogSourceId(source) : null;
        const details = {
            source,
            ...(sources.length > 1 ? { sources: [...sources] } : {}),
            kind: ref?.kind ?? null,
            requestedBy: describeFleetLinkCaller(caller),
            lines: batch.count,
            redactions: batch.redactions,
            confirmationClass: 'plain',
            via,
            outcome: batch.error ? 'failed' : 'read',
            ...(batch.error ? { code: batch.error.code } : {}),
        };
        const actorUserId = fleetLinkCallerUserId(caller);
        await this.audit.tryRecord({
            action: 'node.logs.read',
            actorUserId,
            ownerUserId: node?.userId ?? null,
            nodeId,
            details,
        });
        if (batch.following) {
            await this.audit.tryRecord({
                action: 'node.logs.follow',
                actorUserId,
                ownerUserId: node?.userId ?? null,
                nodeId,
                details: { ...details, outcome: 'following' },
            });
        }
    }

    /** U14: a refused read is audited too — the source asked for and the code, never more. */
    private async recordRefusal(
        nodeId: string,
        caller: FleetLinkCaller,
        source: unknown,
        code: string,
    ): Promise<void> {
        if (!this.audit) return;
        const node = await this.nodes.findById(nodeId).catch(() => null);
        if (!node) return; // an unknown computer leaves no row about itself
        const id = typeof source === 'string' ? source.slice(0, 400) : null;
        await this.audit.tryRecord({
            action: 'node.logs.read',
            actorUserId: fleetLinkCallerUserId(caller),
            ownerUserId: node.userId,
            nodeId,
            details: {
                source: id,
                kind: id ? (parseFleetLogSourceId(id)?.kind ?? null) : null,
                requestedBy: describeFleetLinkCaller(caller),
                lines: 0,
                redactions: 0,
                confirmationClass: 'plain',
                via: 'read',
                outcome: 'refused',
                code,
            },
        });
    }
}
