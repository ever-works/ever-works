import { Inject, Injectable, Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
    effectiveConsents,
    fleetCommandRunEndFor,
    FleetCommandEdgeBuffer,
    fleetCommandStateFor,
    FLEET_COMMAND_KILL_GRACE_MS,
    FLEET_COMMAND_LINK_LOST_GRACE_MS,
    FLEET_COMMAND_RECENT,
    FLEET_COMMAND_SANDBOX_SENTENCE,
    type FleetAuditAction,
    type FleetCommandConfirmationDetails,
    type FleetCommandFailedReason,
    type FleetCommandListResponse,
    type FleetCommandNodeMessage,
    type FleetCommandOutputMessage,
    type FleetCommandRequester,
    type FleetCommandRunRequest,
    type FleetCommandRunStatus,
    type FleetCommandRunView,
    type FleetCommandView,
    type FleetLinkError,
} from '@ever-works/contracts';
import type { FleetCommand } from '../../entities/fleet-command.entity';
import type { FleetCommandRun } from '../../entities/fleet-command-run.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import { redactSecrets } from '../../utils/secret-scan';
import { FleetAccessService } from '../fleet-access.service';
import { FleetAuditService } from '../fleet-audit.service';
import { FleetKillSwitchService } from '../fleet-kill-switch.service';
import { FleetNodeRepository } from '../fleet-node.repository';
import { fleetCommandError, readFleetCommandError } from './fleet-command.errors';
import {
    FLEET_COMMAND_NODE_PORT,
    type FleetCommandNodePort,
    type FleetCommandPortCaller,
    type FleetCommandRunHandle,
    type FleetCommandRunSink,
} from './fleet-command-node.port';
import {
    checkFleetCommandAdmission,
    checkFleetCommandRequest,
    describeFleetCommandAgo,
    fleetCommandOlderNodeHint,
    fleetCommandTargetRefusal,
    fleetCommandTargetSummary,
    type FleetCommandRequestShape,
} from './fleet-command.policy';
import { FleetCommandRepository } from './fleet-command.repository';
import { toFleetCommandRunView, toFleetCommandView } from './fleet-command.view';

/**
 * Commands on computers (FL-12) — the platform's one writer of
 * `fleet_commands` and `fleet_command_runs` (CONTRACTS §2.2, §2.3, §4.4, §7,
 * §8, §10, R-11, R-24; spec FR-1 … FR-19).
 *
 * A run request goes, in order: its shape (`checkFleetCommandRequest`), the
 * existence and `commands` audience of every computer (an id the person may
 * not see is the 404 of an unknown one; one they see but may not command is
 * a per-computer `permission_denied`), the kill switch and the limits, then
 * the confirmation (CONTRACTS §2.2 class `confirm`: without `confirm: true`
 * the answer is `confirmation_required` with one summary line per computer),
 * then the rows, then — in the background, so the API answers at once — one
 * `command` channel per runnable computer. Each computer gets one
 * `node.command.run` audit row as it is dispatched or refused (who ran what,
 * written before anything happens on the machine — spec FR-12's "within 2
 * seconds"); its end is on the run row.
 *
 * Live output: each run's head and tail are kept in a constant-memory buffer
 * on the replica holding its channel and flushed to the run row at most once
 * a second; the hub and the CLI read the rows (lane-log decision 1). The
 * node's own `command.output` replaces the live copy at the end (decision 2).
 * The command line, the head and the tail pass the secret scanner before they
 * are written (FR-13); no output and no command line is ever logged.
 */

/** Who acts. P1: a person; P2 adds Agents (`agentId`, its owner as `userId`). */
export interface FleetCommandActor {
    userId: string;
    agentId?: string;
}

