/**
 * Fleet — servers and ports on a computer (FL-10, CONTRACTS R-3, R-17, §3.3,
 * §4.9, §7, §10).
 *
 * The node reads what the machine is listening on (`ss` on Linux, `lsof` on
 * macOS, `Get-NetTCPConnection` on Windows), asks each candidate port over
 * HTTP from the machine itself, and answers the `machine` verb `ports.list`
 * with the shapes below. Nothing here is stored on the platform (README §1):
 * the only stored FL-10 shape is the preview tunnel grant
 * (`fleet_port_tunnels`, phase 2).
 *
 * Every address the node touches for this epic is `http(s)://127.0.0.1:<port>/…`
 * — never another host. {@link isFleetPortLoopbackUrl} is the one check both
 * sides use.
 */

// ─── Capability, verbs ──────────────────────────────────────────────────────

/** Capability tag: listening-port discovery is available (a discovery tool exists, `--manage`). */
export const FLEET_PORTS_CAPABILITY = 'ports';

/**
 * Capability tag: **Open on the desktop** can work on this machine — the node
 * runs with `--attend` and has a desktop opener (FL-07's helper, or the node
 * itself running in a desktop session). The Open menu enables the desktop
 * target only with it.
 */
export const FLEET_PORTS_DESKTOP_OPEN_CAPABILITY = 'ports-desktop';

/** The `machine` verbs of this epic (CONTRACTS §3.3). `ports.list` answers to `view`, the others to `ports`. */
export const FLEET_PORTS_LINK_VERBS = {
	list: 'ports.list',
	open: 'ports.open',
	preview: 'ports.preview'
} as const;

export type FleetPortsLinkVerb = (typeof FLEET_PORTS_LINK_VERBS)[keyof typeof FLEET_PORTS_LINK_VERBS];

// ─── Limits (CONTRACTS §10 and plan §3) ─────────────────────────────────────

/** A probe that does not answer HTTP within this long is an "other" port with "no HTTP answer". */
export const FLEET_PORT_PROBE_TIMEOUT_MS = 2_000;
/** Bytes of a probed page read at most (the `<title>` is looked for in these). */
export const FLEET_PORT_PROBE_BODY_CAP = 64 * 1024;
/** Longest page title carried. */
export const FLEET_PORT_TITLE_MAX = 120;
/** Ports probed at once. */
export const FLEET_PORT_PROBE_CONCURRENCY = 32;
/** How long the node reuses a list it just built (the tab refreshes every 5 s). */
export const FLEET_PORT_LIST_CACHE_MS = 2_000;
/** How often an open Ports tab refreshes. */
export const FLEET_PORT_LIST_REFRESH_MS = 5_000;
/** Ports one list may carry; a machine with more lists the first ones by port number. */
export const FLEET_PORTS_LIST_MAX = 512;
/** Ports one request may watch for ("Open a port…"). */
export const FLEET_PORT_WATCH_MAX = 8;
/** The longest working folder or program name carried. */
export const FLEET_PORT_TEXT_MAX = 300;

/** One preview-profile open per node lasts at most this long (CONTRACTS §10). */
export const FLEET_PORT_PREVIEW_MAX_MS = 60 * 60_000;
/** A preview-profile open ends this long after its viewer left (CONTRACTS §10). */
export const FLEET_PORT_PREVIEW_LEAVE_GRACE_MS = 15_000;

