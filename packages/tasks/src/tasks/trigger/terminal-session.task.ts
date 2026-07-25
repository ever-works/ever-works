import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { AgentRunRepository } from '@ever-works/agent/database';
import { PtyLocalPlugin } from '@ever-works/pty-local-plugin';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';
import { TerminalTransportClient } from '../../trigger/worker/services/terminal-transport.client';
import { TerminalSessionHost } from '../../trigger/worker/services/terminal-session-host';

export interface TerminalSessionPayload {
    /** The AgentRun whose id doubles as the relay channel id. */
    runId: string;
    userId: string;
    agentId: string;
    /** Argv to exec. Absolute path preferred (bundled-worker PATHs). */
    command: string[];
    cwd: string;
    /** Extra env for the child. NEVER credentials — those are resolved
     *  job-side by the facades at spawn time (see plan §7). */
    env?: Record<string, string>;
    persistent?: boolean;
}

/**
 * Streaming-terminal M6 — the durable session task.
 *
 * Hosts one live terminal session for an AgentRun: PTY (or pipe floor)
 * in THIS worker process, bytes relayed through the API gateway, kept
 * alive by heartbeats, reaped by the sweeper on heartbeat loss.
 *
 * This is the building block the run orchestration composes: today it
 * is dispatched explicitly (persistent/interactive runs); the
 * agent-task-execute integration (routing a CLI pipeline's execution
 * through a session instead of captured output) is the follow-up
 * milestone — kept out of this task deliberately so the existing
 * one-shot path carries zero regression risk.
 *
 * maxDuration 3600 is the hard cost backstop until park/resume lands
 * for long-lived sessions (state-aware policy, orchestration wave).
 */
export const terminalSessionTask = task<'terminal-session', TerminalSessionPayload>({
    id: 'terminal-session',
    maxDuration: 3600,
    run: async (payload: TerminalSessionPayload) => {
        assertUuid(payload.runId, 'payload.runId');
        assertUuid(payload.userId, 'payload.userId');
        assertUuid(payload.agentId, 'payload.agentId');
        if (!Array.isArray(payload.command) || payload.command.length === 0) {
            return { status: 'skipped' as const, reason: 'empty-command' };
        }

        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('TerminalSession'));
        try {
            // Ownership guard mirroring agent-task-execute: the run must
            // belong to the payload's user + agent; forged payloads skip
            // without leaking existence.
            const runs = appContext.get(AgentRunRepository);
            const run = await runs.findById(payload.runId);
            if (!run || run.userId !== payload.userId || run.agentId !== payload.agentId) {
                return { status: 'skipped' as const, reason: 'run-not-found' };
            }

            const client = new TerminalTransportClient();
            const host = new TerminalSessionHost(new PtyLocalPlugin(), client);

            const outcome = await host.run({
                runId: payload.runId,
                command: payload.command,
                cwd: payload.cwd,
                env: payload.env ?? {},
                persistent: payload.persistent === true,
                // Cost guard default: a session nobody can reach anymore
                // does not burn compute. The state-aware park policy
                // (orchestration wave) refines this per busy/needsInput.
                endOnInputClose: false,
            });

            return { status: 'completed' as const, ...outcome };
        } finally {
            await appContext.close();
        }
    },
});
