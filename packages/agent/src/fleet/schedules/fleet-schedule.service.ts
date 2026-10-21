import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
    effectiveConsents,
    fleetNodeScheduleRowId,
    fleetScheduleFailureStreak,
    nextFleetScheduleFire,
    previewFleetScheduleFires,
    describeFleetScheduleCadence,
    FLEET_SCHEDULE_BREAKER_CAP,
    FLEET_SCHEDULE_BREAKER_UNDO_MS,
    FLEET_SCHEDULE_DELETED_RETENTION_DAYS,
    FLEET_SCHEDULE_FAILURE_PAUSE,
    FLEET_SCHEDULE_HISTORY,
    FLEET_SCHEDULE_RUN_CAP_SEC,
    FLEET_SCHEDULE_SANDBOX_SENTENCE,
    type FleetAuditAction,
    type FleetCommandRunStatus,
    type FleetCommandRunView,
    type FleetConsents,
    type FleetLinkError,
    type FleetScheduleConfirmAction,
    type FleetScheduleConfirmationDetails,
    type FleetScheduleCreateRequest,
    type FleetScheduleDefinition,
    type FleetSchedulePauseAllConfirmation,
    type FleetSchedulePauseAllResult,
    type FleetSchedulePausedReason,
    type FleetScheduleRunReport,
    type FleetScheduleUpdateRequest,
    type FleetScheduleView,
} from '@ever-works/contracts';
import type { FleetCommand } from '../../entities/fleet-command.entity';
import type { FleetCommandRun } from '../../entities/fleet-command-run.entity';
import { config } from '../../config';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { INBOX_PRODUCER, type InboxProducer } from '../../inbox/inbox-producer.port';
import { redactSecrets } from '../../utils/secret-scan';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { fleetCommandError, readFleetCommandError } from '../commands/fleet-command.errors';
import type { FleetCommandPortCaller } from '../commands/fleet-command-node.port';
import { FLEET_SCHEDULE_NODE_PORT, type FleetScheduleNodePort } from './fleet-schedule-node.port';
import {
    checkFleetScheduleCreate,
    checkFleetScheduleUpdate,
    checkFleetSchedulesPerNode,
    checkFleetScheduleWriteRate,
    fleetScheduleNeverRuns,
    fleetScheduleNodeRefusal,
    fleetScheduleSecretRefusal,
    fleetScheduleShellLabel,
    type FleetScheduleShape,
} from './fleet-schedule.policy';
import { FleetScheduleRepository } from './fleet-schedule.repository';
import {
    isCountedFleetScheduleRun,
    storedFleetScheduleCadence,
    toFleetScheduleRunView,
    toFleetScheduleView,
} from './fleet-schedule.view';

/**
 * Schedules on computers (FL-13) — the platform's one writer of Command
 * schedules: `fleet_commands` rows with a `cadence` and the runs the
 * machines report for them (CONTRACTS §2.2, §4.4, §6, §7, §8, §10, R-2,
 * R-11; spec FR-5 … FR-28).
 *
 * A write goes, in order: its shape (`checkFleetScheduleCreate` /
 * `…Update`), the person's write rate (30 a minute), the computer's
 * existence and `schedules` audience (an id the person may not see is the
 * 404 of an unknown one; one they see but may not schedule on is
 * `permission_denied`), whether that kind of computer holds schedules at all,
 * the kill switch (no new schedules while it is on), the 50-per-computer
 * limit, the confirmation (CONTRACTS §2.2 class `confirm` for create, move,
 * a change of what runs, delete and Run now; pause and resume are `plain`),
 * then the row, one `node.schedule.*` audit row, and — in the background —
 * the computer's whole set re-sent over the `schedule` family.
 *
 * Offline is not a refusal (spec U1): the definition saves and reads "will
 * sync when build-01 is back"; the next link open sends it. A computer
 * without `--manage` saves too (U2) and reads NEVER RUNS · needs --manage.
 *
 * Runs are the machine's: it fires from its own clock and the platform
 * learns about them through `schedule.runs` (on link open and every five
 * minutes), upserting by the machine's run id — idempotent. Each run that
 * ends is audited as `node.command.run` with `requestedBy: schedule:<id>`
 * (FR-27). Five failures in a row pause the schedule (`failures`), file an
 * Inbox notice and leave a Needs-a-look item (CONTRACTS §6, FR-23).
 */

/** Who acts. P1: a person; P2 adds Agents (`agentId`, its owner as `userId`). */
export interface FleetScheduleActor {
    userId: string;
    agentId?: string;
}

/** What one reconcile pass did (logs and tests). */
export interface FleetScheduleReconcileSummary {
    nodes: number;
    synced: number;
    runs: number;
    paused: number;
}

/** How often a person's schedule writes are counted (CONTRACTS §10.1). */
const RATE_WINDOW_MS = 60_000;
/** The `since` watermark is moved back this much, so a run that ended while another was being read is never missed. */
const SINCE_OVERLAP_MS = 10 * 60_000;
/** `schedule.runs` pages one reconcile reads at most per computer. */
const MAX_RUN_PAGES = 5;
/** A row column is an `int`. */
const MAX_INT = 2_147_483_647;

