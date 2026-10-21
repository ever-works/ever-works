import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Sessions on computers (FL-04) — the token that guards the daemon's local
 * socket (spec FR-3, CONTRACTS R-26).
 *
 * 32 random bytes, base64url, in `<state dir>/daemon.token`, created
 * exclusively (two node processes starting at once agree on one token) with
 * mode 0600 inside a 0700 directory, plus an owner-only ACL on Windows where
 * mode bits mean nothing. It never leaves the machine and is never logged:
 * the node and the daemon both read it from the file.
 */

export interface DaemonTokenOptions {
	tokenFile: string;
	/** Owner-only ACL for the file (Windows `icacls`). A failure is reported, the token still used. */
	restrictFile?: (file: string) => Promise<void> | void;
	warn?: (message: string) => void;
}

const MIN_TOKEN_LENGTH = 32;

async function readToken(file: string): Promise<string | null> {
	try {
		const raw = (await fsp.readFile(file, 'utf8')).trim();
		return raw.length >= MIN_TOKEN_LENGTH ? raw : null;
	} catch {
		return null;
	}
}

/** Read the token, creating it first when it does not exist (or is unusable). */
export async function ensureDaemonToken(options: DaemonTokenOptions): Promise<string> {
	const existing = await readToken(options.tokenFile);
	if (existing) return existing;
	await fsp.mkdir(path.dirname(options.tokenFile), { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString('base64url');
	try {
		await fsp.writeFile(options.tokenFile, `${token}\n`, {
			encoding: 'utf8',
			mode: 0o600,
			flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		// Another process created it first; an unusable file is replaced.
		const raced = await readToken(options.tokenFile);
		if (raced) return raced;
		await fsp.writeFile(options.tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
	}
	if (options.restrictFile) {
		try {
			await options.restrictFile(options.tokenFile);
		} catch (error) {
			options.warn?.(
				`Could not apply an owner-only ACL to the session daemon token: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
	return (await readToken(options.tokenFile)) ?? token;
}
