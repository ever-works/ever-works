import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	FLEET_SESSION_HOOK_BODY_MAX_BYTES,
	FLEET_SESSION_HOOK_POST_TIMEOUT_MS,
	FLEET_SESSION_HOOK_SPOOL_MAX_AGE_MS,
	FLEET_SESSION_HOOK_SPOOL_MAX_BYTES,
	FLEET_SESSION_HOOK_SPOOL_MAX_FILES,
	isFleetDaemonSessionId
} from '@ever-works/contracts';
import { HOOK_SESSION_HEADER, HOOK_TOKEN_HEADER } from './hook-endpoint';

/**
 * Session status (FL-05, plan §6.1, spec FR-2, FR-4, U1, U2) — everything a
 * hook needs on disk, under the session daemon's state folder
 * (`<node config dir>/sessions/`, owner-only):
 *
 *  - **`hook-endpoint.json`** — the loopback endpoint's port and token,
 *    atomically replaced at EVERY node start and kept when the node stops, so
 *    a CLI that outlives a node restart reads the new port on its next hook
 *    (U1) and one that fires while the node is down spools instead of failing;
 *  - **`hooks/hook-client.cjs`** — the one program every hook runs (Claude
 *    Code's hook command, Codex's `notify`): it reads the endpoint file on each
 *    invocation, posts the CLI's payload with the token, and on any failure
 *    appends it to `hook-spool/<sessionId>.jsonl` — and ALWAYS exits 0 within
 *    2 s, printing nothing (a Claude hook's stdout would become context), so a
 *    CLI never waits on the node (FR-4);
 *  - **`hook-spool/`** — what the node drains, in order, once its endpoint is
 *    up (U2): ≤ 5 MB per file, ≤ 1 024 files, ≤ 7 days.
 *
 * The client is a plain Node script run by the same Node binary that runs this
 * node (and its session daemon), so one program works on Linux, macOS and
 * Windows without a shell or `curl` (plan §3 named shell scripts with a
 * `curl` → `node` fallback; the node binary is always there, so the fallback
 * is the whole client — lane-log decision).
 */

export const HOOK_ENDPOINT_FILE = 'hook-endpoint.json';
export const HOOK_CLIENT_FILE = 'hook-client.cjs';
export const HOOK_SPOOL_DIR = 'hook-spool';
export const HOOK_OVERLAYS_DIR = 'overlays';

export interface HookPaths {
	stateDir: string;
	endpointFile: string;
	hooksDir: string;
	clientPath: string;
	spoolDir: string;
	overlaysDir: string;
}

export function resolveHookPaths(stateDir: string, platform: string = process.platform): HookPaths {
	const join = platform === 'win32' ? path.win32.join : path.posix.join;
	const hooksDir = join(stateDir, 'hooks');
	return {
		stateDir,
		endpointFile: join(stateDir, HOOK_ENDPOINT_FILE),
		hooksDir,
		clientPath: join(hooksDir, HOOK_CLIENT_FILE),
		spoolDir: join(stateDir, HOOK_SPOOL_DIR),
		overlaysDir: join(stateDir, HOOK_OVERLAYS_DIR)
	};
}

/** The subset of `fs/promises` this file uses (a seam for specs). */
export interface HookFs {
	mkdir(target: string, options: { recursive: true; mode?: number }): Promise<unknown>;
	writeFile(target: string, data: string, options?: { mode?: number }): Promise<void>;
	readFile(target: string, encoding: 'utf8'): Promise<string>;
	rename(from: string, to: string): Promise<void>;
	unlink(target: string): Promise<void>;
	readdir(target: string): Promise<string[]>;
	stat(target: string): Promise<{ mtimeMs: number; size: number }>;
	chmod(target: string, mode: number): Promise<void>;
}

export const defaultHookFs: HookFs = {
	mkdir: (target, options) => fsp.mkdir(target, options),
	writeFile: (target, data, options) => fsp.writeFile(target, data, options),
	readFile: (target, encoding) => fsp.readFile(target, encoding),
	rename: (from, to) => fsp.rename(from, to),
	unlink: (target) => fsp.unlink(target),
	readdir: (target) => fsp.readdir(target),
	stat: (target) => fsp.stat(target),
	chmod: (target, mode) => fsp.chmod(target, mode)
};

/** The endpoint file's content. */
export interface HookEndpointFile {
	port: number;
	token: string;
	pid: number;
	writtenAt: string;
}

/**
 * Replace the endpoint file atomically (write a sibling, then rename), owner-
 * only: 0600 on POSIX, the node's owner-only ACL on Windows (FR-2).
 */
