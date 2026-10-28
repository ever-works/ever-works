import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configBackupPath, loadConfig, saveConfig, type ConfigFileSystem } from './core/config-store';
import { clampResourceLimits, DEFAULT_HEARTBEAT_INTERVAL_MS, type NodeConfig } from './core/types';
import { createConfigFileSystem, windowsAclUser } from './node-io';

/**
 * The atomic config write against a REAL disk (2026-10-28 incident). The
 * in-memory specs prove the order of operations; these prove the operating
 * system keeps the promises that order relies on: the temp file is already
 * owner-only when the credential reaches it, and the file renamed over the
 * config keeps that protection (POSIX mode bits; on Windows the explicit,
 * inheritance-stripped ACL `icacls` reads back).
 *
 * Everything happens in a fresh directory under the OS temp dir, never in
 * the real `%APPDATA%\ever-works-node`.
 */

const SECRET = 'cmVhbC1kaXNrLXNlY3JldC1mb3ItYXRvbWljLXNwZWNz';

function config(overrides: Partial<NodeConfig> = {}): NodeConfig {
	return {
		apiUrl: 'https://api.ever.works',
		nodeId: '11111111-2222-4333-8444-555555555555',
		secret: SECRET,
		kind: 'node',
		capabilities: [],
		heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
		enrolledAt: '2026-10-28T11:00:00.000Z',
		paused: false,
		secretStorage: 'file',
		limits: clampResourceLimits(undefined),
		...overrides
	};
}

/** The ACEs `icacls` lists for a file: `DOMAIN\user:(F)`, `BUILTIN\Users:(I)(RX)`, ... */
function aclEntries(filePath: string): string[] {
	const output = execFileSync('icacls', [filePath], { encoding: 'utf8', windowsHide: true });
	return output
		.split(/\r?\n/)
		.map((line, index) => (index === 0 ? line.slice(filePath.length) : line).trim())
		.filter((line) => line.length > 0 && !/^Successfully processed/i.test(line));
}

let dir: string;
let configPath: string;

beforeEach(async () => {
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ever-works-node-atomic-'));
	configPath = path.join(dir, 'node-config.json');
});

afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true });
});

describe('createConfigFileSystem — atomic config writes on a real disk', () => {
	it('supplies every primitive the atomic write needs (no silent in-place fallback)', () => {
		const fs = createConfigFileSystem();
		for (const name of [
			'createFileExclusive',
			'writeExistingFile',
			'rename',
			'link',
			'remove',
			'syncDirectory',
			'readDirectory',
			'modifiedAtMs'
		] as const) {
			expect(typeof fs[name], name).toBe('function');
		}
	});

	it('replaces the config, refreshes the last-good copy, and leaves no temp file behind', async () => {
		const fs = createConfigFileSystem();
		await saveConfig(fs, configPath, config(), { platform: process.platform });
		await saveConfig(fs, configPath, config({ paused: true }), { platform: process.platform });

		await expect(loadConfig(fs, configPath)).resolves.toMatchObject({ secret: SECRET, paused: true });
		expect(await fsp.readFile(configBackupPath(configPath), 'utf8')).toBe(await fsp.readFile(configPath, 'utf8'));
		expect((await fsp.readdir(dir)).sort()).toEqual(['node-config.json', 'node-config.json.bak']);
	});

	it('is not blocked by a reader holding the config open', async () => {
		const fs = createConfigFileSystem();
		await saveConfig(fs, configPath, config(), { platform: process.platform });
		const reader = await fsp.open(configPath, 'r');
		try {
			await saveConfig(fs, configPath, config({ paused: true }), { platform: process.platform });
		} finally {
			await reader.close();
		}
		await expect(loadConfig(fs, configPath)).resolves.toMatchObject({ paused: true });
	});

	it('writes content only into a file that already exists — never creating one around it', async () => {
		const fs = createConfigFileSystem();
		await expect(fs.writeExistingFile!(path.join(dir, 'missing.tmp'), SECRET)).rejects.toMatchObject({
			code: 'ENOENT'
		});
		expect(await fsp.readdir(dir)).toEqual([]);
	});

	it.runIf(process.platform !== 'win32')(
		'POSIX: the temp file is already 0600 when the credential is written, and the renamed files keep 0600',
		async () => {
			const real = createConfigFileSystem();
			const modesAtWrite: number[] = [];
			const fs: ConfigFileSystem = {
				...real,
				writeExistingFile: async (filePath, content) => {
					modesAtWrite.push((await fsp.stat(filePath)).mode & 0o777);
					await real.writeExistingFile!(filePath, content);
				}
			};
			// A permissive umask must not matter: owner-only comes from the explicit mode.
			let umask: number | null = null;
			try {
				umask = process.umask(0o000);
			} catch {
				// Worker threads cannot change the umask; the default one is narrower anyway.
			}
			try {
				await saveConfig(fs, configPath, config(), { platform: process.platform });
			} finally {
				if (umask !== null) process.umask(umask);
			}

			expect(modesAtWrite).toEqual([0o600, 0o600]);
			expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o600);
			expect((await fsp.stat(configBackupPath(configPath))).mode & 0o777).toBe(0o600);
		}
	);

	it.runIf(process.platform === 'win32')(
		'Windows: the temp file already has the owner-only ACL when the credential is written, and the renamed config keeps it',
		async () => {
			const user = windowsAclUser(process.env);
			expect(user).toBeTruthy();
			const owner = (entry: string) => entry.toLowerCase().startsWith(`${user!.toLowerCase()}:`);

			// Control: a plain new file here inherits the directory's ACL.
			const control = path.join(dir, 'control.txt');
			await fsp.writeFile(control, 'x');
			expect(aclEntries(control).some((entry) => entry.includes('(I)'))).toBe(true);
			await fsp.rm(control);

			const real = createConfigFileSystem();
			const aclAtWrite: string[][] = [];
			const fs: ConfigFileSystem = {
				...real,
				writeExistingFile: async (filePath, content) => {
					aclAtWrite.push(aclEntries(filePath));
					await real.writeExistingFile!(filePath, content);
				}
			};
			await saveConfig(fs, configPath, config(), { platform: 'win32' });

			expect(aclAtWrite).toHaveLength(2);
			for (const entries of [...aclAtWrite, aclEntries(configPath), aclEntries(configBackupPath(configPath))]) {
				expect(entries.length).toBeGreaterThan(0);
				expect(entries.filter((entry) => entry.includes('(I)'))).toEqual([]);
				expect(entries.filter((entry) => !owner(entry))).toEqual([]);
			}
		},
		60_000
	);
});
