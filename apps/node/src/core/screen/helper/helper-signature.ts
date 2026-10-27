import type { CommandRunner } from '../../capabilities';

/**
 * Desktop view & control (FL-07 P3, T-43, FR-57, FR-58) — the screen helper's
 * code signature, as the operating system reads it.
 *
 *   - **macOS**: `codesign --verify --strict` must pass (an intact signature
 *     whose chain the system trusts), and `codesign --display --verbose=2` must
 *     name an `Authority=Developer ID Application: …` and the `TeamIdentifier`
 *     the node package publishes;
 *   - **Windows**: `Get-AuthenticodeSignature` must answer `Valid`, and the
 *     signer certificate's subject must be the one the node package publishes;
 *   - **Linux**: there is no signed level — a helper there is always
 *     hash-pinned.
 *
 * `codesign` is handed the file path as ONE argument — never a shell string;
 * PowerShell gets it as a quoted literal inside an encoded command (see
 * {@link authenticodeCommand}). Every failure is a reason,
 * never a throw. The signer identity is compared exactly; what a signed
 * helper buys is that an update signed by the same identity keeps its
 * approval and its macOS permissions (FR-58), which a hash-pinned one cannot.
 */

export type HelperSignatureCheck =
	| { ok: true; signer: string }
	| { ok: false; reason: 'unsupported' | 'unsigned' | 'invalid' | 'wrong-signer' | 'tool-missing'; detail?: string };

/** How long one signature tool may take. */
export const HELPER_SIGNATURE_TIMEOUT_MS = 15_000;

/** The Team ID macOS printed (`TeamIdentifier=ABCDE12345`), or null. */
export function parseCodesignTeamId(output: string): string | null {
	const match = /^TeamIdentifier=([A-Z0-9]{10})\s*$/m.exec(output);
	return match ? match[1] : null;
}

/** True when macOS says the signing authority is a Developer ID Application. */
export function codesignIsDeveloperId(output: string): boolean {
	return /^Authority=Developer ID Application: /m.test(output);
}

/** `Valid|CN=Ever Co., O=…` → the status and the signer subject. */
export function parseAuthenticodeLine(output: string): { status: string; subject: string } | null {
	const line = output.split(/\r?\n/).find((entry) => entry.includes('|'));
	if (!line) return null;
	const index = line.indexOf('|');
	const status = line.slice(0, index).trim();
	const subject = line.slice(index + 1).trim();
	return status ? { status, subject } : null;
}

/**
 * The PowerShell program that reads the signature of `path`, as an
 * `-EncodedCommand` (UTF-16LE, base64): the path is a single-quoted literal
 * with every `'` doubled — the only character a single-quoted PowerShell
 * string treats specially — so nothing in it can run.
 */
export function authenticodeCommand(path: string): string {
	const literal = `'${path.replace(/'/g, "''")}'`;
	const script =
		`$s = Get-AuthenticodeSignature -LiteralPath ${literal}; ` +
		"[Console]::Out.Write($s.Status.ToString() + '|' + $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }))";
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
		if (platform === 'darwin') {
			const verify = await runner.run('codesign', ['--verify', '--strict', path], {
				timeoutMs: HELPER_SIGNATURE_TIMEOUT_MS
			});
			if (verify.spawnError === 'ENOENT') return { ok: false, reason: 'tool-missing', detail: 'codesign' };
			if (verify.code !== 0) {
				const text = `${verify.stderr}\n${verify.stdout}`;
				return /not signed/i.test(text) ? { ok: false, reason: 'unsigned' } : { ok: false, reason: 'invalid' };
			}
			// `--display` writes what it found to stderr.
			const display = await runner.run('codesign', ['--display', '--verbose=2', path], {
				timeoutMs: HELPER_SIGNATURE_TIMEOUT_MS
			});
			const text = `${display.stderr}\n${display.stdout}`;
			const teamId = parseCodesignTeamId(text);
			if (!teamId || !codesignIsDeveloperId(text)) return { ok: false, reason: 'invalid' };
			return teamId === expected ? { ok: true, signer: teamId } : { ok: false, reason: 'wrong-signer' };
		}
		if (platform === 'win32') {
			const result = await runner.run(
				'powershell.exe',
				['-NoProfile', '-NonInteractive', '-EncodedCommand', authenticodeCommand(path)],
				{ timeoutMs: HELPER_SIGNATURE_TIMEOUT_MS }
			);
			if (result.spawnError === 'ENOENT') return { ok: false, reason: 'tool-missing', detail: 'powershell' };
			const read = parseAuthenticodeLine(result.stdout);
			if (!read) return { ok: false, reason: 'invalid' };
			if (read.status === 'NotSigned') return { ok: false, reason: 'unsigned' };
			if (read.status !== 'Valid') return { ok: false, reason: 'invalid', detail: read.status.slice(0, 40) };
			return read.subject === expected ? { ok: true, signer: read.subject } : { ok: false, reason: 'wrong-signer' };
		}
		return { ok: false, reason: 'unsupported' };
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}
