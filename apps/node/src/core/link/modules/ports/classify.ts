import {
	FLEET_UNIX_NOISE_PORTS,
	FLEET_UNIX_NOISE_PROGRAMS,
	FLEET_WINDOWS_DYNAMIC_RPC_RANGE,
	FLEET_WINDOWS_HTTPAPI_SERVER,
	FLEET_WINDOWS_NOISE_PORTS,
	FLEET_WINDOWS_NOISE_PROGRAMS,
	fleetWellKnownPortName,
	isFleetLoopbackBind,
	type FleetListeningPort,
	type FleetListeningPortContainer,
	type FleetListeningPortProgram
} from '@ever-works/contracts';
import type { RawListener } from './discover';
import type { HttpProbeResult } from './http-probe';

/**
 * Servers and ports (FL-10, plan §3 "Classification") — what kind of port a
 * listener is, from DATA tables (`fleet-ports.types.ts`), never from
 * heuristics spread through code:
 *
 *  - `noise` — a system listener: Windows' RPC / NetBIOS / SMB / WS-Discovery
 *    / WinRM / Delivery Optimisation ports, the dynamic RPC range, Windows'
 *    own processes; rpcbind, CUPS and the local DNS stub on Unix; and ANY
 *    port that answered with Windows' built-in HTTP stack's error page
 *    (`Server: Microsoft-HTTPAPI/2.0`) — that is the kernel's HTTP.sys, not a
 *    server someone started (spec U7). Noise is decided BEFORE web: a system
 *    port is never counted as a web server;
 *  - `web` — answered HTTP (any status) when the machine asked itself;
 *  - `other` — everything else, with its well-known name when it has one,
 *    and "no HTTP answer" when it accepted the connection but said nothing
 *    HTTP within the probe window (spec U6).
 */

export interface ClassifyInput {
	listener: RawListener;
	platform: string;
	probe: HttpProbeResult | null;
	program?: FleetListeningPortProgram;
	container?: FleetListeningPortContainer;
}

function programKey(name: string | null | undefined): string {
	return (name ?? '').trim().toLowerCase().replace(/\.exe$/, '');
}

/** True when a listener is a system listener by port, range or program (before any probe). */
export function isSystemNoise(listener: RawListener, platform: string): boolean {
	const program = programKey(listener.program);
	if (platform === 'win32') {
		if (FLEET_WINDOWS_NOISE_PORTS.includes(listener.port)) return true;
		const [low, high] = FLEET_WINDOWS_DYNAMIC_RPC_RANGE;
		if (listener.port >= low && listener.port <= high) return true;
		return program.length > 0 && FLEET_WINDOWS_NOISE_PROGRAMS.includes(program);
	}
	if (FLEET_UNIX_NOISE_PORTS.includes(listener.port)) return true;
	// systemd-resolved's stub listens on 127.0.0.53 / 127.0.0.54.
	if (listener.port === 53 && /^127\.0\.0\.5[34]$/.test(listener.bind)) return true;
	return program.length > 0 && FLEET_UNIX_NOISE_PROGRAMS.includes(program);
}

/** True when a probe answer is Windows' built-in HTTP stack talking, not a server (spec U7). */
export function isWindowsHttpApiAnswer(probe: HttpProbeResult | null): boolean {
	if (!probe || probe.kind !== 'http') return false;
	const server = (probe.server ?? '').trim();
	return server.startsWith(FLEET_WINDOWS_HTTPAPI_SERVER);
}

/** One row of the list. */
export function classifyListener(input: ClassifyInput): FleetListeningPort {
	const { listener, probe } = input;
	const row: FleetListeningPort = {
		port: listener.port,
		proto: 'tcp',
		bind: listener.bind,
		localOnly: isFleetLoopbackBind(listener.bind),
		kind: 'other'
	};
	if (input.program) row.program = input.program;
	if (input.container) row.container = input.container;
	const wellKnown = fleetWellKnownPortName(listener.port);
	if (wellKnown) row.wellKnown = wellKnown;

	if (isSystemNoise(listener, input.platform) || isWindowsHttpApiAnswer(probe)) {
		row.kind = 'noise';
		return row;
	}
	// PID 4 is "System" (HTTP.sys, SMB) and PID 0 the idle process: noise —
	// unless the port answered as a real server (a site hosted on HTTP.sys
	// answers with its own `Server`, not the built-in error page above).
	const kernelOwned = input.platform === 'win32' && (listener.pid === 4 || listener.pid === 0);
	if (probe?.kind === 'http') {
		row.kind = 'web';
		row.web = {
			scheme: probe.scheme,
			status: probe.status,
			title: probe.title,
			probedAt: probe.probedAt
		};
		return row;
	}
	if (kernelOwned) {
		row.kind = 'noise';
		return row;
	}
	if (probe?.kind === 'silent') row.noHttpAnswer = true;
	return row;
}

/**
 * Merge listeners that are the same server on several binds (`0.0.0.0:3000`
 * and `[::]:3000`) into one row per port: the row keeps the widest bind (a
 * port reachable from outside is not "local only" because it ALSO listens
 * on the loopback) and the first program that names itself.
 */
export function mergeByPort(listeners: readonly RawListener[]): RawListener[] {
	const byPort = new Map<number, RawListener>();
	for (const listener of listeners) {
		const existing = byPort.get(listener.port);
		if (!existing) {
			byPort.set(listener.port, { ...listener });
			continue;
		}
		if (isFleetLoopbackBind(existing.bind) && !isFleetLoopbackBind(listener.bind)) existing.bind = listener.bind;
		if (existing.pid === null && listener.pid !== null) existing.pid = listener.pid;
		if (!existing.program && listener.program) existing.program = listener.program;
		if (!existing.path && listener.path) existing.path = listener.path;
	}
	return [...byPort.values()].sort((a, b) => a.port - b.port);
}