/** A preview tunnel closes after this long without a request (CONTRACTS §10, R-17). */
export const FLEET_PORT_TUNNEL_IDLE_MS = 10 * 60_000;
/** A preview tunnel closes this long after it opened, whatever happens (CONTRACTS §10, R-17). */
export const FLEET_PORT_TUNNEL_HARD_MS = 60 * 60_000;
/** Open preview tunnels one person may hold (CONTRACTS §10, R-17). */
export const FLEET_PORT_TUNNELS_PER_OWNER = 4;
/** One tunnelled request waits at most this long for the machine (plan §5: 504 after). */
export const FLEET_PORT_TUNNEL_REQUEST_TIMEOUT_MS = 60_000;
/** Largest `DATA` chunk a tunnel body travels in. */
export const FLEET_PORT_TUNNEL_CHUNK_BYTES = 64 * 1024;
/** Largest header block (as JSON) a tunnel envelope carries either way. */
export const FLEET_PORT_TUNNEL_MAX_HEADER_BYTES = 64 * 1024;
/** The sticky cookie that routes a tunnelled page's root-absolute requests (plan §3). */
export const FLEET_PORT_TUNNEL_COOKIE = 'ew_tunnel';
/** Prefix of every cookie the preview host itself sets; never forwarded to a tunnelled server. */
export const FLEET_PORT_TUNNEL_COOKIE_PREFIX = 'ew_';
/** The path prefix a tunnel lives under on the preview host: `/p/<tunnelId>/…`. */
export const FLEET_PORT_TUNNEL_PATH_PREFIX = '/p/';
/** A one-time hand-off token (R-17 fallback) is redeemable this long. */
export const FLEET_PORT_TUNNEL_HANDOFF_TTL_SEC = 60;

// ─── Ports ──────────────────────────────────────────────────────────────────

/**
 * How a listener reads to a person:
 *  - `web` — answered HTTP when the machine asked itself;
 *  - `other` — a database, ssh, … (folded under one line);
 *  - `noise` — a system listener (Windows RPC/SMB/…, rpcbind, cupsd), hidden behind "N system ports";
 *  - `waiting` — a port the person asked to watch that nothing listens on yet.
 */
export const FLEET_PORT_KINDS = ['web', 'other', 'noise', 'waiting'] as const;

export type FleetPortKind = (typeof FLEET_PORT_KINDS)[number];

export function isFleetPortKind(value: unknown): value is FleetPortKind {
	return typeof value === 'string' && (FLEET_PORT_KINDS as readonly string[]).includes(value);
}

/** The discovery tool a list came from. */
export const FLEET_PORT_DISCOVERY_TOOLS = ['ss', 'lsof', 'powershell'] as const;

export type FleetPortDiscoveryTool = (typeof FLEET_PORT_DISCOVERY_TOOLS)[number];

export interface FleetListeningPortProgram {
	name: string;
	/** Null when the discovery tool could not tell (`ss` without permission for another user's process). */
	pid: number | null;
	/** The program's working folder, when the machine says (`~` for the home folder). */
	cwd?: string;
}

export interface FleetListeningPortContainer {
	id: string;
	name: string;
}

export interface FleetListeningPortWeb {
	scheme: 'http' | 'https';
	status: number;
	/** The page `<title>`, scanned for secrets, at most {@link FLEET_PORT_TITLE_MAX} characters. */
	title: string | null;
	/** ISO-8601 instant the probe answered. */
	probedAt: string;
}

export interface FleetListeningPort {
	port: number;
	proto: 'tcp';
	/** The bind address as the machine reported it (`0.0.0.0`, `::`, `127.0.0.1`, `::1`, an interface address). */
	bind: string;
	/** Bound to the loopback only: "only on <computer> itself" — still openable, because opening happens on the machine. */
	localOnly: boolean;
	kind: FleetPortKind;
	program?: FleetListeningPortProgram;
	container?: FleetListeningPortContainer;
	web?: FleetListeningPortWeb;
	/** The well-known service name of the port (`postgres`, `ssh`, …). */
	wellKnown?: string;
	/** The port accepted a connection but did not answer HTTP within the probe window (spec U6). */
	noHttpAnswer?: boolean;
	/** Seen on the previous list, gone now (spec S7) — dropped on the next. */
	stopped?: boolean;
}

export interface FleetPortsList {
	ports: FleetListeningPort[];
	/** ISO-8601 instant the node read the machine. */
	sampledAt: string;
	discovery: FleetPortDiscoveryTool;
	/** True when the list was cut at {@link FLEET_PORTS_LIST_MAX}. */
	truncated?: boolean;
}