@Injectable()
export class FleetScheduleService {
    private readonly logger = new Logger(FleetScheduleService.name);
    /** Schedule writes per person in the last minute, on this replica. */
    private readonly recent = new Map<string, number[]>();
    /** Computers whose node refused `schedule.sync` as unsupported (older than schedules). */
    private readonly unsupported = new Set<string>();
    /** Definitions a machine refused in its last sync, by Command id. */
    private readonly refusals = new Map<string, FleetLinkError>();
    /** One sync per computer at a time on this replica. */
    private readonly syncing = new Map<string, Promise<void>>();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly schedules: FleetScheduleRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() @Inject(FLEET_SCHEDULE_NODE_PORT) private readonly node?: FleetScheduleNodePort,
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
    ) {}

    // ─── Create ────────────────────────────────────────────────────────────

    /** Create a Command schedule on one computer (spec S1, FR-5 … FR-9, FR-25). */
    async create(actor: FleetScheduleActor, request: FleetScheduleCreateRequest): Promise<FleetScheduleView> {
        const shape: FleetScheduleShape = {
            name: '',
            nodeId: '',
            command: '',
            cwd: null,
            cadence: { kind: 'daily', at: '00:00', timezone: 'node' },
        };
        const invalid = checkFleetScheduleCreate((request ?? {}) as Record<string, unknown>, shape);
        if (invalid) throw fleetCommandError(invalid.code, invalid.hint, invalid.details);
        if (redactSecrets(shape.command).redactions > 0) {
            const refusal = fleetScheduleSecretRefusal();
            throw fleetCommandError(refusal.code, refusal.hint, refusal.details);
        }
        this.assertRate(actor.userId);
        const node = await this.resolveNode(shape.nodeId, actor);
        await this.assertNotStopped('new schedules cannot be created while the kill switch is on');
        const limit = checkFleetSchedulesPerNode(await this.schedules.countLiveForNode(node.id), node.name);
        if (limit) throw fleetCommandError(limit.code, limit.hint, limit.details);

        if (request.confirm !== true) {
            throw this.confirmation('create', shape, node);
        }
        this.noteWrite(actor.userId);

        const now = this.now();
        const generation = (await this.maxGeneration(node.id)) + 1;
        const next = nextFleetScheduleFire(shape.cadence, node.timeZone ?? null, now);
        const command = await this.schedules.create({
            id: randomUUID(),
            userId: actor.userId,
            nodeIds: [node.id],
            command: shape.command,
            commandRedacted: false,
            cwd: shape.cwd,
            timeoutSec: FLEET_SCHEDULE_RUN_CAP_SEC,
            cadence: shape.cadence as unknown as Record<string, unknown>,
            name: shape.name,
            enabled: true,
            requestedBy: actor.agentId ? 'agent' : 'user',
            state: 'queued',
            lastRunAt: null,
            nextRunAt: next === null ? null : new Date(next),
            pausedAt: null,
            pausedReason: null,
            syncGeneration: generation,
            syncedGeneration: 0,
            deletedAt: null,
        });
        await this.record('node.schedule.create', actor, node, command.id, 'confirm', {
            outcome: 'created',
            cadence: describeFleetScheduleCadence(shape.cadence),
        });
        this.syncInBackground(node.id);
        return this.viewOf(command, node);
    }

    // ─── Update and move ───────────────────────────────────────────────────

    /**
     * Edit any field but the kind, or move it to another computer (spec FR-10,
     * ACC-FL13-24). A move or a change of what runs (the command, the folder)
     * asks for `confirm`; a rename or a new cadence does not. A move re-syncs
     * both computers: the definition leaves the old one and lands on the new.
     */
    async update(
        id: string,
        actor: FleetScheduleActor,
        request: FleetScheduleUpdateRequest,
    ): Promise<FleetScheduleView> {
        const command = await this.resolveOwn(id, actor);
        if (command.deletedAt) throw fleetCommandError('not_found', 'this schedule was deleted');
        const before: FleetScheduleShape = this.shapeOf(command);
        const after: FleetScheduleShape = { ...before };
        const changed: Array<keyof FleetScheduleShape> = [];
        const invalid = checkFleetScheduleUpdate(
            (request ?? {}) as Record<string, unknown>,
            after,
            changed,
        );
        if (invalid) throw fleetCommandError(invalid.code, invalid.hint, invalid.details);
        if (changed.length === 0) return this.viewOf(command, await this.nodes.findById(before.nodeId));
        if (changed.includes('command') && redactSecrets(after.command).redactions > 0) {
            const refusal = fleetScheduleSecretRefusal();
            throw fleetCommandError(refusal.code, refusal.hint, refusal.details);
        }
        this.assertRate(actor.userId);

        const moving = changed.includes('nodeId');
        // The schedule's current computer may be gone (U16: "move it to another computer").
        const current = await this.nodes.findById(before.nodeId);
        if (current) await this.resolveNode(current.id, actor);
        const target = moving ? await this.resolveNode(after.nodeId, actor) : current;
        if (moving && target) {
            const limit = checkFleetSchedulesPerNode(await this.schedules.countLiveForNode(target.id), target.name);
            if (limit) throw fleetCommandError(limit.code, limit.hint, limit.details);
        }
        const needsConfirm = moving || changed.includes('command') || changed.includes('cwd');
        if (needsConfirm && request.confirm !== true) {
            throw this.confirmation(moving ? 'move' : 'update', after, target ?? current, {
                ...(moving && target ? { toNodeId: target.id, toNodeName: target.name } : {}),
            });
        }
        this.noteWrite(actor.userId);

        const generation = (await this.maxGeneration(after.nodeId)) + 1;
        const next =
            command.pausedAt || !target
                ? null
                : nextFleetScheduleFire(after.cadence, target.timeZone ?? null, this.now());
        await this.schedules.update(command.id, {
            name: after.name,
            nodeIds: [after.nodeId],
            command: after.command,
            commandRedacted: false,
            cwd: after.cwd,
            cadence: after.cadence as unknown as Record<string, unknown>,
            nextRunAt: next === null ? null : new Date(next),
            syncGeneration: generation,
            ...(moving ? { syncedGeneration: 0 } : {}),
        });
        this.refusals.delete(command.id);
        await this.record(
            'node.schedule.update',
            actor,
            target ?? current ?? { id: before.nodeId, userId: command.userId },
            command.id,
            needsConfirm ? 'confirm' : 'plain',
            {
                outcome: moving ? 'moved' : 'updated',
                fields: changed,
                ...(moving ? { fromNodeId: before.nodeId, toNodeId: after.nodeId } : {}),
            },
        );
        this.syncInBackground(after.nodeId);
        if (moving) this.syncInBackground(before.nodeId);
        const fresh = await this.schedules.find(command.id);
        return this.viewOf(fresh ?? command, target ?? null);
    }

    // ─── Delete ────────────────────────────────────────────────────────────

    /**
     * Delete (spec U13): confirms with the name and the run count, stops it
     * on the machine (the next sync leaves it out, so the machine deletes its
     * cached copy) and keeps the history readable for 30 days.
     */
    async remove(id: string, actor: FleetScheduleActor, confirm: boolean): Promise<FleetScheduleView> {
        const command = await this.resolveOwn(id, actor);
        const node = await this.nodes.findById(this.nodeIdOf(command));
        if (command.deletedAt) return this.viewOf(command, node);
        if (node) await this.resolveNode(node.id, actor);
        if (confirm !== true) {
            throw this.confirmation('delete', this.shapeOf(command), node, {
                runCount: await this.schedules.countRuns(command.id),
            });
        }
        this.assertRate(actor.userId);
        this.noteWrite(actor.userId);
        const nodeId = this.nodeIdOf(command);
        const generation = (await this.maxGeneration(nodeId)) + 1;
        const now = new Date(this.now());
        await this.schedules.update(command.id, {
            deletedAt: now,
            enabled: false,
            nextRunAt: null,
            syncGeneration: generation,
        });
        this.refusals.delete(command.id);
        await this.record('node.schedule.delete', actor, node ?? { id: nodeId, userId: command.userId }, command.id, 'confirm', {
            outcome: 'deleted',
        });
        this.syncInBackground(nodeId);
        return this.viewOf({ ...command, deletedAt: now, enabled: false }, node);
    }

    // ─── Pause and resume ──────────────────────────────────────────────────

    /** Pause (spec S5, class `plain`): the machine stops firing it on the next sync; the cadence is kept. */
    async pause(
        id: string,
        actor: FleetScheduleActor,
        reason: FleetSchedulePausedReason = 'user',
    ): Promise<FleetScheduleView> {
        this.assertEnabled();
        const command = await this.resolveOwn(id, actor);
        const node = await this.nodes.findById(this.nodeIdOf(command));
        if (command.deletedAt) throw fleetCommandError('not_found', 'this schedule was deleted');
        if (command.pausedAt) return this.viewOf(command, node);
        if (node) await this.resolveNode(node.id, actor);
        this.assertRate(actor.userId);
        this.noteWrite(actor.userId);
        await this.applyPause(command, node, reason, actor);
        const fresh = await this.schedules.find(command.id);
        return this.viewOf(fresh ?? command, node);
    }

    /** Resume (spec S5, class `plain`): the next fire is computed from now; missed fires are not replayed. */
    async resume(id: string, actor: FleetScheduleActor): Promise<FleetScheduleView> {
        this.assertEnabled();
        const command = await this.resolveOwn(id, actor);
        const node = await this.nodes.findById(this.nodeIdOf(command));
        if (command.deletedAt) throw fleetCommandError('not_found', 'this schedule was deleted');
        if (!command.pausedAt && command.enabled !== false) return this.viewOf(command, node);
        if (node) await this.resolveNode(node.id, actor);
        this.assertRate(actor.userId);
        this.noteWrite(actor.userId);
        const nodeId = this.nodeIdOf(command);
        const generation = (await this.maxGeneration(nodeId)) + 1;
        const next = node
            ? nextFleetScheduleFire(storedFleetScheduleCadence(command), node.timeZone ?? null, this.now())
            : null;
        await this.schedules.update(command.id, {
            enabled: true,
            pausedAt: null,
            pausedReason: null,
            nextRunAt: next === null ? null : new Date(next),
            syncGeneration: generation,
        });
        await this.record('node.schedule.resume', actor, node ?? { id: nodeId, userId: command.userId }, command.id, 'plain', {
            outcome: 'resumed',
            wasPausedFor: command.pausedReason ?? 'user',
        });
        this.syncInBackground(nodeId);
        const fresh = await this.schedules.find(command.id);
        return this.viewOf(fresh ?? command, node);
    }

    // ─── The breaker (FR-22, spec U14) ─────────────────────────────────────

    /**
     * "Pause all" on one computer: every live schedule on it that the person
     * may pause — all of them for the computer's owner, the person's own for
     * anyone else in its `schedules` audience — stamped `pausedReason:
     * 'breaker'` with ONE instant, which is the key of the 15-minute Undo.
     * Class `confirm`: without it the answer is `confirmation_required` with
     * the count and the runs in flight (they finish; nothing new starts).
     * Never deletes. At most 500 at once.
     */
    async pauseAllOnNode(
        nodeId: string,
        actor: FleetScheduleActor,
        confirm: boolean,
    ): Promise<FleetSchedulePauseAllResult> {
        this.assertEnabled();
        const node = await this.resolveNode(nodeId, actor);
        const rows = (await this.schedules.listForNode(node.id)).filter(
            (row) =>
                !row.pausedAt &&
                row.enabled !== false &&
                (node.userId === actor.userId || row.userId === actor.userId),
        );
        if (rows.length > FLEET_SCHEDULE_BREAKER_CAP) {
            throw fleetCommandError(
                'limit_exceeded',
                `at most ${FLEET_SCHEDULE_BREAKER_CAP} schedules are paused at once`,
                { limit: FLEET_SCHEDULE_BREAKER_CAP },
            );
        }
        const recent = await this.schedules.findRecentRunsFor(
            rows.map((row) => row.id),
            1,
        );
        const running = rows.filter((row) => recent.get(row.id)?.[0]?.status === 'running').length;
        if (confirm !== true) {
            const details: FleetSchedulePauseAllConfirmation = {
                class: 'confirm',
                action: 'pause-all',
                nodeId: node.id,
                nodeName: node.name,
                count: rows.length,
                running,
            };
            throw fleetCommandError(
                'confirmation_required',
                `Pause ${rows.length} schedule(s) on ${node.name}?`,
                details as unknown as Record<string, unknown>,
            );
        }
        this.assertRate(actor.userId);
        this.noteWrite(actor.userId);
        const breakerAt = new Date(Math.floor(this.now() / 1000) * 1000);
        const generation = (await this.maxGeneration(node.id)) + 1;
        for (const row of rows) {
            await this.schedules.update(row.id, {
                pausedAt: breakerAt,
                pausedReason: 'breaker',
                nextRunAt: null,
                syncGeneration: generation,
            });
            await this.record('node.schedule.pause', actor, node, row.id, 'confirm', {
                outcome: 'paused',
                reason: 'breaker',
                breakerAt: breakerAt.toISOString(),
            });
        }
        if (rows.length > 0) this.syncInBackground(node.id);
        return {
            paused: rows.length,
            running,
            breakerAt: breakerAt.toISOString(),
            undoUntil: new Date(breakerAt.getTime() + FLEET_SCHEDULE_BREAKER_UNDO_MS).toISOString(),
        };
    }

    /** The breaker's Undo, within 15 minutes: resume exactly what that Pause all paused (and nothing paused since). */
    async undoPauseAllOnNode(
        nodeId: string,
        actor: FleetScheduleActor,
        breakerAtIso: string,
    ): Promise<{ resumed: number }> {
        this.assertEnabled();
        const node = await this.resolveNode(nodeId, actor);
        const breakerAt = Date.parse(breakerAtIso);
        if (!Number.isFinite(breakerAt)) throw fleetCommandError('invalid', 'breakerAt is not an instant', { field: 'breakerAt' });
        if (this.now() - breakerAt > FLEET_SCHEDULE_BREAKER_UNDO_MS) {
            throw fleetCommandError('invalid', 'the 15 minutes to undo it have passed; resume the schedules one by one');
        }
        const rows = (await this.schedules.listForNode(node.id)).filter(
            (row) =>
                row.pausedReason === 'breaker' &&
                row.pausedAt &&
                Math.abs(toMs(row.pausedAt) - breakerAt) < 1000 &&
                (node.userId === actor.userId || row.userId === actor.userId),
        );
        const generation = (await this.maxGeneration(node.id)) + 1;
        for (const row of rows) {
            const next = nextFleetScheduleFire(storedFleetScheduleCadence(row), node.timeZone ?? null, this.now());
            await this.schedules.update(row.id, {
                enabled: true,
                pausedAt: null,
                pausedReason: null,
                nextRunAt: next === null ? null : new Date(next),
                syncGeneration: generation,
            });
            await this.record('node.schedule.resume', actor, node, row.id, 'plain', {
                outcome: 'resumed',
                wasPausedFor: 'breaker',
            });
        }
        if (rows.length > 0) this.syncInBackground(node.id);
        return { resumed: rows.length };
    }

    // ─── Run now ───────────────────────────────────────────────────────────

    /**
     * Run now (spec S4, FR-19, class `confirm`): the machine starts it within
     * two seconds and the next scheduled fire does not move. `busy` while a
     * run is in flight; `unreachable` when the computer is offline.
     */
    async runNow(
        id: string,
        actor: FleetScheduleActor,
        confirm: boolean,
    ): Promise<{ runId: string; startedAt: string; nextRunAt: string | null; view: FleetScheduleView }> {
        this.assertEnabled();
        const command = await this.resolveOwn(id, actor);
        if (command.deletedAt) throw fleetCommandError('not_found', 'this schedule was deleted');
        const node = await this.nodes.findById(this.nodeIdOf(command));
        if (!node) throw fleetCommandError('not_found', 'the computer of this schedule was removed; move it first');
        await this.resolveNode(node.id, actor);
        await this.assertNotStopped();
        const consents = this.consentsOf(node);
        if (!consents.manage) {
            throw fleetCommandError('consent_missing', `start the node with --manage on ${node.name}`, {
                consent: 'manage',
            });
        }
        if (!this.isConnected(node.id)) {
            throw fleetCommandError('unreachable', `${node.name} is offline — Run now needs it online`);
        }
        const recent = await this.schedules.findRuns(command.id, 1);
        if (recent[0]?.status === 'running' && this.isStillRunning(recent[0])) {
            throw fleetCommandError('busy', 'a run of this schedule is still going');
        }
        if (confirm !== true) throw this.confirmation('run', this.shapeOf(command), node);

        const runId = randomUUID();
        const started = await this.requireNode().runNow(node.id, { id: command.id, runId }, this.caller(actor));
        const startedAt = parseInstant(started.startedAt) ?? new Date(this.now());
        await this.schedules.saveRun({
            id: runId,
            commandId: command.id,
            nodeId: node.id,
            startedAt,
            endedAt: null,
            exitCode: null,
            status: 'running',
            failedReason: null,
            errorCode: null,
            errorHint: null,
            outputHead: null,
            outputTail: null,
            truncated: false,
            capped: false,
            outputBytes: 0,
            outputRef: null,
            scheduledFor: null,
        });
        await this.record('node.schedule.run', actor, node, command.id, 'confirm', { outcome: 'started', runId });
        const view = await this.viewOf(command, node, await this.schedules.findRuns(command.id, 8));
        return { runId, startedAt: startedAt.toISOString(), nextRunAt: view.nextRunAt, view };
    }

    // ─── Reads ─────────────────────────────────────────────────────────────

    /** One of the person's schedules (deleted ones too, for 30 days). */
    async get(id: string, actor: FleetScheduleActor): Promise<FleetScheduleView> {
        const command = await this.resolveOwn(id, actor);
        return this.viewOf(command, await this.nodes.findById(this.nodeIdOf(command)));
    }

    /** True when `id` is one of the person's Command schedules (the API routes `/commands/:id` by it). */
    async isOwnSchedule(id: string, actor: FleetScheduleActor): Promise<boolean> {
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return false;
        const command = await this.schedules.find(id);
        return Boolean(command && command.userId === actor.userId);
    }

    /**
     * The person's schedules, optionally on one computer — the Schedules
     * view's `node_schedule` source and the computer tab read this. Deleted
     * ones are left out unless `includeDeleted` (the tab's "deleted" section).
     */
    async listForUser(
        actor: FleetScheduleActor,
        options: { nodeId?: string; includeDeleted?: boolean } = {},
    ): Promise<FleetScheduleView[]> {
        const since = options.includeDeleted
            ? new Date(this.now() - FLEET_SCHEDULE_DELETED_RETENTION_DAYS * 86_400_000)
            : null;
        let rows = await this.schedules.listForUser(actor.userId, since);
        if (options.nodeId) {
            const wanted = options.nodeId.toLowerCase();
            rows = rows.filter((row) => this.nodeIdOf(row) === wanted);
        }
        return this.viewsOf(rows);
    }

    /** One schedule's history, newest first (spec S6, FR-20: the last 30). */
    async runs(id: string, actor: FleetScheduleActor, limit: number = FLEET_SCHEDULE_HISTORY): Promise<FleetCommandRunView[]> {
        const command = await this.resolveOwn(id, actor);
        const nodeId = this.nodeIdOf(command);
        const node = await this.nodes.findById(nodeId);
        const runs = await this.schedules.findRuns(command.id, Math.min(FLEET_SCHEDULE_HISTORY, limit));
        const now = this.now();
        const linkUp = this.isConnected(nodeId);
        return runs.map((run) => toFleetScheduleRunView(run, node?.name ?? null, now, linkUp));
    }

    // ─── Sync (the machine's copy) ─────────────────────────────────────────

    /**
     * Send one computer its whole set (`schedule.sync`, FR-11): every live,
     * unpaused Command schedule on it, of every person. Called after every
     * change and on every link open. Without a link it does nothing — the
     * rows read `pending` until the next open. Never throws.
     */
    async syncNode(nodeId: string): Promise<void> {
        const key = nodeId.toLowerCase();
        const previous = this.syncing.get(key) ?? Promise.resolve();
        const next = previous.then(() => this.syncNodeOnce(key)).catch(() => undefined);
        this.syncing.set(key, next);
        await next;
        if (this.syncing.get(key) === next) this.syncing.delete(key);
    }

    private async syncNodeOnce(nodeId: string): Promise<void> {
        if (!this.node || !this.node.isConnected(nodeId)) return;
        const rows = await this.schedules.listForNode(nodeId, { includeDeleted: true });
        const live = rows.filter((row) => !row.deletedAt);
        const definitions: FleetScheduleDefinition[] = live
            .filter((row) => !row.pausedAt && row.enabled !== false && !row.commandRedacted)
            .map((row) => ({
                id: row.id,
                name: row.name ?? 'Schedule',
                command: row.command,
                ...(row.cwd ? { cwd: row.cwd } : {}),
                cadence: storedFleetScheduleCadence(row),
                timeoutSec: FLEET_SCHEDULE_RUN_CAP_SEC,
                revision: toIsoOrEmpty(row.updatedAt),
            }));
        const generation = rows.reduce((max, row) => Math.max(max, row.syncGeneration ?? 0), 0);
        try {
            const result = await this.node.sync(nodeId, { generation, definitions }, { kind: 'system', job: 'fleet-schedule-sync' });
            this.unsupported.delete(nodeId);
            await this.schedules.markSynced(
                rows.map((row) => row.id),
                Math.max(generation, result.generation),
            );
            for (const row of live) this.refusals.delete(row.id);
            for (const refused of result.refused) this.refusals.set(refused.id, refused.error);
            // The machine's own next fire wins (plan §15: two clocks, one answer).
            for (const row of live) {
                const at = result.next[row.id];
                if (at === undefined) continue;
                const nextRunAt = parseInstant(at);
                const before = row.nextRunAt ? toMs(row.nextRunAt) : null;
                const after = nextRunAt ? nextRunAt.getTime() : null;
                if (before !== after) await this.schedules.update(row.id, { nextRunAt });
            }
        } catch (error) {
            const typed = readFleetCommandError(error);
            if (typed?.code === 'unsupported_on_node') this.unsupported.add(nodeId);
            this.logger.debug(`schedule.sync to node ${nodeId} skipped: ${typed?.code ?? describe(error)}`);
        }
    }

    // ─── Reconcile (the machine's runs) ────────────────────────────────────

    /**
     * Ask one computer for the runs it made (`schedule.runs { since }`, FR-15)
     * and fold them into `fleet_command_runs`, idempotently by run id; then
     * apply the failure streak (FR-23). Called on link open and every five
     * minutes. Never throws.
     */
    async reconcileNode(nodeId: string): Promise<{ runs: number; paused: number }> {
        const key = nodeId.toLowerCase();
        if (!this.node || !this.node.isConnected(key)) return { runs: 0, paused: 0 };
        try {
            const rows = await this.schedules.listForNode(key, { includeDeleted: true });
            if (rows.length === 0) return { runs: 0, paused: 0 };
            const byId = new Map(rows.map((row) => [row.id, row]));
            const watermark = await this.schedules.latestEndedAtForNode(key, [...byId.keys()]);
            let since = watermark ? new Date(watermark.getTime() - SINCE_OVERLAP_MS).toISOString() : null;
            const node = await this.nodes.findById(key);
            const touched = new Set<string>();
            let count = 0;
            for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
                const result = await this.node.runs(key, since, { kind: 'system', job: 'fleet-schedule-reconcile' });
                let latest: string | null = since;
                for (const report of result.runs) {
                    const command = byId.get(report.scheduleId);
                    // A machine reports only what it holds; anything else is not this computer's.
                    if (!command) continue;
                    if (await this.recordReconciledRun(command, node, key, report)) {
                        count += 1;
                        touched.add(command.id);
                    }
                    if (report.endedAt && (!latest || report.endedAt > latest)) latest = report.endedAt;
                }
                if (!result.more || latest === since) break;
                since = latest;
            }
            let paused = 0;
            for (const id of touched) {
                const command = byId.get(id);
                if (command && (await this.applyFailureStreak(command, node))) paused += 1;
            }
            return { runs: count, paused };
        } catch (error) {
            this.logger.debug(
                `schedule.runs from node ${key} skipped: ${readFleetCommandError(error)?.code ?? describe(error)}`,
            );
            return { runs: 0, paused: 0 };
        }
    }

    /**
     * Fold one reported run into its row (insert or replace by the machine's
     * run id). Answers true when the row changed. The head and the tail pass
     * the secret scanner before they are written; a run that ENDS here for
     * the first time writes its `node.command.run` audit row (FR-27).
     */
    async recordReconciledRun(
        command: FleetCommand,
        node: Pick<FleetNode, 'id' | 'userId'> | null,
        nodeId: string,
        report: FleetScheduleRunReport,
    ): Promise<boolean> {
        const existing = await this.schedules.findRun(report.runId);
        if (existing && existing.commandId !== command.id) return false;
        if (existing && existing.status !== 'running' && existing.endedAt) return false;
        const startedAt = parseInstant(report.startedAt) ?? new Date(this.now());
        const endedAt = report.endedAt ? parseInstant(report.endedAt) : null;
        await this.schedules.saveRun({
            id: report.runId,
            commandId: command.id,
            nodeId,
            startedAt,
            endedAt,
            exitCode: report.exitCode,
            status: report.status,
            failedReason: report.failedReason,
            errorCode: null,
            errorHint: null,
            outputHead: redactSecrets(report.head).cleaned,
            outputTail: redactSecrets(report.tail).cleaned,
            truncated: report.truncated,
            capped: report.capped,
            outputBytes: Math.min(MAX_INT, report.bytes),
            outputRef: report.kept ? report.runId : null,
            scheduledFor: report.scheduledFor ? parseInstant(report.scheduledFor) : null,
        });
        const lastRunAt = command.lastRunAt ? toMs(command.lastRunAt) : null;
        if (lastRunAt === null || startedAt.getTime() > lastRunAt) {
            await this.schedules.update(command.id, { lastRunAt: startedAt });
            command.lastRunAt = startedAt;
        }
        if (report.status !== 'running' && this.audit) {
            await this.audit.tryRecord({
                action: 'node.command.run',
                actorUserId: null,
                ownerUserId: node?.userId ?? command.userId,
                nodeId,
                details: {
                    family: 'commands',
                    target: command.id,
                    nodeId,
                    runId: report.runId,
                    requestedBy: `schedule:${command.id}`,
                    confirmationClass: 'confirm',
                    outcome: report.status,
                    exitCode: report.exitCode,
                    trigger: report.trigger,
                    durationMs:
                        endedAt !== null ? Math.max(0, endedAt.getTime() - startedAt.getTime()) : null,
                    truncated: report.truncated,
                },
            });
        }
        return true;
    }

    /** Five failures in a row pause it (`failures`), with an Inbox notice (CONTRACTS §6, FR-23). */
    private async applyFailureStreak(
        command: FleetCommand,
        node: FleetNode | null,
    ): Promise<boolean> {
        const fresh = await this.schedules.find(command.id);
        if (!fresh || fresh.deletedAt || fresh.pausedAt || fresh.enabled === false) return false;
        const runs = (await this.schedules.findRuns(fresh.id, FLEET_SCHEDULE_FAILURE_PAUSE + 4)).filter(
            isCountedFleetScheduleRun,
        );
        const streak = fleetScheduleFailureStreak(runs as Array<{ status: FleetCommandRunStatus }>);
        if (streak < FLEET_SCHEDULE_FAILURE_PAUSE) return false;
        await this.applyPause(fresh, node, 'failures', null);
        const computer = node?.name ?? 'its computer';
        try {
            await this.inbox?.notice(fresh.userId, {
                title: `${fresh.name ?? 'A schedule'} paused after ${FLEET_SCHEDULE_FAILURE_PAUSE} failures in a row on ${computer}`,
                body: `Open it under Fleet → ${computer} → Schedules to read the last runs, then resume it when it is fixed.`,
            });
        } catch (error) {
            this.logger.debug(`schedule failure notice for ${fresh.id} not filed: ${describe(error)}`);
        }
        return true;
    }

    /**
     * One pass for every computer that holds a schedule (every five minutes,
     * FR-15): re-send a set the machine has not acknowledged, then read its
     * runs. Only computers this replica (or another) holds a link to are
     * contacted. Never throws.
     */
    async reconcileAll(): Promise<FleetScheduleReconcileSummary> {
        const summary: FleetScheduleReconcileSummary = { nodes: 0, synced: 0, runs: 0, paused: 0 };
        let nodeIds: string[] = [];
        try {
            nodeIds = await this.schedules.listScheduledNodeIds();
        } catch (error) {
            this.logger.warn(`schedule reconcile could not list computers: ${describe(error)}`);
            return summary;
        }
        for (const nodeId of nodeIds) {
            if (!this.isConnected(nodeId)) continue;
            summary.nodes += 1;
            const rows = await this.schedules.listForNode(nodeId, { includeDeleted: true }).catch(() => []);
            if (rows.some((row) => (row.syncGeneration ?? 0) > (row.syncedGeneration ?? 0))) {
                await this.syncNode(nodeId);
                summary.synced += 1;
            }
            const outcome = await this.reconcileNode(nodeId);
            summary.runs += outcome.runs;
            summary.paused += outcome.paused;
        }
        return summary;
    }

    /** A link (re)connected (FR-11): send the set, then read the runs made while it was away. */
    async onLinkOpen(nodeId: string): Promise<void> {
        try {
            const rows = await this.schedules.listForNode(nodeId, { includeDeleted: true });
            if (rows.length === 0) return;
            await this.syncNode(nodeId);
            await this.reconcileNode(nodeId);
        } catch (error) {
            this.logger.debug(`schedule link-open pass for node ${nodeId} skipped: ${describe(error)}`);
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    /**
     * Run now, Pause and Resume also arrive through the Schedules routes, which
     * `FleetCommandsEnabledGuard` does not cover: with `FLEET_COMMANDS_ENABLED`
     * off a schedule is as unknown as a missing one (the 404 the guard answers).
     */
    private assertEnabled(): void {
        if (!config.fleet.isCommandsEnabled()) throw fleetCommandError('not_found', 'no such schedule');
    }

    private async applyPause(
        command: FleetCommand,
        node: FleetNode | null,
        reason: FleetSchedulePausedReason,
        actor: FleetScheduleActor | null,
    ): Promise<void> {
        const nodeId = this.nodeIdOf(command);
        const generation = (await this.maxGeneration(nodeId)) + 1;
        await this.schedules.update(command.id, {
            pausedAt: new Date(this.now()),
            pausedReason: reason,
            nextRunAt: null,
            syncGeneration: generation,
        });
        const target = node ?? { id: nodeId, userId: command.userId };
        if (actor) {
            await this.record('node.schedule.pause', actor, target, command.id, 'plain', { outcome: 'paused', reason });
        } else if (this.audit) {
            await this.audit.tryRecord({
                action: 'node.schedule.pause',
                actorUserId: null,
                ownerUserId: target.userId,
                nodeId,
                details: {
                    family: 'schedules',
                    target: command.id,
                    nodeId,
                    requestedBy: reason === 'failures' ? 'system:failure-streak' : `system:${reason}`,
                    confirmationClass: 'plain',
                    outcome: 'paused',
                    reason,
                },
            });
        }
        this.syncInBackground(nodeId);
    }

    /** The person's own schedule (spec §8b default: a schedule is its author's). */
    private async resolveOwn(id: string, actor: FleetScheduleActor): Promise<FleetCommand> {
        const command =
            typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? await this.schedules.find(id) : null;
        if (!command || command.userId !== actor.userId) throw fleetCommandError('not_found', 'no such schedule');
        if (command.deletedAt) {
            const age = this.now() - toMs(command.deletedAt);
            if (age > FLEET_SCHEDULE_DELETED_RETENTION_DAYS * 86_400_000) {
                throw fleetCommandError('not_found', 'no such schedule');
            }
        }
        return command;
    }

    /** The computer, with the `schedules` audience, and able to hold schedules. */
    private async resolveNode(nodeId: string, actor: FleetScheduleActor): Promise<FleetNode> {
        let node: FleetNode;
        try {
            ({ node } = await this.access.resolveForFamily(nodeId, actor.userId, 'schedules'));
        } catch (error) {
            const typed = readFleetCommandError(error);
            if (typed?.code === 'permission_denied') {
                throw fleetCommandError('permission_denied', typed.hint, typed.details);
            }
            throw fleetCommandError('not_found', 'no such computer', { nodeId });
        }
        const refusal = fleetScheduleNodeRefusal({ name: node.name, kind: node.kind, status: node.status });
        if (refusal) throw fleetCommandError(refusal.code, refusal.hint, refusal.details);
        return node;
    }

    private confirmation(
        action: FleetScheduleConfirmAction,
        shape: FleetScheduleShape,
        node: FleetNode | null,
        extra: Partial<FleetScheduleConfirmationDetails> = {},
    ) {
        const zone = node?.timeZone ?? null;
        const details: FleetScheduleConfirmationDetails = {
            class: 'confirm',
            action,
            name: shape.name,
            command: redactSecrets(shape.command).cleaned,
            nodeId: node?.id ?? shape.nodeId,
            nodeName: node?.name ?? 'a removed computer',
            shell: fleetScheduleShellLabel(node?.platform ?? null),
            user: 'machine-owner',
            folder: shape.cwd ?? '~',
            cadenceHuman: describeFleetScheduleCadence(shape.cadence),
            nodeTimeZone: zone,
            next: previewFleetScheduleFires(shape.cadence, zone, this.now(), 3).map((ms) => new Date(ms).toISOString()),
            sentence: FLEET_SCHEDULE_SANDBOX_SENTENCE,
            ...extra,
        };
        const where = node?.name ?? 'the computer';
        const hint: Record<FleetScheduleConfirmAction, string> = {
            create: `Schedule "${shape.name}" on ${where}?`,
            update: `Change what "${shape.name}" runs on ${where}?`,
            move: `Move "${shape.name}" to ${extra.toNodeName ?? 'another computer'}?`,
            delete: `Delete "${shape.name}" on ${where}?`,
            run: `Run "${shape.name}" on ${where} now?`,
        };
        return fleetCommandError(
            'confirmation_required',
            hint[action],
            details as unknown as Record<string, unknown>,
        );
    }

    private shapeOf(command: FleetCommand): FleetScheduleShape {
        return {
            name: command.name ?? 'Schedule',
            nodeId: this.nodeIdOf(command),
            command: command.command,
            cwd: command.cwd ?? null,
            cadence: storedFleetScheduleCadence(command),
        };
    }

    private nodeIdOf(command: Pick<FleetCommand, 'nodeIds'>): string {
        return ((command.nodeIds ?? [])[0] ?? '').toLowerCase();
    }

    private async maxGeneration(nodeId: string): Promise<number> {
        const rows = await this.schedules.listForNode(nodeId, { includeDeleted: true });
        return rows.reduce((max, row) => Math.max(max, row.syncGeneration ?? 0), 0);
    }

    private async viewOf(
        command: FleetCommand,
        node: FleetNode | null,
        runs?: readonly FleetCommandRun[],
    ): Promise<FleetScheduleView> {
        const history = runs ?? (await this.schedules.findRuns(command.id, FLEET_SCHEDULE_FAILURE_PAUSE + 4));
        return this.buildView(command, node, history);
    }

    private async viewsOf(rows: FleetCommand[]): Promise<FleetScheduleView[]> {
        if (rows.length === 0) return [];
        const nodeIds = [...new Set(rows.map((row) => this.nodeIdOf(row)))];
        const nodes = new Map<string, FleetNode>();
        for (const nodeId of nodeIds) {
            const node = await this.nodes.findById(nodeId);
            if (node) nodes.set(nodeId, node);
        }
        const runs = await this.schedules.findRecentRunsFor(
            rows.map((row) => row.id),
            FLEET_SCHEDULE_FAILURE_PAUSE + 4,
        );
        return rows.map((row) => this.buildView(row, nodes.get(this.nodeIdOf(row)) ?? null, runs.get(row.id) ?? []));
    }

    private buildView(command: FleetCommand, node: FleetNode | null, runs: readonly FleetCommandRun[]): FleetScheduleView {
        const nodeId = this.nodeIdOf(command);
        const unsupported = this.unsupported.has(nodeId);
        return toFleetScheduleView({
            command,
            node: node ? { id: node.id, name: node.name, timeZone: node.timeZone ?? null } : null,
            runs,
            neverRuns: fleetScheduleNeverRuns({
                nodeExists: node !== null,
                nodeName: node?.name ?? 'the computer',
                unsupported,
                consents: node ? this.consentsOf(node) : null,
            }),
            unsupported,
            refusal: this.refusals.get(command.id) ?? null,
            linkUp: node ? this.isConnected(node.id) : false,
            now: this.now(),
        });
    }

    private consentsOf(node: FleetNode): FleetConsents {
        return (
            this.node?.liveConsents(node.id) ??
            effectiveConsents({
                consents: node.consents,
                capabilities: node.capabilities,
                workerState: node.workerState,
            })
        );
    }

    /** A `running` row older than the cap plus the link-lost grace is not running any more. */
    private isStillRunning(run: FleetCommandRun): boolean {
        const started = toMs(run.startedAt);
        return Number.isFinite(started) && this.now() - started < (FLEET_SCHEDULE_RUN_CAP_SEC + 600) * 1000;
    }

    private isConnected(nodeId: string): boolean {
        return this.node?.isConnected(nodeId) ?? false;
    }

    private requireNode(): FleetScheduleNodePort {
        if (!this.node) throw fleetCommandError('unreachable', 'this deployment does not reach computers');
        return this.node;
    }

    private syncInBackground(nodeId: string): void {
        if (!nodeId) return;
        void this.syncNode(nodeId).catch((error: unknown) =>
            this.logger.debug(`schedule sync of node ${nodeId} failed: ${describe(error)}`),
        );
    }

    private caller(actor: FleetScheduleActor): FleetCommandPortCaller {
        return actor.agentId
            ? { kind: 'agent', agentId: actor.agentId, ownerUserId: actor.userId }
            : { kind: 'user', userId: actor.userId };
    }

    private assertRate(userId: string): void {
        const refusal = checkFleetScheduleWriteRate(this.recentCount(userId));
        if (refusal) throw fleetCommandError(refusal.code, refusal.hint, refusal.details);
    }

    private recentCount(userId: string): number {
        const cutoff = this.now() - RATE_WINDOW_MS;
        const kept = (this.recent.get(userId) ?? []).filter((at) => at > cutoff);
        if (kept.length > 0) this.recent.set(userId, kept);
        else this.recent.delete(userId);
        return kept.length;
    }

    private noteWrite(userId: string): void {
        const list = this.recent.get(userId) ?? [];
        list.push(this.now());
        this.recent.set(userId, list);
    }

    private async assertNotStopped(hint = 'clear it under Settings → Fleet'): Promise<void> {
        let stopped = true;
        try {
            stopped = await this.killSwitch.isStopped();
        } catch {
            stopped = true;
        }
        if (stopped) throw fleetCommandError('kill_switch', hint);
    }

    private async record(
        action: FleetAuditAction,
        actor: FleetScheduleActor,
        node: Pick<FleetNode, 'id' | 'userId'>,
        commandId: string,
        confirmationClass: 'confirm' | 'plain',
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId: actor.userId,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: {
                family: 'schedules',
                target: commandId,
                scheduleId: fleetNodeScheduleRowId(commandId),
                nodeId: node.id,
                requestedBy: actor.agentId ? `agent:${actor.agentId}` : `user:${actor.userId}`,
                confirmationClass,
                ...details,
            },
        });
    }
}

function parseInstant(value: string | null | undefined): Date | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : null;
}

function toMs(value: Date | string): number {
    return value instanceof Date ? value.getTime() : Date.parse(String(value));
}

function toIsoOrEmpty(value: Date | string | null | undefined): string {
    if (!value) return '';
    const ms = toMs(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
