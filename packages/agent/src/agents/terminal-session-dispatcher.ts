/**
 * Streaming-terminal — job-runtime dispatch port for the `terminal-session`
 * task.
 *
 * Same posture as `AGENT_TASK_EXECUTE_DISPATCHER` /
 * `AGENT_CHAT_REPLY_DISPATCHER` (see `tasks-domain/task-dispatcher.ts`):
 * the agent package declares the contract, the platform's Trigger.dev
 * wrapper supplies the real adapter, and unit tests stub a synchronous
 * one — so `@trigger.dev/sdk` never enters this package's dependency
 * graph. Consumers inject it `@Optional()`: with the token unbound (CLI,
 * tests, an install without a job runtime) starting a session is a
 * reported no-op rather than a crash.
 */

export interface TerminalSessionDispatchPayload {
    /** The AgentRun whose id doubles as the relay channel id. */
    runId: string;
    userId: string;
    agentId: string;
    /** Argv to exec in the worker. Resolved server-side, never by the caller. */
    command: string[];
    cwd: string;
    /** Extra env for the child. NEVER credentials — those resolve job-side. */
    env?: Record<string, string>;
    persistent?: boolean;
    /**
     * The `terminal-stream` provider the facade resolved for this scope,
     * forwarded to the worker as its `providerOverride` so both sides
     * host the SAME provider. Absent when no provider resolved — the
     * worker then resolves (or falls back) on its own.
     */
    providerId?: string;
    /** Work scope, when the run has one — feeds the facade's settings hierarchy. */
    workId?: string;
}

export interface TerminalSessionDispatcher {
    /** Enqueue the session task; resolves with the job-runtime's own run id. */
    enqueue(payload: TerminalSessionDispatchPayload): Promise<{ jobRunId: string }>;
}

export const TERMINAL_SESSION_DISPATCHER = 'TERMINAL_SESSION_DISPATCHER' as const;

/**
 * Operator override for the session argv. The worker image is Linux, so the
 * default is a Linux login shell — this is NOT resolved from the API host's
 * `process.platform`, which would be the wrong machine's answer.
 */
export const TERMINAL_SESSION_COMMAND_ENV = 'TERMINAL_SESSION_COMMAND';

export const TERMINAL_SESSION_COMMAND_DEFAULT: readonly string[] = ['/bin/bash', '-i'];

/** Hard cap on a configured argv — a misconfiguration must not become a payload bomb. */
const MAX_ARGV = 32;

/**
 * Resolve the argv a terminal session execs.
 *
 * Deliberately NOT caller-supplied: `POST …/terminal/start` is an
 * authenticated user action, but accepting arbitrary argv over the API
 * would turn the terminal affordance into a general remote-exec endpoint.
 * The command is operator configuration (`TERMINAL_SESSION_COMMAND`, a
 * JSON array or a whitespace-separated string) with a Linux shell default.
 * Anything unparseable falls back to the default rather than throwing —
 * a typo in an env var must not make the feature un-startable.
 */
export function resolveTerminalSessionCommand(raw?: string | null): string[] {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length === 0) return [...TERMINAL_SESSION_COMMAND_DEFAULT];

    let parts: string[] = [];
    if (value.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(value);
            if (Array.isArray(parsed)) {
                parts = parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
            }
        } catch {
            parts = [];
        }
    } else {
        parts = value.split(/\s+/).filter((p) => p.length > 0);
    }

    if (parts.length === 0) return [...TERMINAL_SESSION_COMMAND_DEFAULT];
    return parts.slice(0, MAX_ARGV);
}
