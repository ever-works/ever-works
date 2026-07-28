import { describe, expect, it } from 'vitest';
import {
	CONFIG_FILE_MODE,
	CONFIG_PATH_ENV,
	loadConfig,
	parseConfig,
	resolveConfigPath,
	saveConfig,
	type ConfigFileSystem
} from './config-store';
import { clampResourceLimits, DEFAULT_HEARTBEAT_INTERVAL_MS, redactConfig, type NodeConfig } from './types';

const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';

/** In-memory ConfigFileSystem that records mkdir/chmod so we can assert on them. */
function memoryFs() {
	const files = new Map<string, string>();
	const dirs: string[] = [];
	const chmods: Array<{ path: string; mode: number }> = [];
	let chmodFails = false;

	const fs: ConfigFileSystem = {
		readFile: async (filePath) => files.get(filePath) ?? null,
		writeFile: async (filePath, content) => {
			files.set(filePath, content);
		},
		mkdir: async (dirPath) => {
			dirs.push(dirPath);
		},
		chmod: async (filePath, mode) => {
			if (chmodFails) {
				throw new Error('EPERM: chmod is not supported on this filesystem');
			}
			chmods.push({ path: filePath, mode });
		},
		dirname: (filePath) => filePath.replace(/[\\/][^\\/]*$/, '')
	};

	return { fs, files, dirs, chmods, failChmod: () => (chmodFails = true) };
}

function config(overrides: Partial<NodeConfig> = {}): NodeConfig {
	return {
		apiUrl: 'https://api.ever.works',
		nodeId: '11111111-2222-4333-8444-555555555555',
		secret: SECRET,
		kind: 'node',
		capabilities: ['os:linux', 'docker'],
		name: 'build-box-01',
		heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
		enrolledAt: '2026-07-25T10:00:00.000Z',
		// All three are normalized onto every load so an OLDER config file
		// still produces a complete NodeConfig. The fixture has to carry
		// them or the round-trip compares against a shape the store no
		// longer returns.
		paused: false,
		secretStorage: 'file',
		limits: clampResourceLimits(undefined),
		...overrides
	};
}

const join = (...segments: string[]) => segments.join('/');

describe('resolveConfigPath', () => {
	it('honours the explicit override above every platform convention', () => {
		expect(
			resolveConfigPath({
				env: { [CONFIG_PATH_ENV]: '  /etc/ever-works/node.json  ', APPDATA: 'C:/Users/x/AppData/Roaming' },
				platform: 'win32',
				homedir: 'C:/Users/x',
				join
			})
		).toBe('/etc/ever-works/node.json');
	});

	it('uses the OS config directory per platform', () => {
		expect(resolveConfigPath({ env: { APPDATA: 'C:/AppData' }, platform: 'win32', homedir: 'C:/U', join })).toBe(
			'C:/AppData/ever-works-node/node-config.json'
		);
		expect(resolveConfigPath({ env: {}, platform: 'darwin', homedir: '/Users/x', join })).toBe(
			'/Users/x/Library/Application Support/ever-works-node/node-config.json'
		);
		expect(resolveConfigPath({ env: {}, platform: 'linux', homedir: '/home/x', join })).toBe(
			'/home/x/.config/ever-works-node/node-config.json'
		);
	});

	it('respects XDG_CONFIG_HOME on Linux and falls back to the profile when APPDATA is unset', () => {
		expect(
			resolveConfigPath({ env: { XDG_CONFIG_HOME: '/home/x/cfg' }, platform: 'linux', homedir: '/home/x', join })
		).toBe('/home/x/cfg/ever-works-node/node-config.json');
		expect(resolveConfigPath({ env: {}, platform: 'win32', homedir: 'C:/Users/x', join })).toBe(
			'C:/Users/x/AppData/Roaming/ever-works-node/node-config.json'
		);
	});
});

