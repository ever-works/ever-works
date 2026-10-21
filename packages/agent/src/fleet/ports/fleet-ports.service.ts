import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    effectiveConsents,
    FLEET_PORT_PREVIEW_MAX_MS,
    FLEET_PORTS_LINK_VERBS,
    isFleetPortNumber,
    isFleetPortOpenTarget,
    normalizeFleetPortsList,
    parseFleetPortWatchList,
    type FleetPortOpenNodeResult,
    type FleetPortOpenResult,
    type FleetPortOpenTarget,
    type FleetPortsListResponse,
} from '@ever-works/contracts';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { fleetPortsError, readFleetPortsError } from './fleet-ports.errors';
import {
    FLEET_PORTS_NODE_PORT,
    type FleetPortsCaller,
    type FleetPortsNodePort,
} from './fleet-ports-node.port';
import { fleetPortTargetRefusal, resolveFleetPortOpenTargets } from './fleet-ports.policy';
import { FleetPortTunnelService } from './fleet-port-tunnel.service';
import { INBOX_PRODUCER, type InboxProducer } from '../../inbox/inbox-producer.port';

/** At most one watched-port Inbox item per person, computer and port in this long. */
const WATCH_NOTICE_EVERY_MS = 5 * 60_000;

/**
 * Servers and ports (FL-10, P1) — list what a computer is listening on, and
 * open one of its servers ON THE MACHINE (CONTRACTS R-3).
 *
 * Order of every call (spec FR-16 … FR-19):
 *
 *  1. existence and audience — `view` to list, `ports` to open (CONTRACTS
 *     §2.1), plus `desktop` for "Open on the desktop" (U4); a computer the
 *     caller may not see is the same 404 as one that does not exist;
 *  2. the kind of computer — the desktop node app and cluster nodes do not
 *     list ports yet (`unsupported_on_node`, R-10, spec U16);
 *  3. for an open: the target — the desktop when it is available, else the
 *     preview browser — and why the one asked for is not (consent `attend`,
 *     the owner's preview switch, no browser, no desktop);
 *  4. the link's own gate (`FleetLinkService.request`, through the port):
 *     the link flag, the kill switch, the verb's consent (`manage`) against
 *     the consents the live link presented, the family audience, connected;
 *  5. the node's own refusal (`busy` for a second preview, …), carried back
 *     as the same CONTRACTS §8 error.
 *
 * Listing is a read: nothing stored, nothing audited (FR-8, spec S11). Every
 * open writes ONE `node.port.open` row (FR-14): port, target, program or
 * container, requester, class `plain` — never the URL's query or the page.
 */

/** Who acts: a person, or an Agent for its owner. */
export type FleetPortsActor =
    | { kind: 'user'; userId: string; displayName?: string | null }
    | { kind: 'agent'; agentId: string; ownerUserId: string; agentName?: string | null };

export interface FleetPortsOpenInput {
    target?: FleetPortOpenTarget;
    scheme?: 'http' | 'https';
}

/** How long one `ports.list` may take on the machine (discovery + 32 probes of 2 s). */
export const FLEET_PORTS_LIST_TIMEOUT_MS = 20_000;
/** How long one `ports.open` may take (a preview browser starts). */
export const FLEET_PORTS_OPEN_TIMEOUT_MS = 30_000;

function actorUserId(actor: FleetPortsActor): string {
    return actor.kind === 'user' ? actor.userId : actor.ownerUserId;
}

function callerOf(actor: FleetPortsActor): FleetPortsCaller {
    return actor.kind === 'user'
        ? { kind: 'user', userId: actor.userId }
        : { kind: 'agent', agentId: actor.agentId, ownerUserId: actor.ownerUserId };
}

function requestedBy(actor: FleetPortsActor): string {
    return actor.kind === 'user' ? `user:${actor.userId}` : `agent:${actor.agentId}`;
}

@Injectable()
export class FleetPortsService {
    private readonly logger = new Logger(FleetPortsService.name);

    constructor(
        private readonly access: FleetAccessService,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() @Inject(FLEET_PORTS_NODE_PORT) private readonly node?: FleetPortsNodePort,
        // Phase 2 — the person's open tunnels on this computer, for the rows.
        // APPENDED LAST + @Optional(): absent, the list carries no tunnel state.
        @Optional() private readonly tunnels?: FleetPortTunnelService,
        // Phase 3 — the Inbox item when a watched server stops (FR-33).
        // APPENDED LAST + @Optional(): absent, only the tab's inline notice shows.
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
    ) {}

