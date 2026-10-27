import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { config } from '@ever-works/agent/config';
import {
    ComputerControlArbiter,
    ComputerControlChangedEvent,
    ComputerSessionRepository,
    resolveComputerSessionLimits,
    resolveSessionExpiry,
    type ComputerControlActor,
    type ComputerControlOutcome,
    type ComputerSession,
} from '@ever-works/agent/computer';
import {
    FleetAccessService,
    FleetAuditService,
    FleetKillSwitchService,
    FleetNodeRepository,
    fleetNodeDesktopViewOf,
    type FleetDesktopAgentCaller,
    type FleetDesktopReaderPort,
    type FleetNode,
} from '@ever-works/agent/fleet';
import {
    COMPUTER_CONTROL_DISCONNECT_MS,
    decodeComputerFrame,
    effectiveConsents,
    fleetConsentMissingHint,
    fleetDesktopControlAvailabilityOf,
    fleetDesktopControlReasonHint,
    fleetDesktopReasonHint,
    isFleetDesktopReason,
    normalizeFleetDesktopControllerName,
    normalizeFleetHelperTrust,
    pickFleetDisplay,
    resolveFleetDesktopBlocker,
    resolveFleetDesktopControlReasons,
    FLEET_DESKTOP_BLOCKER_CODES,
    FLEET_DESKTOP_MESSAGES,
    FLEET_DESKTOP_VIEW_CEILING_MS,
    FLEET_LINK_FRAME_KINDS,
    FLEET_SCREEN_CAPABILITY,
    type ComputerControlDecision,
    type ComputerControlStateView,
    type ComputerQuality,
    type FleetDesktopAttachGrant,
    type FleetDesktopAvailabilityView,
    type FleetDesktopBlocker,
    type FleetDesktopControlRequest,
    type FleetDesktopControlResult,
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
 * refresh, displays).
 *
 * P2 — a view is a `computer_sessions` row (`source: 'desktop'`, no Agent;
 * slot `1796070100000`), so the caps count both sources on every API replica,
 * and AW-11's control arbiter holds its ONE lock per computer across both:
 *
 *   - **take** (`confirm`, CONTRACTS §2.2) is refused before the arbiter when
 *     the machine says control is not possible (the owner has not allowed it
 *     on the machine, macOS Accessibility, no input in the session); the
 *     arbiter then checks the `desktop` audience and the lock, audits
 *     `node.desktop.control.take|release|request`, and a won take answers a
 *     `driver` grant (`mode: 'controlling'`, the controller's name for the
 *     machine's console) the tab re-attaches with;
 *   - a driver socket is admitted only while its view holds the lock, keeps
 *     it alive (every ping acknowledges it, every input pushes the idle
 *     deadline), and is closed at once when the hold ends on this replica (the
 *     `computer.control.changed` event) and at the next ping elsewhere;
 *   - a driver socket that goes away gives control back after AW-11's 30-second
 *     grace unless it comes back; the node lets go of every key and button the
 *     moment the channel closes (FR-39).
 *
 * Without a row store (a test double), a view lives on this replica only, as
 * in P1.
 */

/** A granted view with no socket yet stays reserved (and counted) this long (replica-only views). */
export const DESKTOP_VIEW_RESERVE_MS = 90_000;
/** A screenshot waits this long for the first picture. */
export const DESKTOP_SCREENSHOT_TIMEOUT_MS = 10_000;
/** A live view's row is stamped (frames, bytes, last picture) at most this often from `desktop.stats`. */
export const DESKTOP_ROW_STAMP_EVERY_MS = 15_000;
/** A controller's input pushes the idle deadline at most this often. */
export const DESKTOP_INPUT_WRITE_EVERY_MS = 5_000;

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
    /** P2: the view has a `computer_sessions` row (always, with the real repository). */
    persisted: boolean;
    /** P2: the role of the last grant. */
    role: 'viewer' | 'driver';
    /** P2: driver sockets open on this replica. */
    drivers: number;
    /** P2: who is controlling, as the machine's console prints it. */
    controllerName: string | null;
    inputAt: number;
    stampAt: number;
    statsFrames: number;
    statsBytes: number;
    releaseTimer: ReturnType<typeof setTimeout> | null;
}