/** `ports.list` params: ports to report as `waiting` while nothing listens on them. */
export interface FleetPortsListParams {
	watch?: number[];
}

/** Where **Open** shows the page (R-3). */
export const FLEET_PORT_OPEN_TARGETS = ['desktop', 'preview-profile'] as const;

export type FleetPortOpenTarget = (typeof FLEET_PORT_OPEN_TARGETS)[number];

export function isFleetPortOpenTarget(value: unknown): value is FleetPortOpenTarget {
	return value === 'desktop' || value === 'preview-profile';
}

/** `ports.open` params. The URL is never sent: the node builds it from the port. */
export interface FleetPortOpenParams {
	port: number;
	target: FleetPortOpenTarget;
	/** `https` when the probe saw TLS; default `http`. */
	scheme?: 'http' | 'https';
	/** Preview profile only: the live-view id the platform then opens the `desktop` channel with. */
	viewId?: string;
	/** Preview profile only: who opened it, as a `busy` answer names them ("Ops is previewing :5173"). */
	holder?: string;
}

/** What the node answers `ports.open` with. */
export interface FleetPortOpenNodeResult {
	target: FleetPortOpenTarget;
	url: string;
	/** Preview profile: the view the node keeps the preview browser under. */
	viewId?: string;
}

/** What the platform answers `POST /nodes/:id/ports/:port/open` with. */
export interface FleetPortOpenResult {
	target: FleetPortOpenTarget;
	url: string;
	/** Preview profile: the live view to attach to. */
	previewViewId?: string;
	/** Preview profile: the 60-second, single-use viewer token for `/ws/fleet/desktop/<viewId>` (role `driver`). */
	attach?: {
		token: string;
		wsPath: string;
		expiresInSec: number;
		role: 'driver' | 'viewer';
	};
	/** Preview profile: when the preview ends at the latest (ISO-8601). */
	endsAt?: string;
}

/** True for a TCP port number. */
export function isFleetPortNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** `http://127.0.0.1:<port>/` — the only address this epic opens, probes or tunnels to. */
export function fleetPortLoopbackUrl(port: number, scheme: 'http' | 'https' = 'http'): string {
	return `${scheme}://127.0.0.1:${port}/`;
}

/**
 * True when `url` is `http(s)://127.0.0.1:<port>/…` (or `localhost`), with no
 * credentials, optionally for exactly `port`. Every navigation the node's
 * preview browser makes passes through this; anything else is refused.
 */
export function isFleetPortLoopbackUrl(url: unknown, port?: number): boolean {
	if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	if (parsed.username !== '' || parsed.password !== '') return false;
	if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
	if (parsed.port === '') return false;
	const parsedPort = Number(parsed.port);
	if (!isFleetPortNumber(parsedPort)) return false;
	return port === undefined || parsedPort === port;
}

