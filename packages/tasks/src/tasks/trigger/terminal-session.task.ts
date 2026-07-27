import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AgentRunRepository } from '@ever-works/agent/database';
import { TerminalStreamFacadeService } from '@ever-works/agent/facades';
import { PtyLocalPlugin } from '@ever-works/pty-local-plugin';
import { TriggerTerminalModule } from '../../trigger/worker/modules/trigger-terminal.module';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';
import { TerminalTransportClient } from '../../trigger/worker/services/terminal-transport.client';
import { TerminalSessionHost } from '../../trigger/worker/services/terminal-session-host';
import { resolveTerminalSessionSpawner } from '../../trigger/worker/services/terminal-provider.resolver';

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
    /**
     * `terminal-stream` provider the API's facade resolved for this
     * scope, forwarded as the worker facade's `providerOverride` so both
     * processes agree on WHICH provider hosts the session. Absent = let
     * the worker resolve it itself.
     */
    providerId?: string;
    /** Work scope for the facade's settings hierarchy, when the run has one. */
    workId?: string;
}

/**
 * Streaming-terminal M6 — the durable session task.
 *
 * Hosts one live terminal session for an AgentRun: PTY (or pipe floor)
 * in THIS worker process, bytes relayed through the API gateway, kept
 * alive by heartbeats, reaped by the sweeper on heartbeat loss.
 *
 * The provider is resolved through `TerminalStreamFacadeService` rather
 * than imported: this task used to construct the `pty-local` plugin
 * directly, which left the capability seam with no consumer at all. The
 * bundled plugin is now only the FLOOR — used when the facade resolves
 * nothing (no enabled provider, hydration failure), so an install that
 * enables a different `terminal-stream` provider actually gets it.
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

        const appContext = await NestFactory.createApplicationContext(TriggerTerminalModule);
        appContext.useLogger(createTriggerLogger('TerminalSession'));
        const logger = new Logger('TerminalSession');
        try {
            // Ownership guard mirroring agent-task-execute: the run must
            // belong to the payload's user + agent; forged payloads skip
            // without leaking existence.
            const runs = appContext.get(AgentRunRepository);
            const run = await runs.findById(payload.runId);
            if (!run || run.userId !== payload.userId || run.agentId !== payload.agentId) {
                return { status: 'skipped' as const, reason: 'run-not-found' };
            }

            // Plugin hydration is what gives the facade a registry to
            // resolve against. Best-effort by design: a hydration failure
            // degrades to the bundled provider below instead of denying
            // the user a terminal.
            try {
                await appContext.get(TriggerPluginHydratorService).initialize();
            } catch (error) {
                logger.warn(
                    `Plugin hydration failed; terminal falls back to the bundled provider: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }

            const client = new TerminalTransportClient();
            // `.get` THROWS for an unbound token — a context assembled
            // without the facade must degrade, not crash the session.
            let facade: TerminalStreamFacadeService | null = null;
            try {
                facade = appContext.get(TerminalStreamFacadeService, { strict: false });
            } catch {
                facade = null;
            }

            const { spawner, source, degradedReason } = await resolveTerminalSessionSpawner({
                facade,
                facadeOptions: {
                    userId: payload.userId,
                    workId: payload.workId,
                    providerOverride: payload.providerId,
                    agentId: payload.agentId,
                },
                bundledFallback: () => new PtyLocalPlugin(),
            });
            if (source === 'bundled' && degradedReason) {
                logger.warn(`terminal-stream facade did not resolve a provider: ${degradedReason}`);
            }
            const host = new TerminalSessionHost(spawner, client);

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
