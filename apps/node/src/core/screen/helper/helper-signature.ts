import { posix as posixPath, win32 as windowsPath } from 'node:path';
import type { FleetHelperManifest } from '@ever-works/contracts';
import { fleetHelperTarget } from '@ever-works/contracts';
import type { CommandRunner } from '../../capabilities';

/**
 * Desktop view & control (FL-07 P3, T-43, FR-57, FR-58) — the screen helper's
 * code signature, as the operating system judges it. Acceptance is ONE
 * operating-system verdict, never text this code parses:
 *
 *   - **macOS**: `codesign --verify --strict -R=<requirement>` must exit 0 for
 *     the Developer ID requirement of the published Team ID — anchored at
 *     Apple's root, a Developer ID intermediate and leaf, and the leaf's
 *     organisational unit equal to the Team ID. An ad-hoc or self-signed
 *     signature, or a Developer ID of another team, fails it whatever the file
 *     says about itself. A second, requirement-free `--verify` only names WHY
 *     it failed (unsigned, broken, or signed by someone else);
 *   - **Windows**: `Get-AuthenticodeSignature` must answer `Valid`, the chain's
 *     root must be in the MACHINE's trusted roots (`LocalMachine\Root` or
 *     `AuthRoot`, never a root the user's own store added), and the signer
 *     certificate's subject must be the one the node package publishes;
 *   - **Linux**: there is no signed level — a helper there is always
 *     hash-pinned.
 *
 * The tools are never looked up on `PATH`: `/usr/bin/codesign` by its system
 * path, and `powershell` by its bare name, which the node's command runner
 * pins to `%SystemRoot%\System32\WindowsPowerShell\v1.0` without a shell. The
 * file path must be absolute; `codesign` gets it as ONE argument after `--`,
 * PowerShell as a single-quoted literal inside an encoded command (see
 * {@link authenticodeCommand}) — a path with a control character or a
 * typographic single quote is refused before anything runs. Every failure is
 * a reason, never a throw. What a signed helper buys is that an update signed
 * by the same identity keeps its approval and its macOS permissions (FR-58),
 * which a hash-pinned one cannot.
 */

export type HelperSignatureCheck =
	| { ok: true; signer: string }
	| {
			ok: false;
			reason: 'unsupported' | 'unsigned' | 'invalid' | 'wrong-signer' | 'tool-missing';
			detail?: string;
	  };

/** macOS's signature tool, by its system path. */
export const CODESIGN_PATH = '/usr/bin/codesign';

/** Windows PowerShell, by the bare name the node's command runner pins to `System32` (no shell, no `PATH`). */
export const WINDOWS_POWERSHELL = 'powershell';

/** How long one signature tool may take. */
export const HELPER_SIGNATURE_TIMEOUT_MS = 15_000;

/** An Apple Team ID: ten upper-case letters and digits. */
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/;

/**
 * The code requirement a Developer ID-signed helper of `teamId` satisfies:
 * Apple's anchor, the Developer ID intermediate (`1.2.840.113635.100.6.2.6`),
 * a Developer ID Application leaf (`1.2.840.113635.100.6.1.13`) and the leaf's
 * OU equal to the Team ID. Null for a Team ID that is not one (nothing else
 * may reach the requirement language).
 */
export function developerIdRequirement(teamId: string): string | null {
	if (!APPLE_TEAM_ID.test(teamId)) return null;
	return (
		'anchor apple generic' +
		' and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
		' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' +
		` and certificate leaf[subject.OU] = "${teamId}"`
	);
}

/** `Valid|1|CN=Ever Co., O=…` → the status, whether the root is a machine root, and the signer subject. */
export function parseAuthenticodeLine(
	output: string
): { status: string; machineRoot: boolean; subject: string } | null {
	const line = output.split(/\r?\n/).find((entry) => entry.includes('|'));
	if (!line) return null;
	const first = line.indexOf('|');
	const second = line.indexOf('|', first + 1);
	if (second < 0) return null;
	const status = line.slice(0, first).trim();
	const machine = line.slice(first + 1, second).trim();
	const subject = line.slice(second + 1).trim();
	return status ? { status, machineRoot: machine === '1', subject } : null;
}

/** Characters a path handed to a signature tool may not carry: controls, and the single quotes PowerShell also honours. */
const UNSAFE_PATH = /[\u0000-\u001f\u007f\u2018\u2019\u201a\u201b]/;

/** True when `path` may be handed to the signature tool of `platform`. */
export function isCheckablePath(platform: string, path: string): boolean {
	if (!path || UNSAFE_PATH.test(path)) return false;
	return platform === 'win32' ? windowsPath.isAbsolute(path) : posixPath.isAbsolute(path);
}

/**
 * The PowerShell program that reads the signature of `path`, as an
 * `-EncodedCommand` (UTF-16LE, base64): the path is a single-quoted literal
 * with every `'` doubled (paths with the typographic single quotes PowerShell
 * also honours never get here — {@link isCheckablePath}), so nothing in it can
 * run. It prints `<status>|<1 when the chain's root is a machine root>|<subject>`.
 */