export async function writeHookEndpointFile(input: {
	paths: HookPaths;
	port: number;
	token: string;
	pid?: number;
	now?: () => number;
	fs?: HookFs;
	restrictFile?: (file: string) => Promise<void> | void;
	platform?: string;
}): Promise<void> {
	const fs = input.fs ?? defaultHookFs;
	const content: HookEndpointFile = {
		port: input.port,
		token: input.token,
		pid: input.pid ?? process.pid,
		writtenAt: new Date((input.now ?? Date.now)()).toISOString()
	};
	await fs.mkdir(input.paths.stateDir, { recursive: true, mode: 0o700 });
	const temp = `${input.paths.endpointFile}.${content.pid}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(content)}\n`, { mode: 0o600 });
	if ((input.platform ?? process.platform) !== 'win32') await fs.chmod(temp, 0o600).catch(() => undefined);
	await fs.rename(temp, input.paths.endpointFile);
	if (input.restrictFile) await input.restrictFile(input.paths.endpointFile);
}

/**
 * The hook client's source. Paths are baked in (JSON-encoded); nothing is
 * read from the CLI's payload but the payload itself. Plain CommonJS with no
 * dependency, for every Node the node supports.
 */
export function hookClientSource(paths: Pick<HookPaths, 'endpointFile' | 'spoolDir'>): string {
	return `'use strict';
// Ever Works node — session hook client. Generated at every node start; edits are overwritten.
// Posts the CLI's hook payload to this computer's loopback endpoint; on any failure appends it to
// the spool. Always exits 0 within 2 s and never prints (a hook's output could steer the CLI).
const fs = require('fs');
const path = require('path');
const http = require('http');
const ENDPOINT_FILE = ${JSON.stringify(paths.endpointFile)};
const SPOOL_DIR = ${JSON.stringify(paths.spoolDir)};
const MAX_SPOOL_BYTES = ${FLEET_SESSION_HOOK_SPOOL_MAX_BYTES};
const MAX_BODY_BYTES = ${FLEET_SESSION_HOOK_BODY_MAX_BYTES};
const TIMEOUT_MS = ${FLEET_SESSION_HOOK_POST_TIMEOUT_MS};
const provider = process.argv[2];
const sessionId = process.argv[3] || process.env.EVER_WORKS_SESSION_ID || '';
let finished = false;
function done() {
	if (finished) return;
	finished = true;
	process.exit(0);
}
setTimeout(done, 1900).unref();
if ((provider !== 'claude' && provider !== 'codex') || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) done();
function spool(body) {
	try {
		fs.mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 });
		const file = path.join(SPOOL_DIR, sessionId + '.jsonl');
		let size = 0;
		try {
			size = fs.statSync(file).size;
		} catch (error) {
			size = 0;
		}
		if (size < MAX_SPOOL_BYTES) {
			fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), provider: provider, body: body }) + '\\n', { mode: 0o600 });
		}
	} catch (error) {
		// Nothing to do: a hook must never fail its CLI.
	}
	done();
}
function post(body) {
	if (finished) return;
	let endpoint = null;
	try {
		endpoint = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8'));
	} catch (error) {
		endpoint = null;
	}
	if (!endpoint || typeof endpoint.port !== 'number' || typeof endpoint.token !== 'string') return spool(body);
	let settled = false;
	const fail = function () {
		if (settled) return;
		settled = true;
		spool(body);
	};
	const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
	headers[${JSON.stringify(HOOK_TOKEN_HEADER)}] = endpoint.token;
	headers[${JSON.stringify(HOOK_SESSION_HEADER)}] = sessionId;
	const request = http.request(
		{ host: '127.0.0.1', port: endpoint.port, method: 'POST', path: '/hook/' + provider, headers: headers, timeout: TIMEOUT_MS },
		function (response) {
			response.resume();
			response.on('end', function () {
				if (settled) return;
				settled = true;
				if (response.statusCode >= 200 && response.statusCode < 300) done();
				else spool(body);
			});
		}
	);
	request.on('timeout', function () {
		request.destroy();
		fail();
	});
	request.on('error', fail);
	request.end(body);
}
if (provider === 'codex') {
	// Codex runs its notify program with the JSON payload as the last argument.
	post(String(process.argv[4] || '').slice(0, MAX_BODY_BYTES));
} else {
	const chunks = [];
	let size = 0;
	let read = false;
	const finish = function () {
		if (read) return;
		read = true;
		post(Buffer.concat(chunks).toString('utf8'));
	};
	process.stdin.on('data', function (chunk) {
		size += chunk.length;
		if (size <= MAX_BODY_BYTES) chunks.push(chunk);
	});
	process.stdin.on('end', finish);
	process.stdin.on('error', finish);
	setTimeout(finish, 800).unref();
}
`;
}

