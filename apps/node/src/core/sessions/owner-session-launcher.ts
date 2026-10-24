import { existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	fleetConsentMissingHint,
	FLEET_SESSION_PROVIDER_CAPABILITY,
	type FleetConsents,
	type FleetLinkErrorCode,
	type FleetSessionStartableProvider
} from '@ever-works/contracts';
import type { ModelCliPaths } from '../executors/model-cli';
import type { HookOverlayPort } from './hook-overlay.port';

/**
 * Sessions on computers (FL-04) — what an OWNER session runs (spec FR-12 …
 * FR-15, FR-17, U1, U17, U18; README D14).
 *
 * An owner session is the person using their own machine through Ever
 * Works: it runs as them, in their login shell, with THEIR CLI
 * configuration, MCP servers and memory — exactly as if they sat at the
 * keyboard. So this composes almost nothing:
 *
 *  - **shell** — the login shell: `$SHELL -l` (falling back to `/bin/zsh -l`
 *    on macOS, `/bin/sh -l` elsewhere); on Windows PowerShell 7 (`pwsh`) when
 *    it is on PATH, else Windows PowerShell (OWNER-QUESTIONS B3 default);
 *  - **claude-code / codex** — the CLI the node already resolved (the path
 *    the `claude-code` / `codex` tag stands on), interactive (no `-p`, no
 *    output format), with the FL-05 hook overlay's arguments and the first
 *    message as its first prompt;
 *  - **environment** — the node process's own, which IS the person's, plus
 *    only what the overlay adds (the daemon adds the terminal variables).
 *
 * Refusals (typed, with the hint a person acts on): no `--manage` →
 * `consent_missing`; a CLI this machine does not have → `unsupported_on_node`;
 * a folder that does not exist, or one outside the person's home and the
 * extra roots the machine's owner listed → `invalid`, naming the path.
 *
 * On Windows a CLI installed as a `.cmd`/`.bat` shim runs through
 * `cmd.exe`, which would re-parse a first message's `&`, `|`, `^`, `%` — so
 * there the first message is typed into the session once it started
 * (`typeAfterStart`) instead of being put on the command line.
 */

export interface OwnerSessionLaunchInput {
	sessionId: string;
	provider: FleetSessionStartableProvider;
	cwd: string;
	firstMessage?: string;
	consents: FleetConsents;
	nodeName: string;
	platform: string;
	env: Record<string, string | undefined>;
	homedir: string;
	modelCli: ModelCliPaths;
	/** Extra folders the machine's owner allows sessions in (besides home). */
	extraRoots?: readonly string[];
	overlay: HookOverlayPort;
	/** Test seams. */
	realpath?: (target: string) => Promise<string>;
	fileExists?: (target: string) => boolean;
}

export interface OwnerSessionLaunch {
	command: string[];
	cwd: string;
	env: Record<string, string>;
	/** Text to type into the session after it started (Windows `.cmd` CLIs). */
	typeAfterStart?: string;
}

export type OwnerSessionLaunchResult =
	| { ok: true; launch: OwnerSessionLaunch }
	| { ok: false; error: { code: FleetLinkErrorCode; hint: string } };

const PROVIDER_LABEL: Record<FleetSessionStartableProvider, string> = {
	shell: 'A shell',
	'claude-code': 'Claude Code',
	codex: 'Codex'
};

/** `~`, `~/x` and `~\x` are the home folder. */
export function expandHome(target: string, homedir: string, platform: string = process.platform): string {
	if (target === '~') return homedir;
	if (target.startsWith('~/') || target.startsWith('~\\')) {
		return (platform === 'win32' ? path.win32 : path.posix).join(homedir, target.slice(2));
	}
	return target;
}

/** The first `name` (with the OS's executable suffixes) found on PATH, or null. */
export function findOnPath(
	name: string,
	env: Record<string, string | undefined>,
	platform: string,
	fileExists: (target: string) => boolean = existsSync
): string | null {
	const separator = platform === 'win32' ? ';' : ':';
	const raw = env.PATH ?? env.Path ?? '';
	const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
	const join = platform === 'win32' ? path.win32.join : path.posix.join;
	for (const dir of raw.split(separator)) {
		if (!dir.trim()) continue;
		for (const suffix of suffixes) {
			const candidate = join(dir.trim(), `${name}${suffix}`);
			if (fileExists(candidate)) return candidate;
		}
	}
	return null;
}