export function authenticodeCommand(path: string): string {
	const literal = `'${path.replace(/'/g, "''")}'`;
	const script = [
		`$s = Get-AuthenticodeSignature -LiteralPath ${literal}`,
		"$root = ''",
		'if ($s.SignerCertificate) {',
		'  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain',
		"  $chain.ChainPolicy.RevocationMode = 'NoCheck'",
		'  [void]$chain.Build($s.SignerCertificate)',
		'  if ($chain.ChainElements.Count -gt 0) { $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint }',
		'}',
		"$machine = '0'",
		"if ($root -and ((Test-Path -LiteralPath ('Cert:\\LocalMachine\\Root\\' + $root)) -or (Test-Path -LiteralPath ('Cert:\\LocalMachine\\AuthRoot\\' + $root)))) { $machine = '1' }",
		"$subject = ''",
		'if ($s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }',
		"[Console]::Out.Write($s.Status.ToString() + '|' + $machine + '|' + $subject)"
	].join('; ');
	return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Check the helper's signature against the identity the node package
 * publishes (`expected`: a Team ID on macOS, a certificate subject on
 * Windows). Never throws.
 */
export async function checkHelperSignature(
	runner: CommandRunner,
	platform: string,
	path: string,
	expected: string
): Promise<HelperSignatureCheck> {
	try {
		if (platform !== 'darwin' && platform !== 'win32') return { ok: false, reason: 'unsupported' };
		if (!isCheckablePath(platform, path)) return { ok: false, reason: 'invalid', detail: 'path' };
		if (platform === 'darwin') {
			const requirement = developerIdRequirement(expected);
			if (!requirement) return { ok: false, reason: 'invalid', detail: 'signer' };
			const verdict = await runner.run(CODESIGN_PATH, ['--verify', '--strict', `-R=${requirement}`, '--', path], {
				timeoutMs: HELPER_SIGNATURE_TIMEOUT_MS
			});
			if (verdict.spawnError === 'ENOENT') return { ok: false, reason: 'tool-missing', detail: 'codesign' };
			if (verdict.code === 0 && !verdict.timedOut) return { ok: true, signer: expected };
			// Refused: say why — an intact signature that is not the team's Developer ID is someone else's.
			const intact = await runner.run(CODESIGN_PATH, ['--verify', '--strict', '--', path], {
				timeoutMs: HELPER_SIGNATURE_TIMEOUT_MS
			});
			if (intact.spawnError === 'ENOENT') return { ok: false, reason: 'tool-missing', detail: 'codesign' };
			if (intact.code === 0) return { ok: false, reason: 'wrong-signer' };
			const text = `${intact.stderr}\n${intact.stdout}`;
			return /not signed/i.test(text) ? { ok: false, reason: 'unsigned' } : { ok: false, reason: 'invalid' };
		}
		const result = await runner.run(
			WINDOWS_POWERSHELL,
			['-NoProfile', '-NonInteractive', '-EncodedCommand', authenticodeCommand(path)],
			{ timeoutMs: HELPER_SIGNATURE_TIMEOUT_MS }
		);
		if (result.spawnError === 'ENOENT') return { ok: false, reason: 'tool-missing', detail: 'powershell' };
		if (result.timedOut) return { ok: false, reason: 'invalid', detail: 'timeout' };
		const read = parseAuthenticodeLine(result.stdout);
		if (!read) return { ok: false, reason: 'invalid' };
		if (read.status === 'NotSigned') return { ok: false, reason: 'unsigned' };
		if (read.status !== 'Valid') return { ok: false, reason: 'invalid', detail: read.status.slice(0, 40) };
		if (!read.machineRoot) return { ok: false, reason: 'invalid', detail: 'user-root' };
		return read.subject === expected ? { ok: true, signer: read.subject } : { ok: false, reason: 'wrong-signer' };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}

/**
 * The signature checker the node runs with: {@link checkHelperSignature}
 * bound to its runner — and to the signer THIS node version publishes for the
 * machine. A record whose signer is not that one (a release rotated or dropped
 * it) is refused before any tool runs, so withdrawing a signer withdraws its
 * approvals. Undefined where the OS has no signed level.
 */
export function nodeHelperSignatureChecker(
	runner: CommandRunner,
	platform: string,
	arch: string,
	manifest: FleetHelperManifest
): ((path: string, expectedSigner: string) => Promise<HelperSignatureCheck>) | undefined {
	if (platform !== 'darwin' && platform !== 'win32') return undefined;
	const target = fleetHelperTarget(platform, arch);
	const published = target ? manifest.targets[target]?.signer : undefined;
	return async (path, expectedSigner) => {
		if (!published || expectedSigner !== published) {
			return { ok: false, reason: 'wrong-signer', detail: 'not-published' };
		}
		return checkHelperSignature(runner, platform, path, expectedSigner);
	};
}
