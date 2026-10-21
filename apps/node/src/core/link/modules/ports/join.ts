import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import {
	FLEET_PORT_TEXT_MAX,
	isFleetPortNumber,
	type FleetListeningPortContainer,
	type FleetListeningPortProgram
} from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import type { RawListener } from './discover';

/**
 * Servers and ports (FL-10, plan §3 "Program / container join") — what makes
 * a port legible: the program behind it (name, PID, working folder) and, when
 * the listener is a container runtime's port proxy, the container.
 *
 *  - **Working folder.** Linux reads `/proc/<pid>/cwd`; macOS asks `lsof`
 *    for every PID's `cwd` in one call; Windows has no cheap cwd, so the
 *    executable's folder stands in. The home folder is shown as `~`. A PID
 *    the node may not read (another user's process) keeps its name and PID
 *    without a folder — never an error.
 *  - **Container.** `docker ps` port mappings (`0.0.0.0:8080->80/tcp`) map a
 *    published host port to its container, asked only when a listener looks
 *    like the runtime's proxy (or names no program at all). No Docker — no
 *    container, nothing else changes (FL-09's own module, when it lands, may
 *    replace this read; the row shape stays).
 */

/** Programs that publish a container's port on the host. */
export const CONTAINER_PROXY_PROGRAMS: readonly string[] = [
	'docker-proxy',
	'dockerd',
	'rootlesskit',
	'containerd',
	'com.docker.backend',
	'com.docker.vpnkit',
	'vpnkit',
	'vpnkit-bridge',
	'wslrelay',
	'podman',
	'conmon',
	'gvproxy',
	'slirp4netns',
	'pasta'
];

export interface JoinIo {
	runner: CommandRunner;
	platform: string;
	/** The home folder, shown as `~`. */
	homedir: string;
	/** `readlink`; defaults to `fs.promises.readlink`. */
	readlink?: (path: string) => Promise<string>;
}

export interface JoinedListener {
	listener: RawListener;
	program?: FleetListeningPortProgram;
	container?: FleetListeningPortContainer;
}

function tildeHome(path: string, home: string): string {
	if (!home) return path;
	const normalizedHome = home.replace(/[\\/]+$/, '');
	if (path === normalizedHome) return '~';
	if (path.startsWith(`${normalizedHome}/`) || path.startsWith(`${normalizedHome}\\`)) {
		return `~${path.slice(normalizedHome.length)}`;
	}
	return path;
}

function programName(listener: RawListener): string | null {
	const raw = (listener.program ?? '').trim();
	if (raw.length === 0) return null;
	return raw.replace(/\.exe$/i, '').slice(0, FLEET_PORT_TEXT_MAX);
}

/** `lsof -a -d cwd -p 1,2 -F pn`: `p<pid>` then `n<path>`. */
export function parseLsofCwd(stdout: string): Map<number, string> {
	const out = new Map<number, string>();
	let pid: number | null = null;
	for (const line of stdout.split(/\r?\n/)) {
		if (line.startsWith('p')) {
			const parsed = Number(line.slice(1));
			pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
		} else if (line.startsWith('n') && pid !== null && !out.has(pid)) {
			out.set(pid, line.slice(1));
		}
	}
	return out;
}

/**
 * `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Ports}}'` → host port → container.
 * Ports read `0.0.0.0:8080->80/tcp, :::8080->80/tcp, 127.0.0.1:9000-9001->9000-9001/tcp`.
 */
export function parseDockerPorts(stdout: string): Map<number, FleetListeningPortContainer> {
	const out = new Map<number, FleetListeningPortContainer>();
	for (const line of stdout.split(/\r?\n/)) {
		const [id, names, ports] = line.split('\t');
		if (!id || !names || !ports) continue;
		const container = { id: id.trim().slice(0, 64), name: names.split(',')[0].trim().slice(0, 128) };
		if (!container.id || !container.name) continue;
		for (const mapping of ports.split(',')) {
			const arrow = mapping.indexOf('->');
			if (arrow < 0) continue;
			const host = mapping.slice(0, arrow).trim();
			const colon = host.lastIndexOf(':');
			const range = colon >= 0 ? host.slice(colon + 1) : host;
			const [lowText, highText] = range.split('-');
			const low = Number(lowText);
			const high = highText === undefined ? low : Number(highText);
			if (!isFleetPortNumber(low) || !isFleetPortNumber(high) || high < low || high - low > 1024) continue;
			for (let port = low; port <= high; port++) if (!out.has(port)) out.set(port, container);
		}
	}
	return out;
}

async function containersByPort(io: JoinIo): Promise<Map<number, FleetListeningPortContainer>> {
	try {
		const result = await io.runner.run('docker', ['ps', '--format', '{{.ID}}\t{{.Names}}\t{{.Ports}}'], {
			timeoutMs: 3_000
		});
		if (result.code !== 0 || result.timedOut || result.spawnError) return new Map();
		return parseDockerPorts(result.stdout);
	} catch {
		return new Map();
	}
}

async function workingFolders(io: JoinIo, pids: readonly number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	if (pids.length === 0) return out;
	if (io.platform === 'linux') {
		const readlink = io.readlink ?? ((path: string) => fsp.readlink(path));
		await Promise.all(
			pids.map(async (pid) => {
				try {
					out.set(pid, await readlink(`/proc/${pid}/cwd`));
				} catch {
					// another user's process: no folder
				}
			})
		);
		return out;
	}
	if (io.platform === 'darwin') {
		try {
			const result = await io.runner.run('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-F', 'pn'], {
				timeoutMs: 3_000
			});
			if (!result.timedOut) return parseLsofCwd(result.stdout);
		} catch {
			// no folders
		}
	}
	return out;
}

/** Attach programs, folders and containers to the listeners. Never throws. */
export async function joinListeners(listeners: readonly RawListener[], io: JoinIo): Promise<JoinedListener[]> {
	const pids = [...new Set(listeners.map((l) => l.pid).filter((pid): pid is number => pid !== null && pid > 4))];
	const wantsContainers = listeners.some((listener) => {
		const name = programName(listener)?.toLowerCase() ?? null;
		return name === null || CONTAINER_PROXY_PROGRAMS.includes(name);
	});
	const [folders, containers] = await Promise.all([
		workingFolders(io, pids),
		wantsContainers ? containersByPort(io) : Promise.resolve(new Map<number, FleetListeningPortContainer>())
	]);
	return listeners.map((listener) => {
		const joined: JoinedListener = { listener };
		const name = programName(listener);
		if (name) {
			let cwd = listener.pid !== null ? folders.get(listener.pid) : undefined;
			if (!cwd && io.platform === 'win32' && listener.path) cwd = dirname(listener.path);
			const program: FleetListeningPortProgram = { name, pid: listener.pid };
			if (cwd) program.cwd = tildeHome(cwd, io.homedir).slice(0, FLEET_PORT_TEXT_MAX);
			joined.program = program;
		}
		const container = containers.get(listener.port);
		if (container) joined.container = container;
		return joined;
	});
}
