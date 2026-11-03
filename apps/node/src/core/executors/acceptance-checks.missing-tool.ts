/**
 * APW-08 T51 (FR-61, S36, ACC-08-44) — a check whose TOOL is missing on this machine.
 *
 * The node runs every check with `spawn(command, { shell: true })`, so a command that does not
 * exist never fails to spawn: the shell starts, looks the program up, fails, and exits with its
 * "command not found" code — `127` from a POSIX shell, `9009` from `cmd.exe` on Windows. Without
 * this classification that is an ordinary red exit, indistinguishable from a failing test, and
 * FR-61's `error` state ("a tool this check needs is missing on this machine") is unreachable.
 *
 * Both codes are classified on every platform: a node's shell is whatever `spawn` resolves, and
 * neither code is one a real check uses to say "the code is wrong". The result is `error` with
 * the reason below — the gate treats it exactly like any other non-green required check — and the
 * platform reads the reason to keep this machine from being offered the same Task again.
 */

/** The shells' "command not found" exit codes: POSIX `sh`/`bash` (127) and Windows `cmd.exe` (9009). */
export const MISSING_TOOL_EXIT_CODES: readonly number[] = [127, 9009];

/** The `reason` a missing-tool check result carries (`appRules.missingTool` in the web copy). */
export const MISSING_TOOL_REASON = 'missingTool' as const;
export type MissingToolReason = typeof MISSING_TOOL_REASON;

/** Is this exit code a shell's "command not found"? `null` (a signal) never is. */
export function isMissingToolExit(code: number | null | undefined): boolean {
	return typeof code === 'number' && MISSING_TOOL_EXIT_CODES.includes(code);
}