/** Bind addresses that mean "this machine only". */
export function isFleetLoopbackBind(bind: string): boolean {
	const value = bind
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
	if (value === '::1' || value === 'localhost' || value === '::ffff:127.0.0.1') return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * `?watch=4000,4001` → `[4000, 4001]`: valid port numbers only, deduplicated,
 * at most {@link FLEET_PORT_WATCH_MAX}. Anything else is dropped, never an error.
 */
export function parseFleetPortWatchList(raw: unknown): number[] {
	const values: unknown[] = Array.isArray(raw)
		? raw
		: typeof raw === 'string'
			? raw.split(',').map((part) => Number(part.trim()))
			: [];
	const out: number[] = [];
	for (const value of values) {
		const port = typeof value === 'string' ? Number(value) : value;
		if (isFleetPortNumber(port) && !out.includes(port)) out.push(port);
		if (out.length >= FLEET_PORT_WATCH_MAX) break;
	}
	return out;
}

// ─── Well-known names and system noise (plan §3, a documented data table) ──

/** Well-known service names by port. An "other" port reads `:5432 postgres`. */
export const FLEET_WELL_KNOWN_PORTS: Readonly<Record<number, string>> = Object.freeze({
	21: 'ftp',
	22: 'ssh',
	25: 'smtp',
	53: 'dns',
	110: 'pop3',
	143: 'imap',
	389: 'ldap',
	1433: 'mssql',
	1521: 'oracle',
	2375: 'docker',
	2376: 'docker',
	2379: 'etcd',
	3306: 'mysql',
	3389: 'rdp',
	4222: 'nats',
	5432: 'postgres',
	5672: 'amqp',
	5900: 'vnc',
	6379: 'redis',
	6443: 'kubernetes',
	7687: 'neo4j',
	9042: 'cassandra',
	9092: 'kafka',
	9200: 'elasticsearch',
	11211: 'memcached',
	15672: 'rabbitmq',
	27017: 'mongo'
});

/** The well-known name of a port, or undefined. */
export function fleetWellKnownPortName(port: number): string | undefined {
	return Object.prototype.hasOwnProperty.call(FLEET_WELL_KNOWN_PORTS, port) ? FLEET_WELL_KNOWN_PORTS[port] : undefined;
}

/**
 * Windows' own listeners (spec U7): RPC endpoint mapper, NetBIOS, SMB, the
 * connected-devices platform, WS-Discovery / HTTPAPI, WinRM, Delivery
 * Optimisation — hidden under "N system ports", never counted as web servers.
 */
export const FLEET_WINDOWS_NOISE_PORTS: readonly number[] = [135, 137, 138, 139, 445, 5040, 5357, 5985, 5986, 7680];

/** Windows' dynamic RPC range (inclusive) the system listeners sit in. */
export const FLEET_WINDOWS_DYNAMIC_RPC_RANGE: readonly [number, number] = [49664, 49690];

/** Windows programs whose listeners are system noise wherever they bind. */
export const FLEET_WINDOWS_NOISE_PROGRAMS: readonly string[] = [
	'svchost',
	'lsass',
	'wininit',
	'services',
	'spoolsv',
	'system',
	'smss',
	'csrss'
];

/** Unix system listeners: rpcbind, CUPS, the local DNS stub, mDNS. */
export const FLEET_UNIX_NOISE_PORTS: readonly number[] = [111, 631];

/** Unix programs whose listeners are system noise. */
export const FLEET_UNIX_NOISE_PROGRAMS: readonly string[] = [
	'rpcbind',
	'cupsd',
	'systemd-resolve',
	'systemd-resolved',
	'mdnsresponder',
	'avahi-daemon',
	'rapportd',
	'controlcenter'
];

/** The `Server` header Windows' built-in HTTP stack answers with; its error pages are never web servers (U7). */
export const FLEET_WINDOWS_HTTPAPI_SERVER = 'Microsoft-HTTPAPI';

// ─── Reading a list ─────────────────────────────────────────────────────────

/** A list split the way the tab shows it: web servers first by port, then others, system ports, waiting rows. */
export interface FleetPortsGroups {
	web: FleetListeningPort[];
	other: FleetListeningPort[];
	noise: FleetListeningPort[];
	waiting: FleetListeningPort[];
}

/** Split and order a list (web → other → noise; each by port; waiting rows last, in order asked). */
export function groupFleetPorts(ports: readonly FleetListeningPort[]): FleetPortsGroups {
	const groups: FleetPortsGroups = { web: [], other: [], noise: [], waiting: [] };
	for (const port of ports) groups[port.kind].push(port);
	const byPort = (a: FleetListeningPort, b: FleetListeningPort) => a.port - b.port || a.bind.localeCompare(b.bind);
	groups.web.sort(byPort);
	groups.other.sort(byPort);
	groups.noise.sort(byPort);
	return groups;
}

/** `:22 ssh · :5432 postgres · :6379 redis` — the folded line's names. */
export function describeFleetOtherPorts(ports: readonly FleetListeningPort[], max = 6): string {
	const parts = ports.slice(0, max).map((port) => (port.wellKnown ? `:${port.port} ${port.wellKnown}` : `:${port.port}`));
	if (ports.length > max) parts.push(`+${ports.length - max}`);
	return parts.join(' · ');
}

function boundedText(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	// eslint-disable-next-line no-control-regex
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
	if (cleaned.length === 0) return undefined;
	return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function normalizePort(value: unknown): FleetListeningPort | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!isFleetPortNumber(raw.port)) return null;
	const kind = isFleetPortKind(raw.kind) ? raw.kind : 'other';
	const bind = boundedText(raw.bind, 64) ?? '0.0.0.0';
	const port: FleetListeningPort = {
		port: raw.port,
		proto: 'tcp',
		bind,
		localOnly: raw.localOnly === true || isFleetLoopbackBind(bind),
		kind
	};
	const program = raw.program as Record<string, unknown> | undefined;
	if (program && typeof program === 'object') {
		const name = boundedText(program.name, FLEET_PORT_TEXT_MAX);
		if (name) {
			const pid =
				typeof program.pid === 'number' && Number.isInteger(program.pid) && program.pid > 0 ? program.pid : null;
			const cwd = boundedText(program.cwd, FLEET_PORT_TEXT_MAX);
			port.program = cwd ? { name, pid, cwd } : { name, pid };
		}
	}
	const container = raw.container as Record<string, unknown> | undefined;
	if (container && typeof container === 'object') {
		const id = boundedText(container.id, 128);
		const name = boundedText(container.name, 128);
		if (id && name) port.container = { id, name };
	}
	const web = raw.web as Record<string, unknown> | undefined;
	if (kind === 'web' && web && typeof web === 'object') {
		const status = typeof web.status === 'number' && Number.isInteger(web.status) ? web.status : 0;
		if (status >= 100 && status <= 599) {
			port.web = {
				scheme: web.scheme === 'https' ? 'https' : 'http',
				status,
				title: boundedText(web.title, FLEET_PORT_TITLE_MAX) ?? null,
				probedAt: typeof web.probedAt === 'string' ? web.probedAt.slice(0, 40) : new Date(0).toISOString()
			};
		}
	}
	if (kind === 'web' && !port.web) port.kind = 'other';
	const wellKnown = boundedText(raw.wellKnown, 32);
	if (wellKnown) port.wellKnown = wellKnown;
	if (raw.noHttpAnswer === true) port.noHttpAnswer = true;
	if (raw.stopped === true) port.stopped = true;
	return port;
}

