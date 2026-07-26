import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import {
    TERMINAL_SESSION_COMMAND_ENV,
    TERMINAL_SESSION_DISPATCHER,
    resolveTerminalSessionCommand,
    type TerminalSessionDispatcher,
} from './terminal-session-dispatcher';

/**
 * Streaming-terminal — the ONE place a `terminal-session` job is started.
 *
 * Before this existed the task had no dispatcher at all: the gateway, the
 * relay registry, the attach tokens, the plugin and the web pane were all
 * wired to a session that nothing ever launched. Every caller now funnels
 * through here so the ownership check, the duplicate refusal and the
 * persistent gate are stated once:
 *
 *  - **Ownership** — the run must belong to `(userId, agentId)`. A
 *    mismatch reports `run-not-found` with no existence leak, mirroring
 *    `AgentRunRepository.findByIdAndUser` posture everywhere else.
 *  - **Duplicate refusal** — the terminal slot is CAS-claimed
 *    (`casClaimTerminalSession`), so concurrent starts resolve to exactly
 *    one dispatch and the losers report `session-already-live`.
 *  - **Persistent gate** — `requirePersistent` is what the automatic
 *    dispatch path (task fan-out) passes: a run that never asked for a
 *    long-lived interactive session must not spawn one, and must not pay
 *    for a worker that sits on a shell nobody opened.
 *
 * Never throws for a refusal — refusals are values, so the automatic
 * caller can ignore them and the HTTP caller can map them to statuses.
 * A dispatcher that throws DOES bubble (after releasing the claim): the
 * user pressed a button and deserves the real error.
 */

export type TerminalSessionRefusal =
    | 'run-not-found'
    | 'not-persistent'
    | 'run-not-live'
    | 'session-already-live'
    | 'dispatcher-unavailable';

export type StartTerminalSessionOutcome =
    | { started: true; runId: string; jobRunId: string }
    | { started: false; reason: TerminalSessionRefusal };

export interface StartTerminalSessionInput {
    userId: string;
    agentId: string;
    runId: string;
    /**
     * Start ONLY when the run is already flagged persistent. The automatic
     * dispatch path passes this; the explicit user action does not.
     */
    requirePersistent?: boolean;
    /**
     * Flag the run persistent as part of starting. The explicit
     * `POST …/terminal/start` passes this — asking for a terminal on a run
     * IS the statement that the run wants a long-lived session.
     */
    markPersistent?: boolean;
}

/** Statuses a run may still be dispatched a live terminal for. */
const LIVE_RUN_STATUSES = new Set(['queued', 'running']);

/** Terminal lifecycle states that mean "a session is already resident". */
const LIVE_TERMINAL_STATES = new Set(['starting', 'attached']);

@Injectable()
export class TerminalSessionLauncher {
    private readonly logger = new Logger(TerminalSessionLauncher.name);

    constructor(
        private readonly runs: AgentRunRepository,
        @Optional()
        @Inject(TERMINAL_SESSION_DISPATCHER)
        private readonly dispatcher?: TerminalSessionDispatcher,
    ) {}

    /** Whether a job runtime is wired at all (drives the 503 vs 409 split). */
    isAvailable(): boolean {
        return Boolean(this.dispatcher);
    }

    async startForRun(input: StartTerminalSessionInput): Promise<StartTerminalSessionOutcome> {
        const run = await this.runs.findByIdAndUser(input.runId, input.userId);
        if (!run || run.agentId !== input.agentId) {
            return { started: false, reason: 'run-not-found' };
        }

        if (input.requirePersistent === true && run.persistent !== true) {
            return { started: false, reason: 'not-persistent' };
        }

        // A finished run has no worker, no workspace and nothing to drive —
        // spawning a shell "for" it would be a session pointing at a cwd
        // that no longer exists. Refuse honestly instead.
        if (!LIVE_RUN_STATUSES.has(run.status)) {
            return { started: false, reason: 'run-not-live' };
        }

        // Cheap pre-check so the common duplicate never even touches the
        // dispatcher; the CAS below is what actually makes it safe.
        if (run.terminalState && LIVE_TERMINAL_STATES.has(run.terminalState)) {
            return { started: false, reason: 'session-already-live' };
        }

        if (!this.dispatcher) {
            return { started: false, reason: 'dispatcher-unavailable' };
        }

        const claimed = await this.runs.casClaimTerminalSession(input.runId, {
            persistent: input.markPersistent === true ? true : undefined,
        });
        if (!claimed) {
            return { started: false, reason: 'session-already-live' };
        }

        const command = resolveTerminalSessionCommand(process.env[TERMINAL_SESSION_COMMAND_ENV]);
        // The isolated worktree when the run has one (Wave 2 M3), else the
        // worker's own cwd — `.` resolves job-side, which is the only
        // machine that can answer that question.
        const cwd = run.workspaceMeta?.path ?? '.';

        try {
            const { jobRunId } = await this.dispatcher.enqueue({
                runId: run.id,
                userId: input.userId,
                agentId: run.agentId,
                command,
                cwd,
                persistent: input.markPersistent === true || run.persistent === true,
            });
            return { started: true, runId: run.id, jobRunId };
        } catch (error) {
            // The claim outlived its session — hand the slot back so the
            // next start is not refused by a session that never existed.
            await this.runs
                .releaseTerminalSessionClaim(run.id, 'crashed')
                .catch((releaseErr) =>
                    this.logger.warn(
                        `Failed to release terminal claim on AgentRun ${run.id}: ${releaseErr}`,
                    ),
                );
            throw error;
        }
    }
}
