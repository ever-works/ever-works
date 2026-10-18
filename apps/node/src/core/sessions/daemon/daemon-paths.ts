import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * Sessions on computers (FL-04) — where the session daemon lives on a
 * machine (plan §6.2, CONTRACTS R-26).
 *
 *  - **state dir** `<node config dir>/sessions/` (0700, owner-only ACL on
 *    Windows): the token file, the crash log, the per-session records.
 *  - **socket**: on Linux `$XDG_RUNTIME_DIR/ever-works-node/daemon.sock` when
 *    a runtime dir exists, else `<state dir>/daemon.sock`; on macOS
 *    `<state dir>/daemon.sock`. A Unix socket path is limited to ~104 bytes,
 *    so a longer one falls back to `/tmp/ever-works-node-<hash>.sock` (its
 *    own 0600 mode and the token still guard it). On Windows a named pipe
 *    `\\.\pipe\ever-works-node-sessions-<hash>`, the hash of the state dir so
 *    two node installs on one machine never share a daemon.
 *
 * None of these is a network listener (README D2): a same-user local
 * socket, and nothing is read from it before the token.
 */

export interface SessionDaemonPaths {
	stateDir: string;
	socketPath: string;
	tokenFile: string;
	logFile: string;
}

export interface ResolveSessionDaemonPathsInput {
	/** The node's config FILE path (`resolveConfigPath`); the state dir sits beside it. */
	configPath: string;
	platform: string;
	env: Record<string, string | undefined>;
}

/** Longest Unix socket path every supported OS accepts (macOS: 104 including the NUL). */
export const MAX_UNIX_SOCKET_PATH = 100;

function shortHash(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function resolveSessionDaemonPaths(input: ResolveSessionDaemonPathsInput): SessionDaemonPaths {
	const join = input.platform === 'win32' ? path.win32.join : path.posix.join;
	const dirname = input.platform === 'win32' ? path.win32.dirname : path.posix.dirname;
	const stateDir = join(dirname(input.configPath), 'sessions');
	const tokenFile = join(stateDir, 'daemon.token');
	const logFile = join(stateDir, 'daemon.log');
	if (input.platform === 'win32') {
		return {
			stateDir,
			tokenFile,
			logFile,
			socketPath: `\\\\.\\pipe\\ever-works-node-sessions-${shortHash(stateDir)}`
		};
	}
	const runtimeDir = input.platform === 'linux' ? input.env.XDG_RUNTIME_DIR?.trim() : undefined;
	let socketPath =
		runtimeDir && runtimeDir.startsWith('/')
			? join(runtimeDir, 'ever-works-node', 'daemon.sock')
			: join(stateDir, 'daemon.sock');
	if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH) {
		socketPath = `/tmp/ever-works-node-${shortHash(stateDir)}.sock`;
	}
	return { stateDir, tokenFile, logFile, socketPath };
}

/** True for a Windows named pipe path. */
export function isNamedPipe(socketPath: string): boolean {
	return socketPath.startsWith('\\\\.\\pipe\\') || socketPath.startsWith('//./pipe/');
}