/**
 * Read a `ports.list` reply off the wire. The platform never forwards what a
 * node said without this: unknown fields are dropped, text is bounded and
 * stripped of control characters, a web row without a valid status becomes
 * an "other" row, and at most {@link FLEET_PORTS_LIST_MAX} rows survive.
 * `null` when the value is not a list at all.
 */
export function normalizeFleetPortsList(value: unknown): FleetPortsList | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (!Array.isArray(raw.ports)) return null;
	const ports: FleetListeningPort[] = [];
	for (const entry of raw.ports) {
		const port = normalizePort(entry);
		if (port) ports.push(port);
		if (ports.length >= FLEET_PORTS_LIST_MAX) break;
	}
	const discovery = (FLEET_PORT_DISCOVERY_TOOLS as readonly string[]).includes(raw.discovery as string)
		? (raw.discovery as FleetPortDiscoveryTool)
		: 'ss';
	const list: FleetPortsList = {
		ports,
		sampledAt: typeof raw.sampledAt === 'string' ? raw.sampledAt.slice(0, 40) : new Date().toISOString(),
		discovery
	};
	if (raw.truncated === true || raw.ports.length > FLEET_PORTS_LIST_MAX) list.truncated = true;
	return list;
}

// ─── The preview picture (CONTRACTS §3.3 `desktop` family) ──────────────────

