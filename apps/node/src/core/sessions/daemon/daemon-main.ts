import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { DaemonCore } from './daemon-core';
import { DaemonServer } from './daemon-server';
import { createNodePtyFactory, type PtyFactory } from './pty-host';
import { SessionStore } from './session-store';

/**
 * Sessions on computers (FL-04) — the session daemon's entry (`ever-works-node
 * session-daemon`, a hidden subcommand of the same `cli.js`, so a person
 * installs exactly one thing — README D3).
 *
 * The node spawns it DETACHED (its own process group, no stdio), so it
 * outlives the node process: a node restart or upgrade never ends a session
 * (spec FR-1, FR-2). It exits on its own only after
 * `FLEET_SESSION_DAEMON_IDLE_EXIT_MS` with no session and no node connected.
 *
 * It refuses to start without a token file (the node writes one before it
 * spawns the daemon), logs to `<state dir>/daemon.log` with a 1 MB rollover,
 * and never lets one session's crash take the others down.
 */

export interface RunSessionDaemonOptions {
	stateDir: string;
	socketPath: string;
	tokenFile: string;
	logFile: string;
	version: string;
	/** Test seams. */
	ptyFactory?: PtyFactory | null;
	ptyReason?: string;
	idleExitMs?: number;
	exit?: (code: number) => void;
	tickMs?: number;
}

export interface RunningSessionDaemon {
	core: DaemonCore;
	server: DaemonServer;
	stop(): Promise<void>;
}

const LOG_ROLLOVER_BYTES = 1024 * 1024;

function createFileLog(logFile: string): (message: string) => void {
	return (message) => {
		try {
			try {
				if (fs.statSync(logFile).size > LOG_ROLLOVER_BYTES) fs.renameSync(logFile, `${logFile}.1`);
			} catch {
				// no log yet
			}
			fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
		} catch {
			// a log that cannot be written must never stop the daemon
		}
	};
}

async function readTokenFile(tokenFile: string): Promise<string | null> {
	try {
		const raw = (await fsp.readFile(tokenFile, 'utf8')).trim();
		return raw.length >= 16 ? raw : null;
	} catch {
		return null;
	}
}

export async function runSessionDaemon(options: RunSessionDaemonOptions): Promise<RunningSessionDaemon> {
	await fsp.mkdir(options.stateDir, { recursive: true, mode: 0o700 });
	const log = createFileLog(options.logFile);
	if ((await readTokenFile(options.tokenFile)) === null) {
		log('refusing to start: no token file');
		throw new Error('the session daemon needs its token file (the node writes it before starting the daemon)');
	}
	let ptyFactory = options.ptyFactory;
	let ptyReason = options.ptyReason;
	if (ptyFactory === undefined) {
		const loaded = createNodePtyFactory();
		ptyFactory = loaded.factory;
		ptyReason = loaded.availability.reason;
		if (!ptyFactory) log(`terminal support unavailable: ${ptyReason ?? 'unknown'}`);
	}
	const exit = options.exit ?? ((code: number) => process.exit(code));
	let stopping = false;
	const core = new DaemonCore({
		version: options.version,
		ptyFactory,
		...(ptyReason ? { ptyReason } : {}),
		store: new SessionStore(options.stateDir),
		...(options.idleExitMs !== undefined ? { idleExitMs: options.idleExitMs } : {}),
		log,
		onIdleExit: () => {
			log('idle: no sessions and no node for the idle window — exiting');
			void stop().then(() => exit(0));
		}
	});
	await core.boot();
	const server = new DaemonServer({
		core,
		socketPath: options.socketPath,
		readToken: () => readTokenFile(options.tokenFile),
		log
	});
	await server.listen();
	log(`listening (version ${options.version}, ${core.list().length} session(s) restored)`);
	const tick = setInterval(() => {
		core.tick().catch((error: unknown) =>
			log(`tick failed: ${error instanceof Error ? error.message : String(error)}`)
		);
	}, options.tickMs ?? 1000);
	tick.unref?.();

	async function stop(): Promise<void> {
		if (stopping) return;
		stopping = true;
		clearInterval(tick);
		await core.persistAll().catch(() => undefined);
		await server.close();
	}

	return { core, server, stop };
}

/**
 * Process-level wiring for the real daemon: survive what a detached daemon
 * must survive (a terminal hang-up, one session's crash) and persist screens
 * before a system shutdown.
 */
export function installDaemonProcessHandlers(daemon: RunningSessionDaemon, logFile: string): void {
	const log = createFileLog(logFile);
	process.on('SIGHUP', () => undefined);
	process.on('SIGINT', () => undefined);
	process.on('SIGTERM', () => {
		log('SIGTERM: persisting screens and exiting');
		void daemon.stop().finally(() => process.exit(0));
	});
	process.on('uncaughtException', (error) => {
		log(`uncaught: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	});
	process.on('unhandledRejection', (error) => {
		log(`unhandled rejection: ${error instanceof Error ? error.message : String(error)}`);
	});
}
