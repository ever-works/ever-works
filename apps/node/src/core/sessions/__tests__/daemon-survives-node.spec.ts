import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonControlClient } from '../daemon-client';
import { resolveSessionDaemonPaths, type SessionDaemonPaths } from '../daemon/daemon-paths';
import type { DaemonSessionInfo } from '../daemon/daemon-protocol';
import { eventually } from '../daemon/__tests__/pty-test-kit';

/**
 * ACC-FL04-01 / FR-1 / FR-2, with REAL processes: a stand-in node spawns the
 * session daemon detached, starts a session through it and exits — the way a
 * node restart or an upgrade does. The daemon is not its child in any way
 * that matters: it keeps running, the session keeps producing output, and a
 * new connection finds it unchanged. Once the session ends and is
 * acknowledged, and no node is connected, the daemon exits on its own.
 */

describe('the session daemon outlives the node', () => {
	let dir: string;
	let bundles: { daemon: string; node: string };
	let paths: SessionDaemonPaths;

	beforeAll(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ewn-survive-'));
		paths = resolveSessionDaemonPaths({
			configPath: path.join(dir, `node-config-${randomBytes(4).toString('hex')}.json`),
			platform: process.platform,
			env: {}
		});
		bundles = { daemon: path.join(dir, 'test-daemon.js'), node: path.join(dir, 'test-node.js') };
		const fixtures = path.join(__dirname, 'fixtures');
		await build({
			entryPoints: {
				'test-daemon': path.join(fixtures, 'test-daemon-entry.ts'),
				'test-node': path.join(fixtures, 'test-node-entry.ts')
			},
			outdir: dir,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			target: 'node22',
			external: ['@homebridge/node-pty-prebuilt-multiarch'],
			logLevel: 'silent'
		});
	}, 60_000);

	afterAll(async () => {
		await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	});

	it('keeps the session running after the node process exits, then exits idle once nothing is left', async () => {
		const script = `let n = 0; setInterval(() => process.stdout.write('tick ' + (n++) + '\\n'), 100);`;
		const node = spawnSync(
			process.execPath,
			[bundles.node, bundles.daemon, paths.stateDir, paths.socketPath, paths.tokenFile, dir, script],
			{ encoding: 'utf8', timeout: 30_000 }
		);
		expect(node.stderr).toBe('');
		expect(node.stdout).toContain('started');
		expect(node.status).toBe(0);

		// The node is gone. Connect as the next node process would.
		const token = (await fsp.readFile(paths.tokenFile, 'utf8')).trim();
		const client = await DaemonControlClient.connect({ socketPath: paths.socketPath, token });
		const listed = await client.request<{ sessions: DaemonSessionInfo[] }>('list');
		expect(listed.sessions).toEqual([expect.objectContaining({ id: 'survivor', alive: true, title: 'survivor' })]);

		// Still producing output after the node died.
		const first = await client.request<{ text: string }>('screen', { sessionId: 'survivor', lines: 5 });
		await eventually(async () => {
			const later = await client.request<{ text: string }>('screen', { sessionId: 'survivor', lines: 5 });
			return later.text !== first.text && later.text.includes('tick');
		});

		// End it, acknowledge it, disconnect: the daemon has nothing left and goes.
		await client.request('end', { sessionId: 'survivor', reason: 'user', graceMs: 500 });
		await eventually(async () => {
			const after = await client.request<{ sessions: DaemonSessionInfo[] }>('list');
			return after.sessions[0]?.alive === false;
		});
		await client.request('ack-ended', { sessionIds: ['survivor'] });
		client.close();
		// Every probe is itself a node connection that restarts the idle window,
		// so probe less often than the window (1.5 s in the fixture).
		await eventually(
			async () => {
				try {
					const probe = await DaemonControlClient.connect({
						socketPath: paths.socketPath,
						token,
						timeoutMs: 500
					});
					probe.close();
					return false;
				} catch {
					return true;
				}
			},
			20_000,
			2_500
		);
	}, 60_000);
});