@Injectable()
export class FleetDesktopService
    implements OnApplicationBootstrap, FleetLinkViewerObserver, FleetDesktopReaderPort
{
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
        // P2 (control) — APPENDED and @Optional(): unbound, control answers `unsupported_on_node`.
        @Optional() private readonly control?: ComputerControlArbiter,
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
            liveViews: await this.liveViewCount(node),
            maxViews: resolveComputerSessionLimits(process.env).perNode,
            control: fleetDesktopControlAvailabilityOf(this.control ? facts?.helper : null, node.name),
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

    /** The Agent's read (`fleet_desktop_displays`): the same list, as the Agent's owner (R-25). */
    readDisplays(caller: FleetDesktopAgentCaller, nodeId: string): Promise<FleetDisplayView[]> {
        return this.displays(caller.ownerUserId, nodeId);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    async openView(
        userId: string,
        nodeId: string,
        request: FleetDesktopOpenRequest,
        controllerName?: string | null,
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
            persisted: false,
            role: 'viewer',
            drivers: 0,
            controllerName: normalizeFleetDesktopControllerName(controllerName),
            inputAt: 0,
            stampAt: now,
            statsFrames: 0,
            statsBytes: 0,
            releaseTimer: null,
        };
        await this.persist(record);
        let attach: FleetDesktopAttachGrant;
        try {
            attach = await this.mintFor(record, 'viewer');
        } catch (error) {
            if (record.persisted) await this.closeRow(record.viewId, 'error');
            throw error;
        }
        this.views.set(record.viewId, record);
        await this.auditView(node, userId, record.viewId, {
            outcome: 'opened',
            displayId: record.displayId,
            quality,
            fellBack,
        });
        return { view: this.viewOf(record), attach, display, fellBack };
    }

    /** One of my views, from this replica's memory (P1 behaviour). */
    viewFor(userId: string, nodeId: string, viewId: string): FleetDesktopViewView {
        return this.viewOf(this.ownView(userId, nodeId, viewId));
    }

    /** One of my views, from any replica (its row). */
    async view(userId: string, nodeId: string, viewId: string): Promise<FleetDesktopViewView> {
        return this.viewOf(await this.loadView(userId, nodeId, viewId));
    }

    /** Another display or quality: a fresh grant the browser re-attaches with (a `driver` one while it holds control). */
    async updateView(
        userId: string,
        nodeId: string,
        viewId: string,
        update: FleetDesktopUpdateRequest,
    ): Promise<FleetDesktopOpenResult> {
        const record = await this.loadView(userId, nodeId, viewId);
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
        await this.updateRow(record, { displayId: record.displayId, quality: record.quality });
        const attach = await this.mintFor(record, await this.roleNow(record));
        return { view: this.viewOf(record), attach, display, fellBack };
    }

    /** A reconnect of the same view (the socket dropped): a fresh single-use grant — `driver` while it holds control. */
    async attachToken(userId: string, nodeId: string, viewId: string): Promise<FleetDesktopAttachGrant> {
        const record = await this.loadView(userId, nodeId, viewId);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const blocker = await this.blockerFor(node, userId);
        if (blocker) {
            throw fleetLinkError(FLEET_DESKTOP_BLOCKER_CODES[blocker], this.hintFor(blocker, node), {
                reason: blocker,
            });
        }
        return this.mintFor(record, await this.roleNow(record));
    }

    /**
     * End a view (idempotent). Forgotten on this replica at once; its row is
     * ended, control it held is given back, and its sockets here close.
     */
    endView(userId: string, nodeId: string, viewId: string): Promise<void> {
        const record = this.views.get(viewId);
        if (record && record.userId === userId && record.nodeId === nodeId) this.forget(record);
        return this.endRowOf(userId, nodeId, viewId);
    }

    // ─── Control (P2, FR-36 … FR-42) ────────────────────────────────────────

    /** Control of the computer as this view sees it. */
    async controlState(userId: string, nodeId: string, viewId: string): Promise<ComputerControlStateView> {
        const record = await this.loadView(userId, nodeId, viewId);
        const control = this.requireControl(record);
        const state = await control.getState(this.actorOf(record));
        if (!state) throw this.viewGone();
        return state;
    }

    /**
     * Take control from this view (`confirm: true`, class `confirm`), or ask
     * whoever holds it to hand it over (`request: true`). A won take answers the
     * `driver` grant to re-attach with.
     */
    async takeControl(
        userId: string,
        nodeId: string,
        viewId: string,
        request: FleetDesktopControlRequest,
        controllerName?: string | null,
    ): Promise<FleetDesktopControlResult> {
        const record = await this.loadView(userId, nodeId, viewId);
        const control = this.requireControl(record);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const action = request.request ? 'node.desktop.control.request' : 'node.desktop.control.take';
        const blocker = await this.blockerFor(node, userId);
        if (blocker) {
            await this.recordAudit(node, userId, action, viewId, {
                outcome: 'refused',
                code: FLEET_DESKTOP_BLOCKER_CODES[blocker],
                reason: blocker,
            });
            throw fleetLinkError(FLEET_DESKTOP_BLOCKER_CODES[blocker], this.hintFor(blocker, node), {
                reason: blocker,
            });
        }
        // The machine half (CONTRACTS §1.1 `helper.control`): never offered on a guess.
        const reasons = resolveFleetDesktopControlReasons(fleetNodeDesktopViewOf(node)?.helper ?? null);
        if (reasons.length > 0) {
            await this.recordAudit(node, userId, action, viewId, {
                outcome: 'refused',
                code: 'unsupported_on_node',
                reason: reasons[0],
            });
            throw fleetLinkError('unsupported_on_node', fleetDesktopControlReasonHint(reasons[0], node.name), {
                reason: reasons[0],
            });
        }
        if (request.request) {
            const state = this.controlOutcome(await control.request(this.actorOf(record)), node);
            return { state, attach: null };
        }
        if (request.confirm !== true) {
            throw fleetLinkError(
                'confirmation_required',
                `Confirm to take control of ${node.name}'s mouse and keyboard: send confirm: true`,
                {
                    class: 'confirm',
                    summary: `Take control of ${node.name}? Your mouse and keyboard will drive it; everyone watching sees it.`,
                },
            );
        }
        const name = normalizeFleetDesktopControllerName(controllerName);
        if (name) record.controllerName = name;
        const state = this.controlOutcome(await control.take(this.actorOf(record)), node);
        const attach = state.mode === 'controlling' ? await this.mintFor(record, 'driver') : null;
        return { state, attach };
    }

    /** Give control back (idempotent): the driver sockets here close, and a viewer grant answers. */
    async giveBackControl(userId: string, nodeId: string, viewId: string): Promise<FleetDesktopControlResult> {
        const record = await this.loadView(userId, nodeId, viewId);
        const control = this.requireControl(record);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const state = this.controlOutcome(await control.giveBack(this.actorOf(record)), node);
        this.closeDrivers(record.viewId, 'control given back');
        return { state, attach: await this.mintFor(record, 'viewer') };
    }

    /** The view holding control answers a request: hand over (it re-attaches watching), or keep. */
    async answerControlRequest(
        userId: string,
        nodeId: string,
        viewId: string,
        requestId: string,
        decision: ComputerControlDecision,
    ): Promise<FleetDesktopControlResult> {
        const record = await this.loadView(userId, nodeId, viewId);
        const control = this.requireControl(record);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const state = this.controlOutcome(await control.answer(this.actorOf(record), requestId, decision), node);
        if (state.mode === 'controlling') return { state, attach: null };
        this.closeDrivers(record.viewId, 'control handed over');
        return { state, attach: await this.mintFor(record, 'viewer') };
    }

    /** "Keep control" on the idle warning. */
    async keepControl(userId: string, nodeId: string, viewId: string): Promise<FleetDesktopControlResult> {
        const record = await this.loadView(userId, nodeId, viewId);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const state = this.controlOutcome(await this.requireControl(record).keep(this.actorOf(record)), node);
        return { state, attach: null };
    }

    /** One more stretch of control, once. */
    async extendControl(userId: string, nodeId: string, viewId: string): Promise<FleetDesktopControlResult> {
        const record = await this.loadView(userId, nodeId, viewId);
        const { node } = await this.access.resolveVisible(nodeId, { userId });
        const state = this.controlOutcome(await this.requireControl(record).extend(this.actorOf(record)), node);
        return { state, attach: null };
    }

    /** Control left a view (given back, idle, ceiling, handed over, revoked): its driver sockets on this replica close now. */
    @OnEvent(ComputerControlChangedEvent.EVENT_NAME)
    onControlChanged(event: ComputerControlChangedEvent): void {
        try {
            const change = event.change;
            if (change.held || !this.views.has(change.sessionId)) return;
            this.closeDrivers(change.sessionId, 'control ended');
        } catch (error) {
            this.logger.warn(
                `desktop control change not applied: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
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

    admit(viewer: FleetLinkViewerHandle): void | Promise<void> {
        if (viewer.claims.params.source !== 'desktop') return;
        const cached = this.views.get(viewer.claims.target);
        if (cached || typeof this.sessions?.findDesktopViewFor !== 'function') {
            const record = this.checkAdmit(cached ?? null, viewer);
            return viewer.claims.role === 'driver' ? this.admitDriver(record, viewer) : undefined;
        }
        return (async () => {
            const record = this.checkAdmit(
                await this.loadView(viewer.claims.userId, viewer.claims.nodeId, viewer.claims.target).catch(() => null),
                viewer,
            );
            if (viewer.claims.role === 'driver') await this.admitDriver(record, viewer);
        })();
    }

    opened(viewer: FleetLinkViewerHandle): void {
        const record = this.desktopRecordOf(viewer);
        if (!record) return;
        record.sockets += 1;
        if (viewer.claims.role === 'driver') {
            record.drivers += 1;
            if (record.releaseTimer) {
                clearTimeout(record.releaseTimer);
                record.releaseTimer = null;
            }
        }
    }

    closed(viewer: FleetLinkViewerHandle): void {
        const record = this.desktopRecordOf(viewer);
        if (!record) return;
        record.sockets = Math.max(0, record.sockets - 1);
        record.lastGrantAt = this.now();
        if (viewer.claims.role !== 'driver') return;
        record.drivers = Math.max(0, record.drivers - 1);
        if (record.drivers > 0 || !this.control || record.releaseTimer) return;
        // AW-11's grace: a controller whose socket dropped gets it back if it returns in time.
        const closedAt = this.now();
        record.releaseTimer = setTimeout(() => {
            record.releaseTimer = null;
            if (record.drivers > 0) return;
            void this.releaseIfStillGone(record, closedAt).catch((error: unknown) =>
                this.logger.warn(
                    `desktop view ${record.viewId}: control not given back: ${error instanceof Error ? error.message : String(error)}`,
                ),
            );
        }, COMPUTER_CONTROL_DISCONNECT_MS);
        record.releaseTimer.unref?.();
    }

    /**
     * The grace ran out with no driver back on this replica: give control back —
     * unless the view took it again since (its driver may be on another replica).
     */
    private async releaseIfStillGone(record: DesktopViewRecord, closedAt: number): Promise<void> {
        const control = this.control;
        if (!control) return;
        const state = await control.getState(this.actorOf(record));
        const since = state?.holder?.thisView && state.holder.since ? Date.parse(state.holder.since) : NaN;
        if (Number.isFinite(since) && since > closedAt) return;
        await control.releaseForSession(record.viewId, 'disconnected');
    }

    /** A controller's input keeps the hold from idling out (at most every few seconds). */
    inbound(viewer: FleetLinkViewerHandle, bytes: number): void {
        if (viewer.claims.role !== 'driver' || bytes <= 0 || !this.control) return;
        const record = this.desktopRecordOf(viewer);
        if (!record) return;
        const now = this.now();
        if (now - record.inputAt < DESKTOP_INPUT_WRITE_EVERY_MS) return;
        record.inputAt = now;
        void this.control.recordInput(record.viewId).catch(() => undefined);
    }

    /** `desktop.stats` (once a second): the view's row is stamped so AW-11's stall rule sees it alive. */
    nodeMessage(viewer: FleetLinkViewerHandle, message: Record<string, unknown>): void {
        if (message.type !== FLEET_DESKTOP_MESSAGES.stats) return;
        const record = this.desktopRecordOf(viewer);
        if (!record?.persisted || !this.sessions) return;
        const fps = typeof message.fps === 'number' && Number.isFinite(message.fps) ? Math.max(0, Math.trunc(message.fps)) : 0;
        record.statsFrames += fps;
        const bytesOut =
            typeof message.bytesOut === 'number' && Number.isFinite(message.bytesOut) ? Math.max(0, message.bytesOut) : 0;
        const now = this.now();
        if (now - record.stampAt < DESKTOP_ROW_STAMP_EVERY_MS) return;
        const frames = record.statsFrames;
        const bytes = Math.max(0, bytesOut - record.statsBytes);
        record.statsFrames = 0;
        record.statsBytes = bytesOut;
        record.stampAt = now;
        void this.sessions.recordFrames(record.viewId, frames, bytes, new Date(now)).catch(() => undefined);
    }

    /**
     * Re-checked on every ping: the flag, the kill switch, the ceiling, the view
     * still open, the viewer's place in the `desktop` audience — and for a
     * driver, that its view still holds control (the ping acknowledges it).
     */
    async stillAllowed(viewer: FleetLinkViewerHandle): Promise<boolean> {
        if (viewer.claims.params.source !== 'desktop') return true;
        const record = this.views.get(viewer.claims.target);
        if (!record || !config.fleet.isDesktopEnabled()) return false;
        if (this.now() - record.openedAt >= FLEET_DESKTOP_VIEW_CEILING_MS) {
            this.forget(record);
            if (record.persisted) void this.closeRow(record.viewId, 'session-ceiling');
            return false;
        }
        try {
            if (await this.killSwitch.isStopped()) return false;
            if (record.persisted && this.sessions) {
                const row = await this.sessions.findById(record.viewId);
                if (!row || row.status === 'ended') {
                    this.forget(record);
                    return false;
                }
            }
            const node = await this.nodes.findById(record.nodeId);
            if (!node) return false;
            if (!(await this.access.canAct(node, { userId: record.userId }, 'desktop'))) return false;
            if (viewer.claims.role === 'driver') {
                if (!this.control || !(await this.control.holdOf(record.viewId)).held) return false;
                await this.control.acknowledge(record.viewId);
            }
            return true;
        } catch {
            // Unreadable right now: keep the view; the next ping asks again.
            return true;
        }
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    private checkAdmit(record: DesktopViewRecord | null, viewer: FleetLinkViewerHandle): DesktopViewRecord {
        if (!record || record.userId !== viewer.claims.userId || record.nodeId !== viewer.claims.nodeId) {
            throw fleetLinkError('not_found', 'this desktop view has ended — open it again');
        }
        if (this.now() - record.openedAt >= FLEET_DESKTOP_VIEW_CEILING_MS) {
            this.forget(record);
            if (record.persisted) void this.closeRow(record.viewId, 'session-ceiling');
            throw fleetLinkError('limit_exceeded', 'a desktop view lasts at most 4 hours — open a new one', {
                limit: 'view-ceiling',
            });
        }
        return record;
    }

    /** A driver socket only while its view holds control, and only on a `controlling` grant. */
    private async admitDriver(record: DesktopViewRecord, viewer: FleetLinkViewerHandle): Promise<void> {
        if (viewer.claims.params.mode !== 'controlling' || !this.control) {
            throw fleetLinkError('permission_denied', 'take control from the view first');
        }
        if (!(await this.control.holdOf(record.viewId)).held) {
            throw fleetLinkError('permission_denied', 'this view does not have control any more — take it again');
        }
    }

    private desktopRecordOf(viewer: FleetLinkViewerHandle): DesktopViewRecord | null {
        if (viewer.claims.params.source !== 'desktop') return null;
        return this.views.get(viewer.claims.target) ?? null;
    }

    private actorOf(record: DesktopViewRecord): ComputerControlActor {
        return { userId: record.userId, agentId: '', sessionId: record.viewId, source: 'desktop' };
    }

    private requireControl(record: DesktopViewRecord): ComputerControlArbiter {
        if (!this.control || !record.persisted) {
            throw fleetLinkError('unsupported_on_node', 'control of a desktop is not available on this platform yet');
        }
        return this.control;
    }

    private viewGone(): FleetLinkException {
        return fleetLinkError('not_found', 'this desktop view has ended — open it again');
    }

    /** AW-11's typed outcome as CONTRACTS §8 (the state rides in `details`). */
    private controlOutcome(outcome: ComputerControlOutcome | null, node: FleetNode): ComputerControlStateView {
        if (!outcome) throw this.viewGone();
        if (!('refused' in outcome)) return outcome.state;
        const { refused, state } = outcome;
        switch (refused) {
            case 'policy':
                throw fleetLinkError(
                    'permission_denied',
                    state.policy === 'owner'
                        ? `Only the owner of ${node.name} can take control. Ask them to allow organization members: desktop`
                        : `${node.name}'s control policy (${state.policy}) does not include you`,
                    { reason: 'policy', state },
                );
            case 'held':
                throw fleetLinkError('busy', `Someone else has control of ${node.name} — ask them to hand it over`, {
                    reason: 'held',
                    state,
                });
            case 'session-ended':
                throw fleetLinkError('not_found', 'this desktop view has ended — open it again', { reason: refused, state });
            default:
                throw fleetLinkError('busy', DESKTOP_CONTROL_REFUSAL_HINTS[refused] ?? refused, { reason: refused, state });
        }
    }

    private async roleNow(record: DesktopViewRecord): Promise<'viewer' | 'driver'> {
        if (!this.control || !record.persisted) return 'viewer';
        try {
            return (await this.control.holdOf(record.viewId)).held ? 'driver' : 'viewer';
        } catch {
            return 'viewer';
        }
    }

    private closeDrivers(viewId: string, reason: string): void {
        this.gateway?.closeViewers(
            (viewer) =>
                viewer.claims.family === 'desktop' && viewer.claims.target === viewId && viewer.claims.role === 'driver',
            reason,
        );
    }

    private forget(record: DesktopViewRecord): void {
        this.views.delete(record.viewId);
        if (record.releaseTimer) {
            clearTimeout(record.releaseTimer);
            record.releaseTimer = null;
        }
    }

    /** Write the view's row (P2). Without a row store the view lives on this replica only. */
    private async persist(record: DesktopViewRecord): Promise<void> {
        if (typeof this.sessions?.create !== 'function') return;
        const at = new Date(record.openedAt);
        const row = await this.sessions.create({
            userId: record.ownerUserId,
            organizationId: record.organizationId,
            agentId: null,
            nodeId: record.nodeId,
            openedByUserId: record.userId,
            channels: ['screen'],
            activeChannel: 'screen',
            quality: record.quality,
            // Live from the start: a desktop view is never claimed through a job (AW-11's `requested`).
            status: 'live',
            startedAt: at,
            lastFrameAt: at,
            source: 'desktop',
            displayId: record.displayId,
            fleetSessionId: record.fleetSessionId,
        });
        record.viewId = row.id;
        record.persisted = true;
    }

    private async updateRow(record: DesktopViewRecord, patch: Partial<ComputerSession>): Promise<void> {
        if (!record.persisted || typeof this.sessions?.updateOpen !== 'function') return;
        try {
            await this.sessions.updateOpen(record.viewId, patch);
        } catch (error) {
            this.logger.warn(
                `desktop view ${record.viewId}: row not updated: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** End a view's row (once), give back control it held, close its sockets here. Never throws. */
    private async closeRow(viewId: string, reason: 'closed-by-user' | 'session-ceiling' | 'error'): Promise<void> {
        try {
            if (typeof this.sessions?.close === 'function') {
                await this.sessions.close(viewId, { closeReason: reason, endedAt: new Date(this.now()) });
            }
            await this.control?.releaseForSession(viewId, 'session-ended');
        } catch (error) {
            this.logger.warn(
                `desktop view ${viewId}: not ended cleanly: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        this.gateway?.closeViewers(
            (viewer) => viewer.claims.family === 'desktop' && viewer.claims.target === viewId,
            'the view ended',
        );
    }

    /** `DELETE …/views/:viewId` for a row on any replica: only the person who opened it ends it. */
    private async endRowOf(userId: string, nodeId: string, viewId: string): Promise<void> {
        if (typeof this.sessions?.findDesktopViewFor !== 'function') return;
        const row = await this.sessions.findDesktopViewFor(viewId, userId).catch(() => null);
        if (!row || row.nodeId !== nodeId || row.status === 'ended') return;
        await this.closeRow(row.id, 'closed-by-user');
    }

    /** A view from this replica's memory, or from its row (another replica opened it). */
    private async loadView(userId: string, nodeId: string, viewId: string): Promise<DesktopViewRecord> {
        const cached = this.views.get(viewId);
        if (cached) {
            if (cached.userId !== userId || cached.nodeId !== nodeId) throw this.viewGone();
            return cached;
        }
        if (typeof this.sessions?.findDesktopViewFor !== 'function') throw this.viewGone();
        const row = await this.sessions.findDesktopViewFor(viewId, userId);
        if (!row || row.nodeId !== nodeId || row.status === 'ended') throw this.viewGone();
        const node = await this.nodes.findById(row.nodeId);
        const openedAt = new Date(row.startedAt ?? row.createdAt ?? this.now()).getTime();
        const record: DesktopViewRecord = {
            viewId: row.id,
            nodeId: row.nodeId,
            nodeName: node?.name ?? '',
            ownerUserId: row.userId,
            userId,
            organizationId: row.organizationId ?? null,
            displayId: row.displayId ?? null,
            quality: row.quality,
            fleetSessionId: row.fleetSessionId ?? null,
            openedAt: Number.isFinite(openedAt) ? openedAt : this.now(),
            lastGrantAt: this.now(),
            sockets: 0,
            persisted: true,
            role: 'viewer',
            drivers: 0,
            controllerName: null,
            inputAt: 0,
            stampAt: this.now(),
            statsFrames: 0,
            statsBytes: 0,
            releaseTimer: null,
        };
        this.views.set(record.viewId, record);
        return record;
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

    /** Open views that still hold a slot at this instant (AW-11's rule: past its time, a row holds none). */
    private holding(rows: Array<Partial<ComputerSession>>): number {
        const limits = resolveComputerSessionLimits(process.env);
        const now = new Date(this.now());
        return rows.filter(
            (row) =>
                row.status !== 'ended' &&
                resolveSessionExpiry(
                    {
                        status: row.status ?? '',
                        createdAt: row.createdAt ?? null,
                        startedAt: row.startedAt ?? null,
                        lastFrameAt: row.lastFrameAt ?? null,
                    },
                    now,
                    limits,
                ) === null,
        ).length;
    }

    private async liveViewCount(node: FleetNode): Promise<number> {
        const rows = (await this.sessions?.findOpenForNode(node.id).catch(() => [])) ?? [];
        return (
            this.holding(rows.filter((row) => (row as Partial<ComputerSession>).source === 'desktop')) +
            this.liveDesktopViews((view) => !view.persisted && view.nodeId === node.id)
        );
    }

    /** AW-11's caps, across BOTH sources (FR-33): every open `computer_sessions` row + replica-only views. */
    private async assertWithinCaps(node: FleetNode): Promise<void> {
        const limits = resolveComputerSessionLimits(process.env);
        const organizationId = node.organizationId ?? null;
        const [onNode, inScope] = await Promise.all([
            this.sessions?.findOpenForNode(node.id) ?? Promise.resolve([]),
            this.sessions?.findOpenForScope({ userId: node.userId, organizationId }) ?? Promise.resolve([]),
        ]);
        const desktopOnNode = this.liveDesktopViews((view) => !view.persisted && view.nodeId === node.id);
        if (this.holding(onNode) + desktopOnNode >= limits.perNode) {
            throw fleetLinkError(
                'limit_exceeded',
                `${node.name} is already showing ${limits.perNode} live views; close one first`,
                { limit: 'views-per-computer', max: limits.perNode },
            );
        }
        const desktopInScope = this.liveDesktopViews(
            (view) =>
                !view.persisted &&
                (organizationId
                    ? view.organizationId === organizationId
                    : view.organizationId === null && view.ownerUserId === node.userId),
        );
        if (this.holding(inScope) + desktopInScope >= limits.perOrganization) {
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
                if (view.sockets === 0 && !view.persisted) this.forget(view);
                continue;
            }
            if (match(view)) count += 1;
        }
        return count;
    }

    private ownView(userId: string, nodeId: string, viewId: string): DesktopViewRecord {
        const record = this.views.get(viewId);
        if (!record || record.userId !== userId || record.nodeId !== nodeId) {
            throw this.viewGone();
        }
        return record;
    }

    private async mintFor(record: DesktopViewRecord, role: 'viewer' | 'driver'): Promise<FleetDesktopAttachGrant> {
        try {
            const grant = await this.attach.mint({
                nodeId: record.nodeId,
                family: 'desktop',
                target: record.viewId,
                // A watcher's frames never reach the machine; a driver grant is minted only to the holder.
                role,
                caller: { kind: 'user', userId: record.userId },
                params: {
                    source: 'desktop',
                    viewId: record.viewId,
                    quality: record.quality,
                    ...(record.displayId ? { display: record.displayId } : {}),
                    ...(role === 'driver'
                        ? { mode: 'controlling', ...(record.controllerName ? { controlledBy: record.controllerName } : {}) }
                        : {}),
                },
                requirement: { actionFamily: 'desktop', target: record.viewId },
            });
            record.lastGrantAt = this.now();
            record.role = role;
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
            role: record.role,
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
        action:
            | 'node.desktop.view'
            | 'node.desktop.display.set'
            | 'node.desktop.control.take'
            | 'node.desktop.control.request',
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
                    confirmationClass: action === 'node.desktop.control.take' ? 'confirm' : 'plain',
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

/** The one-line hint for every other refusal of the arbiter. */
const DESKTOP_CONTROL_REFUSAL_HINTS: Partial<Record<string, string>> = {
    'not-live': 'this view is not showing the computer yet — wait for the picture',
    'not-holder': 'this view does not have control of the computer',
    'not-held': 'nobody has control of this computer — take it instead',
    'already-requested': 'someone has already asked for control; try again in a minute',
    'no-request': 'that request for control is no longer waiting for an answer',
    'already-extended': 'this stretch of control has already been extended once',
};