/** Write the hook client when its content changed (owner-only folder, owner-read file). */
export async function materializeHookClient(input: {
	paths: HookPaths;
	fs?: HookFs;
	platform?: string;
	restrictFile?: (file: string) => Promise<void> | void;
}): Promise<{ written: boolean }> {
	const fs = input.fs ?? defaultHookFs;
	const source = hookClientSource(input.paths);
	await fs.mkdir(input.paths.hooksDir, { recursive: true, mode: 0o700 });
	let current: string | null = null;
	try {
		current = await fs.readFile(input.paths.clientPath, 'utf8');
	} catch {
		current = null;
	}
	if (current === source) return { written: false };
	const temp = `${input.paths.clientPath}.${process.pid}.tmp`;
	await fs.writeFile(temp, source, { mode: 0o600 });
	await fs.rename(temp, input.paths.clientPath);
	if (input.restrictFile) await input.restrictFile(input.paths.clientPath);
	return { written: true };
}

export interface HookSpoolDrainResult {
	/** Events handed to the endpoint and accepted. */
	applied: number;
	/** Lines dropped (unknown session, malformed, too old). */
	dropped: number;
	/** Spool files still waiting (a session the daemon has not reported yet). */
	pending: number;
}

/**
 * Drain the spool in order (U2): oldest file first, each file's lines in the
 * order they were written. A file is renamed before it is read, so a hook
 * appending at that moment starts a new file instead of losing its line.
 * Files of sessions the node does not know YET (the daemon list is still
 * coming) are left for the next pass; older than 7 days, or beyond 1 024
 * files, they are removed.
 */
export async function drainHookSpool(input: {
	spoolDir: string;
	ingest: (sessionId: string, provider: string, raw: string, at: number) => boolean;
	isKnownSession: (sessionId: string) => boolean;
	now?: () => number;
	fs?: HookFs;
	platform?: string;
}): Promise<HookSpoolDrainResult> {
	const fs = input.fs ?? defaultHookFs;
	const now = (input.now ?? Date.now)();
	const join = (input.platform ?? process.platform) === 'win32' ? path.win32.join : path.posix.join;
	const result: HookSpoolDrainResult = { applied: 0, dropped: 0, pending: 0 };
	let names: string[];
	try {
		names = await fs.readdir(input.spoolDir);
	} catch {
		return result;
	}
	const files: Array<{ name: string; sessionId: string; mtimeMs: number }> = [];
	for (const name of names) {
		const match = /^([A-Za-z0-9_-]{1,64})\.jsonl(\.draining)?$/.exec(name);
		if (!match) continue;
		try {
			const stat = await fs.stat(join(input.spoolDir, name));
			files.push({ name, sessionId: match[1], mtimeMs: stat.mtimeMs });
		} catch {
			// gone meanwhile
		}
	}
	files.sort((a, b) => a.mtimeMs - b.mtimeMs);
	const excess = Math.max(0, files.length - FLEET_SESSION_HOOK_SPOOL_MAX_FILES);
	for (let index = 0; index < files.length; index += 1) {
		const file = files[index];
		const full = join(input.spoolDir, file.name);
		if (index < excess || now - file.mtimeMs > FLEET_SESSION_HOOK_SPOOL_MAX_AGE_MS) {
			await fs.unlink(full).catch(() => undefined);
			result.dropped += 1;
			continue;
		}
		if (!isFleetDaemonSessionId(file.sessionId) || !input.isKnownSession(file.sessionId)) {
			result.pending += 1;
			continue;
		}
		const draining = file.name.endsWith('.draining') ? full : `${full}.draining`;
		if (draining !== full) {
			try {
				await fs.rename(full, draining);
			} catch {
				continue;
			}
		}
		let content = '';
		try {
			content = await fs.readFile(draining, 'utf8');
		} catch {
			continue;
		}
		for (const line of content.split('\n')) {
			if (!line.trim()) continue;
			let record: { ts?: unknown; provider?: unknown; body?: unknown } | null = null;
			try {
				record = JSON.parse(line) as { ts?: unknown; provider?: unknown; body?: unknown };
			} catch {
				record = null;
			}
			if (!record || typeof record.provider !== 'string' || typeof record.body !== 'string') {
				result.dropped += 1;
				continue;
			}
			const at = typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : now;
			if (input.ingest(file.sessionId, record.provider, record.body, at)) result.applied += 1;
			else result.dropped += 1;
		}
		await fs.unlink(draining).catch(() => undefined);
	}
	return result;
}
