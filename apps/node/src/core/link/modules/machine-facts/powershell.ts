/**
 * Machine facts (FL-09) — PowerShell without a shell string.
 *
 * Every Windows act runs as `powershell -NoProfile -NonInteractive
 * -EncodedCommand <base64>`: the script travels as one base64 argument, so
 * neither `cmd.exe` nor PowerShell's own argument parser ever sees a name.
 * Inside the script a name is a single-quoted PowerShell literal, and only a
 * name that already matched a strict pattern (no quote, no `$(`, no
 * backtick, no newline) is ever put there — {@link psLiteral} refuses
 * anything else, as a second fence.
 */

/** `-EncodedCommand` takes the script as base64 of its UTF-16LE bytes. */
export function encodePowerShell(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64');
}

/** The argv of one encoded PowerShell run. */
export function powerShellArgs(script: string): string[] {
	return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)];
}

/** The executable: Windows PowerShell 5.1, always present on Windows 10/11. */
export const POWERSHELL = 'powershell';

/** A single-quoted PowerShell literal of an already-validated name. Throws on anything a literal cannot safely hold. */
export function psLiteral(value: string): string {
	if (!/^[A-Za-z0-9@._:+$ -]{1,256}$/.test(value)) {
		throw new Error('refusing to put an unvalidated value into a PowerShell script');
	}
	return `'${value}'`;
}

/**
 * The script run for a JSON answer: errors stop it, progress noise is off,
 * and the result is ONE compressed JSON document on stdout (an array stays an
 * array even with one element).
 */
export function jsonScript(body: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
		body
	].join('\n');
}

/** Parse a PowerShell `ConvertTo-Json` answer that should be a list (one object comes back bare). */
export function parseJsonList(stdout: string): Record<string, unknown>[] {
	const text = stdout.trim();
	if (!text) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (Array.isArray(parsed)) {
		return parsed.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
	}
	return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : [];
}

/** The admin probe (spec U9): True when this process runs elevated. */
export const IS_ADMIN_SCRIPT =
	'([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
