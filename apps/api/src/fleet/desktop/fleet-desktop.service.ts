import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { config } from '@ever-works/agent/config';
import { ComputerSessionRepository, resolveComputerSessionLimits } from '@ever-works/agent/computer';
import {
    FleetAccessService,
    FleetAuditService,
    FleetKillSwitchService,
    FleetNodeRepository,
    fleetNodeDesktopViewOf,
    type FleetNode,
} from '@ever-works/agent/fleet';
import {
    decodeComputerFrame,
    effectiveConsents,
    fleetConsentMissingHint,
    fleetDesktopReasonHint,
    isFleetDesktopReason,
    normalizeFleetHelperTrust,
    pickFleetDisplay,
    resolveFleetDesktopBlocker,
    FLEET_DESKTOP_BLOCKER_CODES,
    FLEET_DESKTOP_VIEW_CEILING_MS,
    FLEET_LINK_FRAME_KINDS,
    FLEET_SCREEN_CAPABILITY,
    type ComputerQuality,
    type FleetDesktopAttachGrant,
    type FleetDesktopAvailabilityView,
    type FleetDesktopBlocker,
    type FleetDesktopOpenRequest,
    type FleetDesktopOpenResult,
    type FleetDesktopScreenshot,
    type FleetDesktopUpdateRequest,
    type FleetDesktopViewView,
    type FleetDisplayView,
} from '@ever-works/contracts';
import { FleetLinkAttachService } from '../../fleet-link/fleet-link-attach.service';
import { describeAgo, fleetLinkError, FleetLinkException } from '../../fleet-link/fleet-link.errors';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import {
    FleetLinkViewerGatewayService,
    type FleetLinkViewerHandle,
    type FleetLinkViewerObserver,
} from '../../fleet-link/fleet-link-viewer-gateway.service';

/**
 * Desktop view & control (FL-07, plan §5, CONTRACTS §11.2) — the platform's
 * half of a Desktop-source view.
 *
 * A view is ONE viewer socket on FL-02's viewer gateway
 * (`/ws/fleet/desktop/<viewId>`) bridged to ONE `desktop` channel on the node's
 * link: opening a view here checks everything, writes `node.desktop.view`, and
 * mints the single-use, 60-second viewer token (FL-02's one minter, which
 * authorises again: existence → kill switch → consent → the `desktop` family
 * audience); the channel itself opens when the browser presents the token, and
 * the node — verifying its helper a moment before — starts the picture.
 *
 * Gate order for an open (CONTRACTS §2.1, the first refusal is the one named):
 * the flag (guard) → existence (`view` audience, else 404) → kill switch →
 * kind → reachability → `--attend` → the `desktop` audience (R-25: one family
 * governs watching and controlling) → the machine's own reasons → the link →
 * the caps (AW-11's 2 per computer / 5 per Organization, counted across BOTH
 * sources, FR-33). Watching is read-only: the token's role is `viewer`, so the
 * gateway forwards no `INPUT` and only the family's view controls (quality,
 * refresh, displays); control (`driver`) is P2.
 *
 * Views are kept per API replica (the viewer gateway's own unit): a view is
 * live while its socket is open, reserved for 90 s after a grant, and ends at
 * the 4-hour ceiling (the gateway closes it on the next ping). The node caps
 * its own Desktop streams at two, whichever replica asked.
 */

/** A granted view with no socket yet stays reserved (and counted) this long. */
export const DESKTOP_VIEW_RESERVE_MS = 90_000;
/** A screenshot waits this long for the first picture. */
export const DESKTOP_SCREENSHOT_TIMEOUT_MS = 10_000;

interface DesktopViewRecord {
    viewId: string;
    nodeId: string;
    nodeName: string;
    /** The computer's owner (the personal-workspace cap counts per owner). */
    ownerUserId: string;
    userId: string;
    organizationId: string | null;
    displayId: string | null;
    quality: ComputerQuality;
    fleetSessionId: string | null;
    openedAt: number;
    lastGrantAt: number;
    sockets: number;
}

@Injectable()
export class FleetDesktopService implements OnApplicationBootstrap, FleetLinkViewerObserver {
    private readonly logger = new Logger(FleetDesktopService.name);
    private readonly views = new Map<string, DesktopViewRecord>();

    constructor(
        private readonly nodes: FleetNodeRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        private readonly audit: FleetAuditService,
        private readonly links: FleetLinkService,
        private readonly attach: FleetLinkAttachService,
        @Optional() private readonly sessions?: ComputerSessionRepository,
        @Optional() private readonly gateway?: FleetLinkViewerGatewayService,
    ) {}