describe('persistence round-trip', () => {
	it('saves and reloads an identical config', async () => {
		const { fs, files } = memoryFs();
		const path = '/home/x/.config/ever-works-node/node-config.json';

		await saveConfig(fs, path, config(), { platform: 'linux' });
		expect(files.has(path)).toBe(true);

		const reloaded = await loadConfig(fs, path);
		expect(reloaded).toEqual(config());
	});

	it('creates the parent directory and tightens the file to 0600 on POSIX', async () => {
		const { fs, dirs, chmods } = memoryFs();
		const path = '/home/x/.config/ever-works-node/node-config.json';

		await saveConfig(fs, path, config(), { platform: 'linux' });

		expect(dirs).toEqual(['/home/x/.config/ever-works-node']);
		expect(chmods).toEqual([{ path, mode: CONFIG_FILE_MODE }]);
		expect(CONFIG_FILE_MODE).toBe(0o600);
	});

	it('skips the chmod on Windows (no POSIX mode bits) but still writes', async () => {
		const { fs, files, chmods } = memoryFs();
		const path = 'C:/AppData/ever-works-node/node-config.json';

		await saveConfig(fs, path, config(), { platform: 'win32' });

		expect(chmods).toEqual([]);
		expect(files.get(path)).toContain('"nodeId"');
	});

	it('survives a filesystem that cannot chmod — the write is what matters', async () => {
		const { fs, files, failChmod } = memoryFs();
		failChmod();
		const path = '/mnt/share/node-config.json';

		await expect(saveConfig(fs, path, config(), { platform: 'linux' })).resolves.toBeUndefined();
		expect(files.has(path)).toBe(true);
	});

	it('reads a missing file as "not enrolled" rather than throwing', async () => {
		const { fs } = memoryFs();
		await expect(loadConfig(fs, '/nowhere/node-config.json')).resolves.toBeNull();
	});
});

describe('parseConfig validation', () => {
	it('rejects corrupt JSON and non-objects', () => {
		expect(parseConfig(null)).toBeNull();
		expect(parseConfig('')).toBeNull();
		expect(parseConfig('{ not json')).toBeNull();
		expect(parseConfig('"a string"')).toBeNull();
		expect(parseConfig('null')).toBeNull();
	});

	it('rejects a config missing any of apiUrl / nodeId / secret', () => {
		const full = config();
		expect(parseConfig(JSON.stringify({ ...full, apiUrl: '' }))).toBeNull();
		expect(parseConfig(JSON.stringify({ ...full, nodeId: undefined }))).toBeNull();
		expect(parseConfig(JSON.stringify({ ...full, secret: '' }))).toBeNull();
	});

	it('defaults an unrecognized kind and clamps an out-of-range interval', () => {
		const parsed = parseConfig(JSON.stringify({ ...config(), kind: 'k8s', heartbeatIntervalMs: 1 }));
		expect(parsed?.kind).toBe('node');
		expect(parsed?.heartbeatIntervalMs).toBe(5_000);

		const huge = parseConfig(JSON.stringify({ ...config(), heartbeatIntervalMs: 9_999_999 }));
		expect(huge?.heartbeatIntervalMs).toBe(15 * 60_000);
	});

	it('keeps the desktop-node kind and drops non-string capability entries', () => {
		const parsed = parseConfig(
			JSON.stringify({ ...config(), kind: 'desktop-node', capabilities: ['git', 7, null, 'docker'] })
		);
		expect(parsed?.kind).toBe('desktop-node');
		expect(parsed?.capabilities).toEqual(['git', 'docker']);
	});
});

describe('redactConfig', () => {
	it('drops the secret while keeping every non-credential field', () => {
		const view = redactConfig(config());
		expect(JSON.stringify(view)).not.toContain(SECRET);
		expect(view).toEqual({
			apiUrl: 'https://api.ever.works',
			nodeId: '11111111-2222-4333-8444-555555555555',
			kind: 'node',
			capabilities: ['os:linux', 'docker'],
			name: 'build-box-01',
			heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
			enrolledAt: '2026-07-25T10:00:00.000Z',
			// None of these is a credential: `paused` is lifecycle state,
			// `secretStorage` is the storage MODE (file vs keychain) rather
			// than the secret, and `limits` is a capacity policy. This
			// assertion is an exhaustive allowlist on purpose — that is
			// what makes it catch a credential field leaking into the
			// redacted view.
			paused: false,
			secretStorage: 'file',
			limits: clampResourceLimits(undefined),
			hasSecret: true
		});
	});

	it('reports a missing credential instead of silently looking healthy', () => {
		expect(redactConfig(config({ secret: '' })).hasSecret).toBe(false);
	});
});
