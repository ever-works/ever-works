import { spawn } from 'node:child_process';
import { SessionDaemonSupervisor } from '../../daemon-supervisor';
import { ensureDaemonToken } from '../../daemon-token';

/**
 * Test fixture (bundled by `daemon-survives-node.spec.ts`, never shipped): a
 * stand-in for `ever-works-node start` that does what the runtime does —
 * ensure the token, spawn the daemon DETACHED, connect, start one session —
 * then exits, the way a node restart or an upgrade would.
 *
 *   node test-node.js <daemonBundle> <stateDir> <socketPath> <tokenFile> <cwd> <script>
 */
const [daemonBundle, stateDir, socketPath, tokenFile, cwd, script] = process.argv.slice(2);

const supervisor = new SessionDaemonSupervisor({
	paths: { stateDir, socketPath, tokenFile, logFile: `${stateDir}/daemon.log` },
	nodeVersion: 'test',
	ensureToken: () => ensureDaemonToken({ tokenFile }),
	spawnDaemon: () => {
		const child = spawn(process.execPath, [daemonBundle, stateDir, socketPath, tokenFile], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		});
		child.unref();
	}
});

supervisor.onConnected(() => {
	void supervisor
		.request('start', {
			sessionId: 'survivor',
			kind: 'owner',
			provider: 'shell',
			command: [process.execPath, '-e', script],
			cwd,
			env: { ...process.env },
			cols: 80,
			rows: 24,
			title: 'survivor',
			startedBy: 'user:u1'
		})
		.then(() => {
			process.stdout.write('started\n');
			// The node goes away abruptly; the daemon and the session must not.
			process.exit(0);
		})
		.catch((error: unknown) => {
			process.stderr.write(`start failed: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(3);
		});
});
supervisor.start();
