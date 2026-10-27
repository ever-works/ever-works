import { describe, expect, it } from 'vitest';

import {
	FLEET_PORT_TUNNEL_HARD_MS,
	FLEET_PORT_TUNNEL_IDLE_MS,
	FLEET_PORT_TUNNELS_PER_OWNER,
	FLEET_PORT_WATCH_MAX,
	FLEET_PORTS_LIST_MAX,
	describeFleetOtherPorts,
	fleetPortLoopbackUrl,
	fleetPortTunnelExpiry,
	fleetWellKnownPortName,
	groupFleetPorts,
	isFleetLoopbackBind,
	isFleetPortLoopbackUrl,
	normalizeFleetPortsList,
	parseFleetPortWatchList,
	rewriteFleetPortTunnelLocation,
	stripFleetPortTunnelCookies,
	type FleetListeningPort
} from '../fleet-ports.types.js';
import { fleetLinkMachineVerbActionFamily, fleetLinkVerbConsent } from '../fleet-link.types.js';

describe('FL-10 limits are CONTRACTS §10', () => {
	it('pins the tunnel caps', () => {
		expect(FLEET_PORT_TUNNEL_IDLE_MS).toBe(10 * 60_000);
		expect(FLEET_PORT_TUNNEL_HARD_MS).toBe(60 * 60_000);
		expect(FLEET_PORT_TUNNELS_PER_OWNER).toBe(4);
	});

	it('maps the verbs to their families and consent', () => {
		expect(fleetLinkMachineVerbActionFamily('ports.list')).toBe('view');
		expect(fleetLinkMachineVerbActionFamily('ports.open')).toBe('ports');
		expect(fleetLinkMachineVerbActionFamily('ports.preview')).toBe('ports');
		expect(fleetLinkVerbConsent('ports.list')).toBe('manage');
		expect(fleetLinkVerbConsent('ports.open')).toBe('manage');
	});
});

describe('isFleetPortLoopbackUrl', () => {
	it('accepts the loopback on a port', () => {
		expect(isFleetPortLoopbackUrl('http://127.0.0.1:3000/')).toBe(true);
		expect(isFleetPortLoopbackUrl('https://127.0.0.1:9000/x?y=1')).toBe(true);
		expect(isFleetPortLoopbackUrl('http://localhost:5173/', 5173)).toBe(true);
	});

	it('refuses every other host, scheme, credential or port', () => {
		expect(isFleetPortLoopbackUrl('http://example.com:3000/')).toBe(false);
		expect(isFleetPortLoopbackUrl('http://10.0.0.5:3000/')).toBe(false);
		expect(isFleetPortLoopbackUrl('file:///etc/passwd')).toBe(false);
		expect(isFleetPortLoopbackUrl('http://user:pw@127.0.0.1:3000/')).toBe(false);
		expect(isFleetPortLoopbackUrl('http://127.0.0.1/')).toBe(false);
		expect(isFleetPortLoopbackUrl('http://127.0.0.1:3000/', 3001)).toBe(false);
		expect(isFleetPortLoopbackUrl('http://127.0.0.1.evil.test:3000/')).toBe(false);
	});

	it('builds the only address the epic opens', () => {
		expect(fleetPortLoopbackUrl(3000)).toBe('http://127.0.0.1:3000/');
		expect(fleetPortLoopbackUrl(9000, 'https')).toBe('https://127.0.0.1:9000/');
	});
});

describe('isFleetLoopbackBind', () => {
	it.each(['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost'])('%s is local only', (bind) => {
		expect(isFleetLoopbackBind(bind)).toBe(true);
	});
	it.each(['0.0.0.0', '::', '*', '192.168.1.10'])('%s is not', (bind) => {
		expect(isFleetLoopbackBind(bind)).toBe(false);
	});
});

describe('parseFleetPortWatchList', () => {
	it('keeps valid, distinct ports, capped', () => {
		expect(parseFleetPortWatchList('4000, 4001,4000,0,70000,abc')).toEqual([4000, 4001]);
		const many = Array.from({ length: 20 }, (_, i) => String(4000 + i)).join(',');
		expect(parseFleetPortWatchList(many)).toHaveLength(FLEET_PORT_WATCH_MAX);
		expect(parseFleetPortWatchList(undefined)).toEqual([]);
	});
});

