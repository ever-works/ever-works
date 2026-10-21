import { installDaemonProcessHandlers, runSessionDaemon } from '../../daemon/daemon-main';
import { pipePtyFactory } from '../../daemon/__tests__/pty-test-kit';

/**
 * Test fixture (bundled by `daemon-survives-node.spec.ts`, never shipped): the
 * real session daemon entry with the test's pipe-backed process host — this
 * machine has no native terminal addon in the workspace — and a short idle
 * window so the spec can watch it exit on its own.
 *
 *   node test-daemon.js <stateDir> <socketPath> <tokenFile>
 */
const [stateDir, socketPath, tokenFile] = process.argv.slice(2);

void runSessionDaemon({
	stateDir,
	socketPath,
	tokenFile,
	logFile: `${stateDir}/daemon.log`,
	version: 'test',
	ptyFactory: pipePtyFactory,
	idleExitMs: 1_500,
	tickMs: 100
})
	.then((daemon) => installDaemonProcessHandlers(daemon, `${stateDir}/daemon.log`))
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	});