    /** The wall clock (a method, so a spec can move it). */
    protected now(): number {
        return Date.now();
    }

    onApplicationBootstrap(): void {
        // One observer per family: the `desktop` family's views. FL-10's preview
        // picture rides the same family and is let through untouched.
        this.gateway?.registerObserver('desktop', this);
    }

    // ─── Availability, displays ─────────────────────────────────────────────

    async availability(userId: string, nodeId: string): Promise<FleetDesktopAvailabilityView> {
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const facts = fleetNodeDesktopViewOf(node);
        const blocker = await this.blockerFor(node, userId);
        return {
            nodeId: node.id,
            nodeName: node.name,
            available: blocker === null,
            blocker,
            hint: blocker ? this.hintFor(blocker, node) : null,
            reasons: facts?.reasons ?? [],
            helper: facts?.helper ?? null,
            displays: facts?.displays ?? [],
            lastSeenAt: node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).toISOString() : null,
            browserSourceAvailable:
                this.attended(node) && (node.capabilities ?? []).includes(FLEET_SCREEN_CAPABILITY),
            liveViews: this.liveDesktopViews((view) => view.nodeId === node.id),
            maxViews: resolveComputerSessionLimits(process.env).perNode,
        };
    }

    /** The displays the machine last reported — for people in its `desktop` audience. */
    async displays(userId: string, nodeId: string): Promise<FleetDisplayView[]> {
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        if (!(await this.access.canAct(node, { userId }, 'desktop'))) {
            throw fleetLinkError('permission_denied', this.hintFor('permission-denied', node), {
                actionFamily: 'desktop',
            });
        }
        if (!this.attended(node)) {
            throw fleetLinkError('consent_missing', fleetConsentMissingHint('attend', node.name), {
                consent: 'attend',
            });
        }
        return fleetNodeDesktopViewOf(node)?.displays ?? [];
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    async openView(
        userId: string,
        nodeId: string,
        request: FleetDesktopOpenRequest,
    ): Promise<FleetDesktopOpenResult> {
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const quality: ComputerQuality = request.quality ?? 'smooth';
        const blocker = await this.blockerFor(node, userId);
        if (blocker) {
            await this.auditView(node, userId, null, {
                outcome: 'refused',
                code: FLEET_DESKTOP_BLOCKER_CODES[blocker],
                reason: blocker,
                displayId: request.displayId ?? null,
                quality,
            });
            throw fleetLinkError(FLEET_DESKTOP_BLOCKER_CODES[blocker], this.hintFor(blocker, node), {
                reason: blocker,
            });
        }
        await this.assertWithinCaps(node);
        const facts = fleetNodeDesktopViewOf(node);
        const { display, fellBack } = pickFleetDisplay(facts?.displays ?? [], request.displayId ?? null);
        const now = this.now();
        const record: DesktopViewRecord = {
            viewId: randomUUID(),
            nodeId: node.id,
            nodeName: node.name,
            ownerUserId: node.userId,
            userId,
            organizationId: node.organizationId ?? null,
            displayId: display?.id ?? request.displayId ?? null,
            quality,
            fleetSessionId: request.fleetSessionId ?? null,
            openedAt: now,
            lastGrantAt: now,
            sockets: 0,
        };
        const attach = await this.mintFor(record);
        this.views.set(record.viewId, record);
        await this.auditView(node, userId, record.viewId, {
            outcome: 'opened',
            displayId: record.displayId,
            quality,
            fellBack,
        });
        return { view: this.viewOf(record), attach, display, fellBack };
    }

    viewFor(userId: string, nodeId: string, viewId: string): FleetDesktopViewView {
        return this.viewOf(this.ownView(userId, nodeId, viewId));
    }

    /** Another display or quality: a fresh grant the browser re-attaches with. */
    async updateView(
        userId: string,
        nodeId: string,
        viewId: string,
        update: FleetDesktopUpdateRequest,
    ): Promise<FleetDesktopOpenResult> {
        const record = this.ownView(userId, nodeId, viewId);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const blocker = await this.blockerFor(node, userId);
        if (blocker) {
            throw fleetLinkError(FLEET_DESKTOP_BLOCKER_CODES[blocker], this.hintFor(blocker, node), {
                reason: blocker,
            });
        }
        const facts = fleetNodeDesktopViewOf(node);
        let display: FleetDisplayView | null = null;
        let fellBack = false;
        if (update.displayId !== undefined) {
            const displays = facts?.displays ?? [];
            if (displays.length > 0 && !displays.some((entry) => entry.id === update.displayId)) {
                throw fleetLinkError('unsupported_on_node', `${node.name} has no display "${update.displayId}"`, {
                    displayId: update.displayId,
                });
            }
            const previous = record.displayId;
            ({ display, fellBack } = pickFleetDisplay(displays, update.displayId));
            record.displayId = display?.id ?? update.displayId;
            if (record.displayId !== previous) {
                await this.recordAudit(node, userId, 'node.desktop.display.set', record.viewId, {
                    outcome: 'done',
                    displayId: record.displayId,
                    previousDisplayId: previous,
                });
            }
        } else {
            ({ display, fellBack } = pickFleetDisplay(facts?.displays ?? [], record.displayId));
        }
        if (update.quality) record.quality = update.quality;
        const attach = await this.mintFor(record);
        return { view: this.viewOf(record), attach, display, fellBack };
    }

    /** A reconnect of the same view (the socket dropped): a fresh single-use grant. */
    async attachToken(userId: string, nodeId: string, viewId: string): Promise<FleetDesktopAttachGrant> {
        const record = this.ownView(userId, nodeId, viewId);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const blocker = await this.blockerFor(node, userId);
        if (blocker) {
            throw fleetLinkError(FLEET_DESKTOP_BLOCKER_CODES[blocker], this.hintFor(blocker, node), {
                reason: blocker,
            });
        }
        return this.mintFor(record);
    }

    /** End a view (idempotent); its socket, if any, closes when the browser leaves. */
    endView(userId: string, nodeId: string, viewId: string): void {
        const record = this.views.get(viewId);
        if (record && record.userId === userId && record.nodeId === nodeId) this.views.delete(viewId);
    }

    // ─── Screenshot (the read-only Agent tool's read) ───────────────────────

    /** One Steady-width keyframe of a display, through a short-lived channel. */
    async screenshot(userId: string, nodeId: string, displayId: string | null): Promise<FleetDesktopScreenshot> {
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const blocker = await this.blockerFor(node, userId);
        if (blocker) {
            throw fleetLinkError(FLEET_DESKTOP_BLOCKER_CODES[blocker], this.hintFor(blocker, node), {
                reason: blocker,
            });
        }
        await this.assertWithinCaps(node);
        const viewId = randomUUID();
        let settle: (picture: { width: number; height: number; mime: FleetDesktopScreenshot['mime']; data: string } | null) => void =
            () => undefined;
        const pictured = new Promise<{ width: number; height: number; mime: FleetDesktopScreenshot['mime']; data: string } | null>(
            (resolve) => {
                settle = resolve;
            },
        );
        let closeHint: string | null = null;
        const channel = await this.links.openChannel({
            nodeId: node.id,
            family: 'desktop',
            params: {
                source: 'desktop',
                viewId,
                quality: 'steady',
                ...(displayId ? { display: displayId } : {}),
            },
            caller: { kind: 'user', userId },
            requirement: { stateChanging: false, target: viewId },
            events: {
                binary: (kind, payload) => {
                    if (kind !== FLEET_LINK_FRAME_KINDS.FRAME) return;
                    const frame = decodeComputerFrame(payload);
                    if (frame && frame.kind === 'frame') {
                        settle({ width: frame.width, height: frame.height, mime: frame.mime, data: frame.data });
                    }
                },
                close: (_reason, hint) => {
                    closeHint = hint ?? null;
                    settle(null);
                },
            },
        });
        const timer = setTimeout(() => settle(null), DESKTOP_SCREENSHOT_TIMEOUT_MS);
        timer.unref?.();
        const picture = await pictured;
        clearTimeout(timer);
        channel.close('normal');
        await this.auditView(node, userId, viewId, {
            outcome: picture ? 'done' : 'failed',
            purpose: 'screenshot',
            displayId,
            quality: 'steady',
        });
        if (!picture) {
            throw fleetLinkError(
                'operation_failed',
                closeHint ?? `${node.name} did not send a picture in time — try again`,
            );
        }
        return {
            nodeId: node.id,
            displayId,
            width: picture.width,
            height: picture.height,
            mime: picture.mime,
            data: picture.data,
            bytes: Math.floor((picture.data.length * 3) / 4),
            takenAt: new Date(this.now()).toISOString(),
        };
    }

    // ─── The viewer gateway observer (family `desktop`) ─────────────────────

    admit(viewer: FleetLinkViewerHandle): void {
        if (viewer.claims.params.source !== 'desktop') return;
        const record = this.views.get(viewer.claims.target);
        if (!record || record.userId !== viewer.claims.userId || record.nodeId !== viewer.claims.nodeId) {
            throw fleetLinkError('not_found', 'this desktop view has ended — open it again');
        }
        if (this.now() - record.openedAt >= FLEET_DESKTOP_VIEW_CEILING_MS) {
            this.views.delete(record.viewId);
            throw fleetLinkError('limit_exceeded', 'a desktop view lasts at most 4 hours — open a new one', {
                limit: 'view-ceiling',
            });
        }
    }

    opened(viewer: FleetLinkViewerHandle): void {
        const record = this.desktopRecordOf(viewer);
        if (record) record.sockets += 1;
    }

    closed(viewer: FleetLinkViewerHandle): void {
        const record = this.desktopRecordOf(viewer);
        if (!record) return;
        record.sockets = Math.max(0, record.sockets - 1);
        record.lastGrantAt = this.now();
    }

    /** Re-checked on every ping: the flag, the ceiling, and the viewer's place in the `desktop` audience. */
    async stillAllowed(viewer: FleetLinkViewerHandle): Promise<boolean> {
        if (viewer.claims.params.source !== 'desktop') return true;
        const record = this.views.get(viewer.claims.target);
        if (!record || !config.fleet.isDesktopEnabled()) return false;
        if (this.now() - record.openedAt >= FLEET_DESKTOP_VIEW_CEILING_MS) {
            this.views.delete(record.viewId);
            return false;
        }
        try {
            const node = await this.nodes.findById(record.nodeId);
            if (!node) return false;
            return await this.access.canAct(node, { userId: record.userId }, 'desktop');
        } catch {
            // Unreadable right now: keep the view; the next ping asks again.
            return true;
        }
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    private desktopRecordOf(viewer: FleetLinkViewerHandle): DesktopViewRecord | null {
        if (viewer.claims.params.source !== 'desktop') return null;
        return this.views.get(viewer.claims.target) ?? null;
    }

    private attended(node: FleetNode): boolean {
        return (
            this.links.liveConsents(node.id)?.attend ??
            effectiveConsents({
                consents: node.consents ?? null,
                capabilities: node.capabilities ?? null,
                workerState: node.workerState ?? null,
            }).attend
        );
    }

    private online(node: FleetNode): boolean {
        if (node.status !== 'online' && node.status !== 'paused') return false;
        const last = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : NaN;
        return Number.isFinite(last) && this.now() - last <= config.fleet.getNodeOfflineAfterMs();
    }

    private async blockerFor(node: FleetNode, userId: string): Promise<FleetDesktopBlocker | null> {
        let stopped: boolean;
        try {
            stopped = await this.killSwitch.isStopped();
        } catch {
            stopped = true; // fail-closed, as the link authoriser reads it
        }
        const facts = fleetNodeDesktopViewOf(node);
        return resolveFleetDesktopBlocker({
            killSwitch: stopped,
            kind: node.kind,
            online: this.online(node),
            attend: this.attended(node),
            inDesktopAudience: await this.access.canAct(node, { userId }, 'desktop'),
            reasons: facts?.reasons ?? [],
            helperTrust: normalizeFleetHelperTrust(node.helperTrust),
            linkConnected: config.fleet.isNodeLinkEnabled() && this.links.isConnected(node.id),
        });
    }

    private hintFor(blocker: FleetDesktopBlocker, node: FleetNode): string {
        switch (blocker) {
            case 'kill-switch':
                return 'clear it under Settings → Fleet';
            case 'offline': {
                const ago = describeAgo(node.lastHeartbeatAt ?? null, this.now());
                return ago ? `${node.name} is offline; last heard from ${ago} ago` : `${node.name} is offline`;
            }
            case 'consent-missing':
                return fleetConsentMissingHint('attend', node.name);
            case 'permission-denied':
                return `Only the owner of ${node.name} can see its screen. Ask them to allow organization members: desktop`;
            case 'link-unavailable':
                return `${node.name} is not connected to Ever Works right now; it reconnects on its own — try again in a moment`;
            default:
                return isFleetDesktopReason(blocker) ? fleetDesktopReasonHint(blocker, node.name) : blocker;
        }
    }

    /** AW-11's caps, across BOTH sources (FR-33): open computer sessions + live desktop views. */
    private async assertWithinCaps(node: FleetNode): Promise<void> {
        const limits = resolveComputerSessionLimits(process.env);
        const organizationId = node.organizationId ?? null;
        const [onNode, inScope] = await Promise.all([
            this.sessions?.findOpenForNode(node.id) ?? Promise.resolve([]),
            this.sessions?.findOpenForScope({ userId: node.userId, organizationId }) ?? Promise.resolve([]),
        ]);
        const desktopOnNode = this.liveDesktopViews((view) => view.nodeId === node.id);
        if (onNode.length + desktopOnNode >= limits.perNode) {
            throw fleetLinkError(
                'limit_exceeded',
                `${node.name} is already showing ${limits.perNode} live views; close one first`,
                { limit: 'views-per-computer', max: limits.perNode },
            );
        }
        const desktopInScope = this.liveDesktopViews((view) =>
            organizationId
                ? view.organizationId === organizationId
                : view.organizationId === null && view.ownerUserId === node.userId,
        );
        if (inScope.length + desktopInScope >= limits.perOrganization) {
            throw fleetLinkError(
                'limit_exceeded',
                `${limits.perOrganization} live views are open in this Organization; close one first`,
                { limit: 'views-per-organization', max: limits.perOrganization },
            );
        }
    }

    /** Live (socket open) or reserved (granted in the last 90 s) desktop views on this replica. */
    private liveDesktopViews(match: (view: DesktopViewRecord) => boolean): number {
        const now = this.now();
        let count = 0;
        for (const view of [...this.views.values()]) {
            const live = view.sockets > 0 || now - view.lastGrantAt < DESKTOP_VIEW_RESERVE_MS;
            if (!live || now - view.openedAt >= FLEET_DESKTOP_VIEW_CEILING_MS) {
                if (view.sockets === 0) this.views.delete(view.viewId);
                continue;
            }
            if (match(view)) count += 1;
        }
        return count;
    }

    private ownView(userId: string, nodeId: string, viewId: string): DesktopViewRecord {
        const record = this.views.get(viewId);
        if (!record || record.userId !== userId || record.nodeId !== nodeId) {
            throw fleetLinkError('not_found', 'this desktop view has ended — open it again');
        }
        return record;
    }

    private async mintFor(record: DesktopViewRecord): Promise<FleetDesktopAttachGrant> {
        try {
            const grant = await this.attach.mint({
                nodeId: record.nodeId,
                family: 'desktop',
                target: record.viewId,
                // Watching is read-only (P1): a watcher's frames never reach the machine.
                role: 'viewer',
                caller: { kind: 'user', userId: record.userId },
                params: {
                    source: 'desktop',
                    viewId: record.viewId,
                    quality: record.quality,
                    ...(record.displayId ? { display: record.displayId } : {}),
                },
                requirement: { actionFamily: 'desktop', target: record.viewId },
            });
            record.lastGrantAt = this.now();
            return { token: grant.token, wsPath: grant.wsPath, expiresInSec: grant.expiresInSec, role: grant.role };
        } catch (error) {
            if (error instanceof FleetLinkException) throw error;
            this.logger.warn(
                `desktop view grant for node ${record.nodeId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw fleetLinkError('internal', 'the view could not be prepared — try again');
        }
    }

    private viewOf(record: DesktopViewRecord): FleetDesktopViewView {
        return {
            viewId: record.viewId,
            nodeId: record.nodeId,
            source: 'desktop',
            displayId: record.displayId,
            quality: record.quality,
            role: 'viewer',
            openedByUserId: record.userId,
            openedAt: new Date(record.openedAt).toISOString(),
            fleetSessionId: record.fleetSessionId,
        };
    }

    private async auditView(
        node: FleetNode,
        userId: string,
        viewId: string | null,
        extra: Record<string, unknown>,
    ): Promise<void> {
        await this.recordAudit(node, userId, 'node.desktop.view', viewId, extra);
    }

    private async recordAudit(
        node: FleetNode,
        userId: string,
        action: 'node.desktop.view' | 'node.desktop.display.set',
        viewId: string | null,
        extra: Record<string, unknown>,
    ): Promise<void> {
        try {
            await this.audit.recordNodeAction({
                action,
                actorUserId: userId,
                ownerUserId: node.userId,
                nodeId: node.id,
                extra: {
                    family: 'desktop',
                    target: viewId,
                    requestedBy: `user:${userId}`,
                    confirmationClass: 'plain',
                    source: 'desktop',
                    ...extra,
                },
            });
        } catch (error) {
            this.logger.warn(
                `fleet audit ${action} on node ${node.id} could not be written: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