describe('groupFleetPorts / describeFleetOtherPorts', () => {
	const row = (port: number, kind: FleetListeningPort['kind'], extra: Partial<FleetListeningPort> = {}) =>
		({ port, proto: 'tcp', bind: '0.0.0.0', localOnly: false, kind, ...extra }) as FleetListeningPort;

	it('puts web servers first by port and folds the rest with names', () => {
		const groups = groupFleetPorts([
			row(5432, 'other', { wellKnown: 'postgres' }),
			row(5173, 'web'),
			row(22, 'other', { wellKnown: 'ssh' }),
			row(3000, 'web'),
			row(135, 'noise')
		]);
		expect(groups.web.map((port) => port.port)).toEqual([3000, 5173]);
		expect(describeFleetOtherPorts(groups.other)).toBe(':22 ssh · :5432 postgres');
		expect(groups.noise).toHaveLength(1);
		expect(fleetWellKnownPortName(6379)).toBe('redis');
		expect(fleetWellKnownPortName(1234)).toBeUndefined();
	});
});

describe('normalizeFleetPortsList', () => {
	it('drops what a node may not say and bounds the rest', () => {
		const list = normalizeFleetPortsList({
			ports: [
				{ port: 3000, kind: 'web', bind: '127.0.0.1', web: { scheme: 'http', status: 200, title: 'A\u0000B' } },
				{ port: 8080, kind: 'web', bind: '0.0.0.0', web: { status: 9000 } },
				{ port: 0, kind: 'web' },
				{ port: 22, kind: 'other', secret: 'x', program: { name: 'sshd', pid: -1 } }
			],
			discovery: 'nope',
			sampledAt: '2026-10-21T09:41:00.000Z'
		});
		expect(list?.ports).toHaveLength(3);
		expect(list?.ports[0].localOnly).toBe(true);
		expect(list?.ports[0].web?.title).toBe('A B');
		expect(list?.ports[1].kind).toBe('other');
		expect(list?.ports[2].program).toEqual({ name: 'sshd', pid: null });
		expect((list?.ports[2] as unknown as Record<string, unknown>).secret).toBeUndefined();
		expect(list?.discovery).toBe('ss');
	});

	it('caps the list', () => {
		const ports = Array.from({ length: FLEET_PORTS_LIST_MAX + 10 }, (_, i) => ({ port: i + 1, kind: 'other' }));
		const list = normalizeFleetPortsList({ ports, discovery: 'ss' });
		expect(list?.ports).toHaveLength(FLEET_PORTS_LIST_MAX);
		expect(list?.truncated).toBe(true);
	});

	it('answers null for anything not a list', () => {
		expect(normalizeFleetPortsList(null)).toBeNull();
		expect(normalizeFleetPortsList({ ports: 'x' })).toBeNull();
	});
});

describe('tunnel helpers', () => {
	it('expires idle after 10 min and hard after 60 min', () => {
		const opened = new Date('2026-10-21T09:00:00Z');
		expect(
			fleetPortTunnelExpiry({ openedAt: opened, lastRequestAt: null }, new Date('2026-10-21T09:09:59Z'))
		).toBeNull();
		expect(fleetPortTunnelExpiry({ openedAt: opened, lastRequestAt: null }, new Date('2026-10-21T09:10:00Z'))).toBe(
			'idle'
		);
		expect(
			fleetPortTunnelExpiry(
				{ openedAt: opened, lastRequestAt: new Date('2026-10-21T09:59:00Z') },
				new Date('2026-10-21T10:00:00Z')
			)
		).toBe('hard');
	});

	it('never forwards the preview host or session cookies', () => {
		expect(stripFleetPortTunnelCookies('ew_tunnel=a; sid=1; app=2; EW_X=3', ['sid'])).toBe('app=2');
		expect(stripFleetPortTunnelCookies('ew_tunnel=a', [])).toBe('');
	});

	it('rewrites a Location on the tunnelled port only', () => {
		const base = 'https://preview.example.test/p/abc/';
		expect(rewriteFleetPortTunnelLocation('http://127.0.0.1:3000/x?y=1', 3000, base)).toBe(
			'https://preview.example.test/p/abc/x?y=1'
		);
		expect(rewriteFleetPortTunnelLocation('/login', 3000, base)).toBe('https://preview.example.test/p/abc/login');
		expect(rewriteFleetPortTunnelLocation('https://elsewhere.test/', 3000, base)).toBeNull();
		expect(rewriteFleetPortTunnelLocation('http://127.0.0.1:4000/', 3000, base)).toBeNull();
		expect(rewriteFleetPortTunnelLocation('next', 3000, base)).toBe('next');
	});
});