/** A run whose channel this replica holds. */
interface LiveRun {
    runId: string;
    commandId: string;
    nodeId: string;
    node: Pick<FleetNode, 'id' | 'userId' | 'name'>;
    actor: FleetCommandActor;
    startedAt: number;
    timeoutSec: number;
    edges: FleetCommandEdgeBuffer;
    capped: boolean;
    timedOut: boolean;
    final: FleetCommandOutputMessage | null;
    exitCode: number | null | undefined;
    handle: FleetCommandRunHandle | null;
    ended: boolean;
    dirty: boolean;
    lastFlushAt: number;
    flushTimer: ReturnType<typeof setTimeout> | null;
    flushing: Promise<void> | null;
}

/** One computer of a request, after existence and the audience: its refusal, or null to run. */
interface ResolvedTarget {
    nodeId: string;
    node: FleetNode;
    refusal: FleetLinkError | null;
}

/** How often a live run's head and tail are written to its row. */
const FLUSH_INTERVAL_MS = 1_000;
/** A row column is an `int`: a byte count never overflows it. */
const MAX_INT = 2_147_483_647;
/** How often a person's Command rate window is read (CONTRACTS §10.1). */
const RATE_WINDOW_MS = 60_000;

@Injectable()
export class FleetCommandService implements OnModuleDestroy {
    private readonly logger = new Logger(FleetCommandService.name);
    private readonly live = new Map<string, LiveRun>();
    /** Confirmed Commands per person in the last minute, on this replica. */
    private readonly recent = new Map<string, number[]>();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly commands: FleetCommandRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        @Optional() private readonly audit?: FleetAuditService,
        @Optional() @Inject(FLEET_COMMAND_NODE_PORT) private readonly node?: FleetCommandNodePort,
    ) {}

    onModuleDestroy(): void {
        for (const live of this.live.values()) {
            if (live.flushTimer) clearTimeout(live.flushTimer);
            live.flushTimer = null;
        }
    }

    // ─── Run ───────────────────────────────────────────────────────────────

    /**
     * Run a Command (spec FR-1 … FR-14). Answers the Command with its runs at
     * once (`202`): runnable computers read `running`, refused ones `failed`
     * with their refusal; output then fills the rows as it arrives.
     */
    async run(
        actor: FleetCommandActor,
        request: FleetCommandRunRequest,
    ): Promise<FleetCommandView> {
        const shape: FleetCommandRequestShape = {
            command: '',
            nodeIds: [],
            cwd: null,
            timeoutSec: 0,
        };
        const invalid = checkFleetCommandRequest(request ?? {}, shape);
        if (invalid) throw fleetCommandError(invalid.code, invalid.hint, invalid.details);

        const targets = await this.resolveTargets(shape.nodeIds, actor);
        const killSwitchOn = await this.isStopped();
        const admission = checkFleetCommandAdmission({
            killSwitchOn,
            running: await this.commands.countRunningForUser(actor.userId),
            lastMinute: this.recentCount(actor.userId),
        });
        if (admission) throw fleetCommandError(admission.code, admission.hint, admission.details);

        const summary = targets.map((target) =>
            fleetCommandTargetSummary({
                nodeId: target.nodeId,
                nodeName: target.node.name,
                platform: target.node.platform ?? null,
                cwd: shape.cwd,
                refusal: target.refusal,
            }),
        );
        const runnable = summary.filter((line) => line.runnable).length;
        if (request.confirm !== true) {
            const details: FleetCommandConfirmationDetails = {
                class: 'confirm',
                command: redactSecrets(shape.command).cleaned,
                timeoutSec: shape.timeoutSec,
                sentence: FLEET_COMMAND_SANDBOX_SENTENCE,
                summary,
                runnable,
            };
            throw fleetCommandError(
                'confirmation_required',
                targets.length === 1
                    ? `Run on ${targets[0].node.name}?`
                    : `Run on ${targets.length} computers?`,
                details as unknown as Record<string, unknown>,
            );
        }
        this.noteRun(actor.userId);

        const now = this.now();
        const startedAt = new Date(now);
        const redacted = redactSecrets(shape.command);
        const command = await this.commands.createCommand({
            id: randomUUID(),
            userId: actor.userId,
            nodeIds: shape.nodeIds,
            command: redacted.cleaned,
            commandRedacted: redacted.redactions > 0,
            cwd: shape.cwd,
            timeoutSec: shape.timeoutSec,
            cadence: null,
            name: null,
            enabled: true,
            requestedBy: actor.agentId ? 'agent' : 'user',
            state: runnable > 0 ? 'running' : 'failed',
            lastRunAt: startedAt,
            nextRunAt: null,
        });
        const rows = await this.commands.createRuns(
            targets.map((target) => ({
                id: randomUUID(),
                commandId: command.id,
                nodeId: target.nodeId,
                startedAt,
                endedAt: target.refusal ? startedAt : null,
                exitCode: null,
                status: (target.refusal ? 'failed' : 'running') as FleetCommandRunStatus,
                failedReason: null,
                errorCode: target.refusal?.code ?? null,
                errorHint: target.refusal?.hint ?? null,
                outputHead: null,
                outputTail: null,
                truncated: false,
                capped: false,
                outputBytes: 0,
                outputRef: null,
            })),
        );

        const names = new Map(targets.map((target) => [target.nodeId, target.node.name]));
        for (const row of rows) {
            const target = targets.find((entry) => entry.nodeId === row.nodeId);
            if (!target) continue;
            if (target.refusal) {
                await this.record('node.command.run', actor, target.node, command.id, {
                    runId: row.id,
                    outcome: 'refused',
                    code: target.refusal.code,
                });
                continue;
            }
            // In the background: the API answers now; the cards fill as the machines answer.
            void this.dispatch(command, row, target.node, actor, shape.command).catch(
                (error: unknown) =>
                    this.logger.warn(
                        `command run ${row.id} on node ${row.nodeId} failed to dispatch: ${describe(error)}`,
                    ),
            );
        }
        return toFleetCommandView(command, rows, names, now, (nodeId) => this.isConnected(nodeId));
    }

    // ─── Cancel ────────────────────────────────────────────────────────────

    /**
     * Stop a Command's running runs (spec P2, CONTRACTS §11.2 `/commands/:id/cancel`;
     * confirmation class `plain`). Each machine is asked on a short-lived
     * channel of its own, so the request works from any API replica; the
     * run's own channel then reports the end (`cancelled-by-user`, EXIT 130).
     * A machine that cannot be reached keeps its run until the link-lost
     * sweep ends it. Idempotent.
     */
    async cancel(id: string, actor: FleetCommandActor): Promise<FleetCommandView> {
        const command = await this.resolve(id, actor);
        const runs = await this.commands.findRuns(command.id);
        const running = runs.filter((run) => run.status === 'running');
        if (running.length === 0) return this.view(command, runs);
        await this.commands.updateCommand(command.id, { state: 'cancelled' });
        for (const run of running) {
            const node = (await this.nodes.findById(run.nodeId)) ?? {
                id: run.nodeId,
                userId: command.userId,
                name: 'a removed computer',
            };
            let outcome = 'requested';
            try {
                await this.requireNode().cancel({
                    nodeId: run.nodeId,
                    commandId: command.id,
                    runId: run.id,
                    caller: this.caller(actor),
                });
            } catch (error) {
                outcome = `not-delivered:${readFleetCommandError(error)?.code ?? 'internal'}`;
            }
            await this.record('node.command.cancel', actor, node, command.id, {
                runId: run.id,
                reason: 'user',
                outcome,
                confirmationClass: 'plain',
            });
        }
        return this.view(
            { ...command, state: 'cancelled' },
            await this.commands.findRuns(command.id),
        );
    }

    // ─── Reads ─────────────────────────────────────────────────────────────

    /** One Command with its runs (the person's own — spec §8b default). */
    async get(id: string, actor: FleetCommandActor): Promise<FleetCommandView> {
        const command = await this.resolve(id, actor);
        const runs = await this.sweepStale(command, await this.commands.findRuns(command.id));
        return this.view(command, runs);
    }

    /** A Command's runs. */
    async runs(id: string, actor: FleetCommandActor): Promise<FleetCommandRunView[]> {
        return (await this.get(id, actor)).runs;
    }

    /** The person's last one-off Commands, newest first (Recent, spec FR-17). */
    async listRecent(
        actor: FleetCommandActor,
        limit: number = FLEET_COMMAND_RECENT,
        options: { requestedBy?: FleetCommandRequester } = {},
    ): Promise<FleetCommandListResponse> {
        const commands = await this.commands.listRecentForUser(actor.userId, limit, options);
        const runs = await this.commands.findRunsFor(commands.map((command) => command.id));
        const byCommand = new Map<string, FleetCommandRun[]>();
        for (const run of runs) {
            const list = byCommand.get(run.commandId) ?? [];
            list.push(run);
            byCommand.set(run.commandId, list);
        }
        const names = await this.namesFor(runs.map((run) => run.nodeId));
        const now = this.now();
        const views: FleetCommandView[] = [];
        for (const command of commands) {
            const swept = await this.sweepStale(command, byCommand.get(command.id) ?? []);
            views.push(
                toFleetCommandView(command, swept, names, now, (nodeId) =>
                    this.isConnected(nodeId),
                ),
            );
        }
        return { commands: views };
    }

    /** The latest run on a computer, for its Overview ("Last command", spec §5.3 — P2). */
    async lastRunForNode(
        nodeId: string,
        actor: FleetCommandActor,
    ): Promise<{ commandId: string; command: string; run: FleetCommandRunView } | null> {
        try {
            await this.access.resolveForFamily(nodeId, actor.userId, 'commands');
        } catch (error) {
            const typed = readFleetCommandError(error);
            if (typed?.code === 'permission_denied') return null;
            throw fleetCommandError('not_found', 'no such computer');
        }
        const run = await this.commands.findLatestRunForNode(nodeId);
        if (!run) return null;
        const command = await this.commands.findCommand(run.commandId);
        // Only the person's own Commands (spec §8b default).
        if (!command || command.userId !== actor.userId) return null;
        const names = await this.namesFor([nodeId]);
        return {
            commandId: command.id,
            command: command.command,
            run: toFleetCommandRunView(run, names.get(nodeId) ?? null, this.now(), (id) =>
                this.isConnected(id),
            ),
        };
    }

    /**
     * "Open full output" (spec FR-6, FR-18, P2): the run and its computer, once
     * the person may read it — their own Command, a run the machine kept the
     * output of, and a computer whose link is up (otherwise `unreachable`
     * naming when it was last seen: "the full output is on build-02, which is
     * offline"). The API streams the file over a channel of its own.
     */
    async authorizeFullOutput(
        id: string,
        runId: string,
        actor: FleetCommandActor,
    ): Promise<{ command: FleetCommand; run: FleetCommandRun; nodeName: string }> {
        const command = await this.resolve(id, actor);
        const run =
            typeof runId === 'string' && /^[0-9a-f-]{36}$/i.test(runId)
                ? await this.commands.findRun(runId)
                : null;
        if (!run || run.commandId !== command.id)
            throw fleetCommandError('not_found', 'no such run');
        const node = await this.nodes.findById(run.nodeId);
        const nodeName = node?.name ?? 'the computer';
        if (!node)
            throw fleetCommandError(
                'not_found',
                'that computer was removed; its output went with it',
            );
        if (!run.outputRef) {
            throw fleetCommandError(
                'not_found',
                `${nodeName} did not keep the full output of this run`,
            );
        }
        if (!this.isConnected(node.id)) {
            const ago = describeFleetCommandAgo(node.lastHeartbeatAt ?? null, this.now());
            throw fleetCommandError(
                'unreachable',
                ago
                    ? `the full output is on ${nodeName}, which is offline — last seen ${ago} ago`
                    : `the full output is on ${nodeName}, which is offline`,
            );
        }
        return { command, run, nodeName };
    }

    // ─── The machines ──────────────────────────────────────────────────────

    /** Every computer of a request, after existence and the `commands` audience. */
    private async resolveTargets(
        nodeIds: readonly string[],
        actor: FleetCommandActor,
    ): Promise<ResolvedTarget[]> {
        const now = this.now();
        return Promise.all(
            nodeIds.map(async (nodeId): Promise<ResolvedTarget> => {
                let node: FleetNode;
                try {
                    ({ node } = await this.access.resolveForFamily(
                        nodeId,
                        actor.userId,
                        'commands',
                    ));
                } catch (error) {
                    const typed = readFleetCommandError(error);
                    if (typed?.code === 'permission_denied') {
                        // Visible, outside the `commands` audience: this computer's own refusal (U4, S4).
                        const visible = await this.nodes.findById(nodeId);
                        if (visible) {
                            return {
                                nodeId: visible.id,
                                node: visible,
                                refusal: {
                                    code: 'permission_denied',
                                    hint: typed.hint,
                                    details: typed.details,
                                },
                            };
                        }
                    }
                    throw fleetCommandError('not_found', 'no such computer', { nodeId });
                }
                const consents =
                    this.node?.liveConsents(node.id) ??
                    effectiveConsents({
                        consents: node.consents,
                        capabilities: node.capabilities,
                        workerState: node.workerState,
                    });
                const refusal = fleetCommandTargetRefusal({
                    node: {
                        name: node.name,
                        status: node.status,
                        kind: node.kind,
                        platform: node.platform ?? null,
                    },
                    consents,
                    linkConnected: this.isConnected(node.id),
                    lastSeenAgo: describeFleetCommandAgo(node.lastHeartbeatAt ?? null, now),
                });
                return { nodeId: node.id, node, refusal };
            }),
        );
    }

    /** Open one run's channel and start the command on its machine. */
    private async dispatch(
        command: FleetCommand,
        row: FleetCommandRun,
        node: FleetNode,
        actor: FleetCommandActor,
        commandLine: string,
    ): Promise<void> {
        const live: LiveRun = {
            runId: row.id,
            commandId: command.id,
            nodeId: node.id,
            node: { id: node.id, userId: node.userId, name: node.name },
            actor,
            startedAt: this.now(),
            timeoutSec: command.timeoutSec,
            edges: new FleetCommandEdgeBuffer(),
            capped: false,
            timedOut: false,
            final: null,
            exitCode: undefined,
            handle: null,
            ended: false,
            dirty: false,
            lastFlushAt: 0,
            flushTimer: null,
            flushing: null,
        };
        this.live.set(row.id, live);
        try {
            const { handle, started } = await this.requireNode().start({
                nodeId: node.id,
                commandId: command.id,
                runId: row.id,
                command: commandLine,
                ...(command.cwd ? { cwd: command.cwd } : {}),
                timeoutSec: command.timeoutSec,
                caller: this.caller(actor),
                sink: this.sinkFor(live),
            });
            live.handle = handle;
            await this.record('node.command.run', actor, node, command.id, {
                runId: row.id,
                outcome: 'started',
                shell: typeof started?.shell === 'string' ? started.shell.slice(0, 120) : null,
            });
        } catch (error) {
            const typed = readFleetCommandError(error) ?? {
                code: 'internal' as const,
                hint: 'the command could not be sent',
            };
            const refusal: FleetLinkError =
                typed.code === 'unsupported_on_node'
                    ? { code: 'unsupported_on_node', hint: fleetCommandOlderNodeHint(node.name) }
                    : { code: typed.code, hint: typed.hint };
            await this.finish(live, {
                status: 'failed',
                failedReason: typed.code === 'operation_failed' ? 'shell-failed' : null,
                exitCode: null,
                error: refusal,
            });
            await this.record('node.command.run', actor, node, command.id, {
                runId: row.id,
                outcome: 'refused',
                code: refusal.code,
            });
        }
    }

    /** What a run's channel reports, into its live state. Never throws into the transport. */
    private sinkFor(live: LiveRun): FleetCommandRunSink {
        const guard = (what: string, work: () => void) => {
            try {
                work();
            } catch (error) {
                this.logger.debug(`command run ${live.runId}: ${what} failed: ${describe(error)}`);
            }
        };
        return {
            data: (bytes) =>
                guard('data', () => {
                    if (live.ended) return;
                    live.edges.push(bytes);
                    this.markDirty(live);
                }),
            message: (message: FleetCommandNodeMessage) =>
                guard('message', () => {
                    if (live.ended || message.runId !== live.runId) return;
                    if (message.type === 'command.truncated') {
                        live.capped = true;
                        this.markDirty(live);
                    } else if (message.type === 'command.timeout') {
                        live.timedOut = true;
                    } else if (message.type === 'command.output') {
                        live.final = message;
                    }
                }),
            exit: (code) =>
                guard('exit', () => {
                    if (live.ended) return;
                    live.exitCode = code;
                    void this.finishFromNode(live).catch((error: unknown) =>
                        this.logger.warn(
                            `command run ${live.runId} could not be ended: ${describe(error)}`,
                        ),
                    );
                }),
            closed: (reason, hint) =>
                guard('closed', () => {
                    if (live.ended || live.exitCode !== undefined) return;
                    void this.finishClosed(live, reason, hint).catch((error: unknown) =>
                        this.logger.warn(
                            `command run ${live.runId} could not be ended: ${describe(error)}`,
                        ),
                    );
                }),
            resumed: () => guard('resumed', () => this.markDirty(live)),
        };
    }

    /** The machine reported the exit: its own head and tail when it sent them (decision 2). */
    private async finishFromNode(live: LiveRun): Promise<void> {
        const final = live.final;
        const exitCode = final?.exitCode ?? (live.exitCode === undefined ? null : live.exitCode);
        const end = fleetCommandRunEndFor(
            exitCode,
            final?.reason ?? (live.timedOut ? 'timeout' : undefined),
        );
        const error: FleetLinkError | null =
            final?.reason === 'shell-failed'
                ? { code: 'operation_failed', hint: final.detail ?? 'the shell could not start' }
                : null;
        await this.finish(live, {
            status: end.status,
            failedReason: end.failedReason,
            exitCode,
            error,
        });
    }

    /** The channel closed without an exit: the link was lost, the consent withdrawn, or the machine quit. */
    private async finishClosed(live: LiveRun, reason: string, hint?: string): Promise<void> {
        if (reason === 'resume_failed' || reason === 'unreachable') {
            await this.finish(live, {
                status: 'failed',
                failedReason: 'link-lost',
                exitCode: null,
                error: null,
            });
            return;
        }
        const error: FleetLinkError =
            reason === 'normal'
                ? {
                      code: 'operation_failed',
                      hint: `${live.node.name} ended the command without an exit code`,
                  }
                : {
                      code: readCloseCode(reason),
                      hint: hint ?? `the connection to ${live.node.name} closed (${reason})`,
                  };
        await this.finish(live, { status: 'failed', failedReason: null, exitCode: null, error });
    }

    /**
     * End a live run: write its row once (a conditional update — the first end
     * wins), settle the Command, and for a stop the machine made on the
     * platform's behalf (kill switch, drain) write `node.command.cancel`.
     */
    private async finish(
        live: LiveRun,
        end: {
            status: FleetCommandRunStatus;
            failedReason: FleetCommandFailedReason | null;
            exitCode: number | null;
            error: FleetLinkError | null;
        },
    ): Promise<void> {
        if (live.ended) return;
        live.ended = true;
        if (live.flushTimer) clearTimeout(live.flushTimer);
        live.flushTimer = null;
        this.live.delete(live.runId);
        if (live.flushing) await live.flushing.catch(() => undefined);

        const final = live.final;
        const snapshot = live.edges.snapshot();
        const head = final ? final.head : snapshot.head;
        const tail = final ? final.tail : snapshot.tail;
        const truncated = final ? final.truncated : snapshot.truncated;
        const bytes = Math.max(final?.bytes ?? 0, snapshot.bytes);
        const won = await this.commands.updateRunIfRunning(live.runId, {
            status: end.status,
            failedReason: end.failedReason,
            exitCode: end.exitCode,
            endedAt: new Date(this.now()),
            outputHead: redactSecrets(head).cleaned,
            outputTail: redactSecrets(tail).cleaned,
            truncated,
            capped: live.capped || final?.capped === true,
            outputBytes: Math.min(MAX_INT, bytes),
            outputRef: final?.kept ? live.runId : null,
            errorCode: end.error?.code ?? null,
            errorHint: end.error?.hint ?? null,
        });
        if (!won) return;
        if (end.failedReason === 'kill-switch' || end.failedReason === 'drain') {
            await this.recordSystem('node.command.cancel', live.node, live.commandId, {
                runId: live.runId,
                reason: end.failedReason,
                outcome: 'stopped',
                requestedBy: `system:${end.failedReason}`,
                confirmationClass: 'plain',
            });
        }
        await this.settle(live.commandId);
    }

    /** The Command's own state once every run ended (spec FR-4). */
    private async settle(commandId: string): Promise<void> {
        const command = await this.commands.findCommand(commandId);
        if (!command) return;
        const runs = await this.commands.findRuns(commandId);
        if (runs.some((run) => run.status === 'running')) return;
        const state = fleetCommandStateFor(runs, command.state === 'cancelled');
        if (state !== command.state) await this.commands.updateCommand(commandId, { state });
    }

    /**
     * Runs still `running` that can no longer be: past their timeout, the kill
     * grace and the link-lost window (spec U2), with no channel on this
     * replica. Whatever replica held them is gone or never heard the end; they
     * end `failed (link-lost)` and the full output stays on the machine.
     */
    private async sweepStale(
        command: FleetCommand,
        runs: FleetCommandRun[],
    ): Promise<FleetCommandRun[]> {
        const now = this.now();
        const deadline =
            command.timeoutSec * 1000 +
            FLEET_COMMAND_KILL_GRACE_MS +
            FLEET_COMMAND_LINK_LOST_GRACE_MS;
        let changed = false;
        for (const run of runs) {
            if (run.status !== 'running') continue;
            const started =
                run.startedAt instanceof Date
                    ? run.startedAt.getTime()
                    : Date.parse(String(run.startedAt));
            if (!Number.isFinite(started) || now - started <= deadline) continue;
            const live = this.live.get(run.id);
            if (live) {
                await this.finish(live, {
                    status: 'failed',
                    failedReason: 'link-lost',
                    exitCode: null,
                    error: null,
                });
                changed = true;
                continue;
            }
            const won = await this.commands.updateRunIfRunning(run.id, {
                status: 'failed',
                failedReason: 'link-lost',
                endedAt: new Date(now),
            });
            changed = changed || won;
        }
        if (!changed) return runs;
        await this.settle(command.id);
        return this.commands.findRuns(command.id);
    }

    // ─── Live output ───────────────────────────────────────────────────────

    private markDirty(live: LiveRun): void {
        live.dirty = true;
        if (live.flushTimer || live.ended) return;
        const wait = Math.max(0, FLUSH_INTERVAL_MS - (this.now() - live.lastFlushAt));
        live.flushTimer = setTimeout(() => {
            live.flushTimer = null;
            live.flushing = this.flush(live).finally(() => {
                live.flushing = null;
            });
        }, wait);
        live.flushTimer.unref?.();
    }

    /** Write the live head and tail (redacted) while the run is still running. */
    private async flush(live: LiveRun): Promise<void> {
        if (live.ended || !live.dirty) return;
        live.dirty = false;
        live.lastFlushAt = this.now();
        const snapshot = live.edges.snapshot();
        try {
            await this.commands.updateRunIfRunning(live.runId, {
                outputHead: redactSecrets(snapshot.head).cleaned,
                outputTail: redactSecrets(snapshot.tail).cleaned,
                truncated: snapshot.truncated,
                capped: live.capped,
                outputBytes: Math.min(MAX_INT, snapshot.bytes),
            });
        } catch (error) {
            this.logger.debug(`command run ${live.runId}: flush failed: ${describe(error)}`);
        }
        if (live.dirty && !live.ended) this.markDirty(live);
    }

    // ─── Internals ─────────────────────────────────────────────────────────

    /** The person's own Command (spec §8b default: each caller sees only the Commands they ran). */
    private async resolve(id: string, actor: FleetCommandActor): Promise<FleetCommand> {
        const command =
            typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)
                ? await this.commands.findCommand(id)
                : null;
        if (!command || command.userId !== actor.userId)
            throw fleetCommandError('not_found', 'no such command');
        return command;
    }

    private async view(command: FleetCommand, runs: FleetCommandRun[]): Promise<FleetCommandView> {
        const names = await this.namesFor(runs.map((run) => run.nodeId));
        return toFleetCommandView(command, runs, names, this.now(), (nodeId) =>
            this.isConnected(nodeId),
        );
    }

    private async namesFor(nodeIds: readonly string[]): Promise<Map<string, string>> {
        const distinct = [...new Set(nodeIds)];
        const rows = await this.nodes.findNamesByIds(distinct);
        return new Map(rows.map((row) => [row.id, row.name]));
    }

    private isConnected(nodeId: string): boolean {
        return this.node?.isConnected(nodeId) ?? false;
    }

    private caller(actor: FleetCommandActor): FleetCommandPortCaller {
        return actor.agentId
            ? { kind: 'agent', agentId: actor.agentId, ownerUserId: actor.userId }
            : { kind: 'user', userId: actor.userId };
    }

    private requireNode(): FleetCommandNodePort {
        if (!this.node)
            throw fleetCommandError('unreachable', 'this deployment does not reach computers');
        return this.node;
    }

    private recentCount(userId: string): number {
        const cutoff = this.now() - RATE_WINDOW_MS;
        const kept = (this.recent.get(userId) ?? []).filter((at) => at > cutoff);
        if (kept.length > 0) this.recent.set(userId, kept);
        else this.recent.delete(userId);
        return kept.length;
    }

    private noteRun(userId: string): void {
        const list = this.recent.get(userId) ?? [];
        list.push(this.now());
        this.recent.set(userId, list);
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
        actor: FleetCommandActor,
        node: Pick<FleetNode, 'id' | 'userId'>,
        commandId: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId: actor.userId,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: {
                family: 'commands',
                target: commandId,
                nodeId: node.id,
                requestedBy: actor.agentId ? `agent:${actor.agentId}` : `user:${actor.userId}`,
                confirmationClass: 'confirm',
                ...details,
            },
        });
    }

    private async recordSystem(
        action: FleetAuditAction,
        node: Pick<FleetNode, 'id' | 'userId'>,
        commandId: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.audit) return;
        await this.audit.tryRecord({
            action,
            actorUserId: null,
            ownerUserId: node.userId,
            nodeId: node.id,
            details: { family: 'commands', target: commandId, nodeId: node.id, ...details },
        });
    }
}

/** A channel close reason as a CONTRACTS §8 code (an unknown one is `internal`). */
function readCloseCode(reason: string): FleetLinkError['code'] {
    switch (reason) {
        case 'consent_missing':
        case 'kill_switch':
        case 'permission_denied':
        case 'unsupported_on_node':
        case 'limit_exceeded':
        case 'operation_failed':
            return reason;
        default:
            return 'internal';
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