/**
 * Whose browser profile a `desktop` channel with `source: 'browser'` shows
 * (CONTRACTS §3.3): an Agent's own (`agent`, the default — AW-11), or the
 * owner-level preview profile at `~/.ever-works/preview-profile` (`preview`,
 * R-3) that "Open" on a port uses when the machine has no Desktop source.
 */
export const FLEET_DESKTOP_PROFILES = ['agent', 'preview'] as const;

export type FleetDesktopProfile = (typeof FLEET_DESKTOP_PROFILES)[number];

export function isFleetDesktopProfile(value: unknown): value is FleetDesktopProfile {
	return value === 'agent' || value === 'preview';
}

/** `desktop` channel-open params (CONTRACTS §3.3). */
export interface FleetDesktopChannelParams {
	source: 'desktop' | 'browser';
	display?: string | null;
	/** Absent = `agent`. */
	profile?: FleetDesktopProfile;
	viewId: string;
	quality?: 'sharp' | 'smooth' | 'steady';
}

/** The preview pane's watermark: `EVER WORKS · PREVIEW · build-01 · :3000`. */
export function fleetPortPreviewWatermark(computerName: string, port: number): string {
	return `EVER WORKS · PREVIEW · ${computerName} · :${port}`;
}

// ─── Preview tunnels (phase 2, CONTRACTS §4.9) ──────────────────────────────

export const FLEET_PORT_TUNNEL_STATES = ['open', 'closed'] as const;

export type FleetPortTunnelState = (typeof FLEET_PORT_TUNNEL_STATES)[number];

/** Why a tunnel closed (CONTRACTS §4.9, revision 4). */
export const FLEET_PORT_TUNNEL_CLOSED_REASONS = [
	'idle',
	'hard',
	'user',
	'node-offline',
	'kill-switch',
	'drain',
	'link-closed'
] as const;

export type FleetPortTunnelClosedReason = (typeof FLEET_PORT_TUNNEL_CLOSED_REASONS)[number];

export function isFleetPortTunnelClosedReason(value: unknown): value is FleetPortTunnelClosedReason {
	return typeof value === 'string' && (FLEET_PORT_TUNNEL_CLOSED_REASONS as readonly string[]).includes(value);
}

/** A tunnel as the tab, the tools and the API show it. */
export interface FleetPortTunnelView {
	id: string;
	nodeId: string;
	port: number;
	/** `https://<previewHost>/p/<id>/`. */
	url: string;
	state: FleetPortTunnelState;
	openedAt: string;
	lastRequestAt: string | null;
	closedAt: string | null;
	closedReason: FleetPortTunnelClosedReason | null;
	requestCount: number;
	bytesIn: number;
	bytesOut: number;
	/** Derived: `openedAt` + 60 min. */
	endsAt: string;
	/** `user:<id>` or `agent:<id>` — read from the open audit row ("opened by Nina for you"). */
	requestedBy?: string | null;
}

/** When a tunnel ends at the latest: `openedAt` + {@link FLEET_PORT_TUNNEL_HARD_MS}. */
export function fleetPortTunnelEndsAt(openedAt: Date | string): Date {
	const opened = typeof openedAt === 'string' ? new Date(openedAt) : openedAt;
	return new Date(opened.getTime() + FLEET_PORT_TUNNEL_HARD_MS);
}

/**
 * The reason a still-open tunnel must close at `now`, or null: `hard` once it
 * is an hour old, `idle` once ten minutes passed since the last request (or
 * since it opened, before the first).
 */
export function fleetPortTunnelExpiry(
	tunnel: { openedAt: Date | string; lastRequestAt: Date | string | null },
	now: Date
): 'idle' | 'hard' | null {
	const opened = new Date(tunnel.openedAt).getTime();
	if (now.getTime() - opened >= FLEET_PORT_TUNNEL_HARD_MS) return 'hard';
	const last = tunnel.lastRequestAt ? new Date(tunnel.lastRequestAt).getTime() : opened;
	if (now.getTime() - last >= FLEET_PORT_TUNNEL_IDLE_MS) return 'idle';
	return null;
}

