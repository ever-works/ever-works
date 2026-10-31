/**
 * Terminal sessions are OFF unless an operator opts in with
 * `TERMINAL_SESSIONS_ENABLED=true` in the WORKER's environment.
 *
 * A `terminal-session` run spawns an interactive shell inside this worker
 * process (the bundled `pty-local` floor, or a provider that execs here), and
 * the process carries the worker's whole environment — platform credentials
 * included. So whoever owns a run would get a shell next to them. Until the run
 * environment is scrubbed, a session is an explicit operator decision.
 *
 * This is the enforcement point: every producer (the API's `POST …/terminal/start`,
 * run steering, task transitions) ends up dispatching this task, so checking here
 * covers all of them. The API answers the same flag up front so the refusal is
 * immediate rather than a session that never arrives.
 */
export const TERMINAL_SESSIONS_ENABLED_ENV = 'TERMINAL_SESSIONS_ENABLED';

export function terminalSessionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env[TERMINAL_SESSIONS_ENABLED_ENV] ?? '').trim().toLowerCase() === 'true';
}