/** The login shell for this OS (spec U18, OWNER-QUESTIONS B3). */
export function resolveLoginShell(
	platform: string,
	env: Record<string, string | undefined>,
	fileExists: (target: string) => boolean = existsSync
): string[] {
	if (platform === 'win32') {
		const pwsh = findOnPath('pwsh', env, platform, fileExists);
		return pwsh ? [pwsh, '-NoLogo'] : ['powershell.exe', '-NoLogo'];
	}
	const shell = env.SHELL?.trim();
	if (shell && shell.startsWith('/')) return [shell, '-l'];
	return [platform === 'darwin' ? '/bin/zsh' : '/bin/sh', '-l'];
}

function isWithin(child: string, parent: string, platform: string): boolean {
	const paths = platform === 'win32' ? path.win32 : path.posix;
	const relative = paths.relative(
		platform === 'win32' ? parent.toLowerCase() : parent,
		platform === 'win32' ? child.toLowerCase() : child
	);
	return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative));
}

export async function composeOwnerSession(input: OwnerSessionLaunchInput): Promise<OwnerSessionLaunchResult> {
	if (!input.consents.manage) {
		return {
			ok: false,
			error: { code: 'consent_missing', hint: fleetConsentMissingHint('manage', input.nodeName) }
		};
	}
	const fileExists = input.fileExists ?? existsSync;
	const realpath = input.realpath ?? ((target: string) => fsp.realpath(target));

	// The folder: absolute after `~`, real (symlinks resolved), inside home or an extra root.
	const requested = expandHome(input.cwd.trim(), input.homedir, input.platform);
	const isAbsolute = input.platform === 'win32' ? path.win32.isAbsolute(requested) : path.posix.isAbsolute(requested);
	if (!isAbsolute) {
		return { ok: false, error: { code: 'invalid', hint: `${input.cwd} is not a full path on ${input.nodeName}` } };
	}
	let cwd: string;
	try {
		cwd = await realpath(requested);
	} catch {
		return { ok: false, error: { code: 'invalid', hint: `${input.cwd} does not exist on ${input.nodeName}` } };
	}
	const roots: string[] = [];
	for (const root of [input.homedir, ...(input.extraRoots ?? [])]) {
		try {
			roots.push(await realpath(root));
		} catch {
			// a root that does not exist admits nothing
		}
	}
	if (!roots.some((root) => isWithin(cwd, root, input.platform))) {
		return {
			ok: false,
			error: {
				code: 'invalid',
				hint: `${input.cwd} is outside your home folder on ${input.nodeName}; sessions start in your home folder or a folder the machine's owner allowed`
			}
		};
	}

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(input.env)) {
		if (typeof value === 'string') env[key] = value;
	}

	if (input.provider === 'shell') {
		return { ok: true, launch: { command: resolveLoginShell(input.platform, input.env, fileExists), cwd, env } };
	}

	const tag = FLEET_SESSION_PROVIDER_CAPABILITY[input.provider];
	const cliPath = tag ? input.modelCli[input.provider] : null;
	if (!cliPath) {
		return {
			ok: false,
			error: {
				code: 'unsupported_on_node',
				hint: `${PROVIDER_LABEL[input.provider]} is not installed on ${input.nodeName}`
			}
		};
	}
	const overlay = await input.overlay.hookOverlayFor('owner', input.provider, input.sessionId);
	const command = [cliPath, ...(overlay?.args ?? [])];
	for (const [key, value] of Object.entries(overlay?.env ?? {})) env[key] = value;
	const message = input.firstMessage?.trim() ? input.firstMessage : undefined;
	if (!message) return { ok: true, launch: { command, cwd, env } };
	const viaCmd = input.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath);
	if (viaCmd) return { ok: true, launch: { command, cwd, env, typeAfterStart: message } };
	return { ok: true, launch: { command: [...command, message], cwd, env } };
}