    /** Watched-port notices already filed, per person, computer and port (one per 5 minutes). */
    private readonly watchNotices = new Map<string, number>();

    /**
     * Phase 3 (FL-10, FR-33, spec §3.1) — a server the person was WATCHING
     * (`Open a port…` or **Watch**) stopped: one Inbox item "The server on
     * :5173 on build-01 stopped". The tab that watched it reports it (watching
     * is a tab's state, not the machine's); the platform checks the person may
     * see the computer, files at most one item per port per five minutes, and
     * never says more than the sentence.
     */
    async watchStopped(nodeId: string, portNumber: number, actor: FleetPortsActor): Promise<{ filed: boolean }> {
        if (!isFleetPortNumber(portNumber)) {
            throw fleetPortsError('invalid', 'a port is a number from 1 to 65535', { field: 'port' });
        }
        const userId = actorUserId(actor);
        const { node } = await this.access.resolveForFamily(nodeId, userId, 'view');
        if (!this.inbox) return { filed: false };
        const key = `${userId}:${node.id}:${portNumber}`;
        const now = Date.now();
        for (const [entry, at] of this.watchNotices) if (now - at > WATCH_NOTICE_EVERY_MS) this.watchNotices.delete(entry);
        if (this.watchNotices.has(key)) return { filed: false };
        this.watchNotices.set(key, now);
        try {
            await this.inbox.notice(userId, {
                title: `The server on :${portNumber} on ${node.name} stopped`,
                body: `Nothing listens on :${portNumber} on ${node.name} any more. Open the computer's Ports tab to see what is running there.`,
                organizationId: node.organizationId ?? null,
            });
            return { filed: true };
        } catch (error) {
            this.logger.warn(
                `watched-port notice for node ${node.id} not filed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return { filed: false };
        }
    }

    /** The computer's listening ports, web servers first, with what Open can do for this caller. */
    async list(
        nodeId: string,
        actor: FleetPortsActor,
        options: { watch?: unknown } = {},
    ): Promise<FleetPortsListResponse> {
        const userId = actorUserId(actor);
        const { node } = await this.access.resolveForFamily(nodeId, userId, 'view');
        this.assertKind(node);
        const port = this.requirePort();
        const watch = parseFleetPortWatchList(options.watch);
        const raw = await port.request({
            nodeId: node.id,
            verb: FLEET_PORTS_LINK_VERBS.list,
            params: watch.length > 0 ? { watch } : {},
            caller: callerOf(actor),
            actionFamily: 'view',
            stateChanging: false,
            timeoutMs: FLEET_PORTS_LIST_TIMEOUT_MS,
        });
        const list = normalizeFleetPortsList(raw);
        if (!list) {
            throw fleetPortsError(
                'operation_failed',
                `${node.name} answered the port list in a way this platform does not understand`,
            );
        }
        const decision = await this.decide(node, userId);
        const response: FleetPortsListResponse = {
            ...list,
            nodeId: node.id,
            nodeName: node.name,
            canOpen: decision.canPorts,
            targets: decision.targets,
            defaultTarget: decision.defaultTarget,
        };
        if (this.tunnels?.isEnabled()) {
            response.tunnel = {
                available: decision.canPorts,
                open: await this.tunnels.listOpenForNode(node.id, userId).catch(() => []),
            };
        }
        return response;
    }

    /** Open `port` on the machine: on its desktop, or in its preview browser. */
    async open(
        nodeId: string,
        portNumber: number,
        actor: FleetPortsActor,
        input: FleetPortsOpenInput = {},
    ): Promise<FleetPortOpenResult> {
        if (!isFleetPortNumber(portNumber)) {
            throw fleetPortsError('invalid', 'a port is a number from 1 to 65535', { field: 'port' });
        }
        if (input.target !== undefined && !isFleetPortOpenTarget(input.target)) {
            throw fleetPortsError('invalid', 'target is desktop or preview-profile', { field: 'target' });
        }
        const userId = actorUserId(actor);
        const { node } = await this.access.resolveForFamily(nodeId, userId, 'ports');
        this.assertKind(node);
        const link = this.requirePort();
        const decision = await this.decide(node, userId);
        const target = input.target ?? decision.defaultTarget ?? 'preview-profile';
        const state = decision.targets[target];
        if (!state.available) {
            const refusal = fleetPortTargetRefusal(target, state, node.name);
            throw fleetPortsError(refusal.code, refusal.hint, refusal.details);
        }

        const viewId = target === 'preview-profile' ? `pv-${randomUUID()}` : undefined;
        const holder =
            actor.kind === 'user'
                ? (actor.displayName ?? '').trim() || 'Someone'
                : (actor.agentName ?? '').trim() || 'An agent';
        let reply: FleetPortOpenNodeResult;
        try {
            reply = (await link.request({
                nodeId: node.id,
                verb: FLEET_PORTS_LINK_VERBS.open,
                params: {
                    port: portNumber,
                    target,
                    ...(input.scheme === 'https' ? { scheme: 'https' } : {}),
                    ...(viewId ? { viewId, holder: holder.slice(0, 80) } : {}),
                },
                caller: callerOf(actor),
                actionFamily: 'ports',
                stateChanging: true,
                target: `:${portNumber}`,
                timeoutMs: FLEET_PORTS_OPEN_TIMEOUT_MS,
            })) as FleetPortOpenNodeResult;
        } catch (error) {
            const refused = readFleetPortsError(error);
            await this.auditOpen(node, actor, portNumber, target, null, 'refused', refused?.code ?? 'internal');
            throw error;
        }

        const result: FleetPortOpenResult = {
            target,
            url: typeof reply?.url === 'string' ? reply.url : `http://127.0.0.1:${portNumber}/`,
        };
        // The machine opened it: that is the act, audited once, before anything
        // else can fail (a viewer token that cannot be minted leaves a preview
        // nobody watches, which the machine ends 30 s later).
        await this.auditOpen(node, actor, portNumber, target, reply ?? null, 'opened');
        if (target === 'preview-profile' && viewId) {
            result.previewViewId = viewId;
            result.endsAt = new Date(Date.now() + FLEET_PORT_PREVIEW_MAX_MS).toISOString();
            // The picture is for the person who opened it — an Agent cannot
            // watch; its owner sees the open in the Activity log.
            if (actor.kind === 'user') {
                result.attach = await link.mintPreviewAttach({ nodeId: node.id, viewId, userId: actor.userId });
            }
        }
        return result;
    }

    private async decide(node: FleetNode, userId: string) {
        const [canPorts, canDesktop] = await Promise.all([
            this.access.canAct(node, userId, 'ports'),
            this.access.canAct(node, userId, 'desktop'),
        ]);
        const consents =
            this.node?.liveConsents(node.id) ??
            effectiveConsents({
                consents: node.consents,
                capabilities: node.capabilities,
                workerState: node.workerState,
            });
        const decision = resolveFleetPortOpenTargets({
            consents,
            capabilities: Array.isArray(node.capabilities) ? node.capabilities : [],
            previewProfileEnabled: Boolean(node.previewProfileEnabled),
            canPorts,
            canDesktop,
        });
        return { ...decision, canPorts };
    }

    private assertKind(node: FleetNode): void {
        if (node.kind !== 'node') {
            throw fleetPortsError(
                'unsupported_on_node',
                'Not available on this kind of node yet — run the headless node (ever-works-node) on this computer',
                { kind: node.kind },
            );
        }
    }

    private requirePort(): FleetPortsNodePort {
        if (!this.node) {
            throw fleetPortsError('unreachable', 'this process cannot reach computers');
        }
        return this.node;
    }

    private async auditOpen(
        node: FleetNode,
        actor: FleetPortsActor,
        port: number,
        target: FleetPortOpenTarget,
        reply: FleetPortOpenNodeResult | null,
        outcome: 'opened' | 'refused',
        code?: string,
    ): Promise<void> {
        if (!this.audit) return;
        const recorded = await this.audit.tryRecord({
            action: 'node.port.open',
            actorUserId: actor.kind === 'user' ? actor.userId : actor.ownerUserId,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: {
                family: 'ports',
                port,
                target,
                program: reply?.program ?? null,
                container: reply?.container ?? null,
                requestedBy: requestedBy(actor),
                confirmationClass: 'plain',
                outcome,
                ...(code ? { code } : {}),
            },
        });
        if (!recorded) this.logger.warn(`node.port.open for node ${node.id} could not be audited`);
    }
}