/** `https://<previewHost>/p/<tunnelId>/`. */
export function fleetPortTunnelUrl(previewHost: string, tunnelId: string): string {
	return `https://${previewHost}${FLEET_PORT_TUNNEL_PATH_PREFIX}${tunnelId}/`;
}

/** A tunnel request envelope (node ← platform), JSON on the `tunnel` channel, then `DATA`* and `END`. */
export interface FleetPortTunnelRequestEnvelope {
	type: 'tunnel.request';
	requestId: string;
	method: string;
	/** Path below the tunnel prefix, always starting with `/`. */
	path: string;
	/** The raw query string without `?`, or empty. */
	query: string;
	headers: Record<string, string | string[]>;
}

/** A tunnel response envelope (node → platform), JSON, then `DATA`* and `END`. */
export interface FleetPortTunnelResponseEnvelope {
	type: 'tunnel.response';
	requestId: string;
	status: number;
	headers: Record<string, string | string[]>;
}

/** The node could not reach the port for one request. */
export interface FleetPortTunnelErrorEnvelope {
	type: 'tunnel.error';
	requestId: string;
	code: 'unreachable' | 'timeout' | 'invalid';
	hint: string;
}

/** HTTP methods a tunnel forwards. */
export const FLEET_PORT_TUNNEL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
 * Request headers never forwarded to a tunnelled server: hop-by-hop headers,
 * and the platform's own credentials (`authorization`, `cookie` is filtered
 * entry by entry instead — see {@link stripFleetPortTunnelCookies}).
 */
export const FLEET_PORT_TUNNEL_DROPPED_REQUEST_HEADERS: readonly string[] = [
	'authorization',
	'proxy-authorization',
	'connection',
	'keep-alive',
	'proxy-connection',
	'transfer-encoding',
	'te',
	'trailer',
	'upgrade',
	'host',
	'x-forwarded-for',
	'x-forwarded-host',
	'x-forwarded-proto',
	'x-real-ip',
	'forwarded',
	'cf-connecting-ip'
];

/**
 * The `cookie` header without the preview host's own cookies (`ew_*`) and the
 * platform's session cookie names given: a tunnelled server never sees an
 * Ever Works credential. Empty string when nothing is left.
 */
export function stripFleetPortTunnelCookies(cookieHeader: string, sessionCookieNames: readonly string[]): string {
	const blocked = new Set(sessionCookieNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
	return cookieHeader
		.split(';')
		.map((part) => part.trim())
		.filter((part) => {
			if (part.length === 0) return false;
			const eq = part.indexOf('=');
			const name = (eq >= 0 ? part.slice(0, eq) : part).trim().toLowerCase();
			if (name.startsWith(FLEET_PORT_TUNNEL_COOKIE_PREFIX)) return false;
			return !blocked.has(name);
		})
		.join('; ');
}

/**
 * Rewrite a `Location` a tunnelled server answered with (spec U13): an
 * absolute address on the tunnelled port (`http://127.0.0.1:3000/x`,
 * `http://localhost:3000/x`) becomes the preview address; a root-relative one
 * (`/x`) gains the tunnel prefix; anything else — another host — returns null
 * (shown as a plain link, never followed).
 */
export function rewriteFleetPortTunnelLocation(location: string, port: number, tunnelBaseUrl: string): string | null {
	const base = tunnelBaseUrl.endsWith('/') ? tunnelBaseUrl.slice(0, -1) : tunnelBaseUrl;
	if (location.startsWith('/') && !location.startsWith('//')) return `${base}${location}`;
	if (!/^[a-z][a-z0-9+.-]*:/i.test(location)) return location; // relative: the browser resolves it under the prefix
	if (!isFleetPortLoopbackUrl(location, port)) return null;
	const parsed = new URL(location);
	return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
