import { describe, expect, it, vi } from 'vitest';
import {
	fleetConsentSatisfies,
	fleetLinkVerbConsent,
	FLEET_HEALTH_NOW_VERB,
	FLEET_WAKE_SEND_VERB,
	type FleetConsents
} from '@ever-works/contracts';
import { createHealthLinkModule, type WakeSender } from './health';
import { MachineVerbError, type MachineVerbContext, type NodeLinkControlState } from './registry';

/**
 * Fleet node link — the FL-03 `health` module: `health.now` (Refresh now, R-31),
 * `wake.send` and the `wake` tag (spec FR-23 … FR-27, plan §6.1).
 */

const WORK_ONLY: FleetConsents = { work: true, attend: false, manage: false, usageScan: false };
const MANAGE: FleetConsents = { work: false, attend: false, manage: true, usageScan: false };

const control: NodeLinkControlState = { paused: false, drain: null, onChange: () => () => undefined };

const network = () => ({ macAddress: 'aa:bb:cc:dd:ee:f0', lanId: 'a1b2c3d4e5f60718', broadcast: '192.168.1.255' });

function context(overrides: Partial<MachineVerbContext> = {}): MachineVerbContext {
	return {
		verb: FLEET_WAKE_SEND_VERB,
		params: {},
		consents: MANAGE,
		control,
		nodeVersion: '1.0.0',
		nodeName: 'build-01',
		signal: new AbortController().signal,
		progress: () => undefined,
		...overrides
	};
}

function recordingSender(failures: string[] = []): WakeSender & { sent: Array<{ address: string; port: number }> } {
	const sent: Array<{ address: string; port: number }> = [];
	return {
		sent,
		send: vi.fn(async (_packet: Uint8Array, address: string, port: number) => {
			if (failures.includes(address)) throw new Error(`EACCES ${address}`);
			sent.push({ address, port });
		})
	};
}

const noSleep = async () => undefined;

describe('health.now', () => {
	it('needs only an open link: a --work-only machine answers it (CONTRACTS R-31)', () => {
		expect(fleetLinkVerbConsent(FLEET_HEALTH_NOW_VERB)).toBe('link');
		expect(fleetConsentSatisfies(WORK_ONLY, fleetLinkVerbConsent(FLEET_HEALTH_NOW_VERB))).toBe(true);
	});

	it('answers the probe snapshot, sanitised like the beat', async () => {
		const module = createHealthLinkModule({
			probeHealth: async () => ({ cpuPercent: 31.24, memPercent: 250, cpuCores: 4 })
		});
		const verb = module.machineVerbs![FLEET_HEALTH_NOW_VERB]!;
		expect(verb.stateChanging).toBe(false);
		const result = (await verb.run(context({ verb: FLEET_HEALTH_NOW_VERB, consents: WORK_ONLY }))) as {
			snapshot: Record<string, unknown>;
		};
		// Out-of-range memory is DROPPED, never clamped.
		expect(result.snapshot).toEqual({ cpuPercent: 31.2, cpuCores: 4 });
	});

	it('refuses with operation_failed when no fact could be read', async () => {
		const module = createHealthLinkModule({ probeHealth: async () => null });
		await expect(
			module.machineVerbs![FLEET_HEALTH_NOW_VERB]!.run(context({ verb: FLEET_HEALTH_NOW_VERB }))
		).rejects.toBeInstanceOf(MachineVerbError);
	});

	it('is not registered without a probe', () => {
		expect(createHealthLinkModule({}).machineVerbs?.[FLEET_HEALTH_NOW_VERB]).toBeUndefined();
	});
});

describe('wake.send', () => {
	it('needs manage on the sending machine', () => {
		expect(fleetLinkVerbConsent(FLEET_WAKE_SEND_VERB)).toBe('manage');
		expect(fleetConsentSatisfies(WORK_ONLY, fleetLinkVerbConsent(FLEET_WAKE_SEND_VERB))).toBe(false);
	});

	it('sends 3 packets, each to the limited broadcast and the interface broadcast, on port 9', async () => {
		const sender = recordingSender();
		const module = createHealthLinkModule({ wakeSender: sender, network, sleep: noSleep });
		const verb = module.machineVerbs![FLEET_WAKE_SEND_VERB]!;
		expect(verb.stateChanging).toBe(true);

		// A unicast address: an odd first octet (0x11) is a multicast one, which the normaliser refuses.
		const result = await verb.run(context({ params: { macAddress: '12-22-33-44-55-66' } }));

		expect(result).toEqual({ sent: 3, destinations: 2 });
		expect(sender.sent).toEqual([
			{ address: '255.255.255.255', port: 9 },
			{ address: '192.168.1.255', port: 9 },
			{ address: '255.255.255.255', port: 9 },
			{ address: '192.168.1.255', port: 9 },
			{ address: '255.255.255.255', port: 9 },
			{ address: '192.168.1.255', port: 9 }
		]);
		const packet = (sender.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Uint8Array;
		expect(packet.length).toBe(102);
		expect([...packet.slice(6, 12)]).toEqual([0x12, 0x22, 0x33, 0x44, 0x55, 0x66]);
	});

	it('counts a packet as sent when one destination refused it', async () => {
		const sender = recordingSender(['255.255.255.255']);
		const module = createHealthLinkModule({ wakeSender: sender, network, sleep: noSleep });
		const result = await module.machineVerbs![FLEET_WAKE_SEND_VERB]!.run(
			context({ params: { macAddress: '12:22:33:44:55:66' } })
		);
		expect(result).toEqual({ sent: 3, destinations: 2 });
	});

	it('fails with operation_failed when nothing could be sent', async () => {
		const sender = recordingSender(['255.255.255.255', '192.168.1.255']);
		const module = createHealthLinkModule({ wakeSender: sender, network, sleep: noSleep });
		await expect(
			module.machineVerbs![FLEET_WAKE_SEND_VERB]!.run(context({ params: { macAddress: '12:22:33:44:55:66' } }))
		).rejects.toMatchObject({ error: { code: 'operation_failed' } });
	});

	it.each([
		['a malformed address', 'not-a-mac'],
		['the broadcast address', 'ff:ff:ff:ff:ff:ff'],
		['a missing address', undefined]
	])('refuses %s as invalid without sending anything', async (_label, macAddress) => {
		const sender = recordingSender();
		const module = createHealthLinkModule({ wakeSender: sender, network, sleep: noSleep });
		await expect(
			module.machineVerbs![FLEET_WAKE_SEND_VERB]!.run(context({ params: { macAddress } }))
		).rejects.toMatchObject({ error: { code: 'invalid' } });
		expect(sender.sent).toEqual([]);
	});

	it('refuses to wake itself', async () => {
		const module = createHealthLinkModule({ wakeSender: recordingSender(), network, sleep: noSleep });
		await expect(
			module.machineVerbs![FLEET_WAKE_SEND_VERB]!.run(context({ params: { macAddress: 'aa:bb:cc:dd:ee:f0' } }))
		).rejects.toMatchObject({ error: { code: 'invalid' } });
	});

	it('answers unsupported_on_node without a usable interface', async () => {
		const module = createHealthLinkModule({ wakeSender: recordingSender(), network: () => null, sleep: noSleep });
		await expect(
			module.machineVerbs![FLEET_WAKE_SEND_VERB]!.run(context({ params: { macAddress: '12:22:33:44:55:66' } }))
		).rejects.toMatchObject({ error: { code: 'unsupported_on_node' } });
	});

	it('stops between packets when the request is cancelled', async () => {
		const abort = new AbortController();
		const sender = recordingSender();
		const module = createHealthLinkModule({
			wakeSender: sender,
			network,
			sleep: async () => {
				abort.abort();
			}
		});
		await module.machineVerbs![FLEET_WAKE_SEND_VERB]!.run(
			context({ params: { macAddress: '12:22:33:44:55:66' }, signal: abort.signal })
		);
		expect(sender.sent).toHaveLength(2);
	});
});

describe('the wake tag', () => {
	const environment = (consents: FleetConsents) => ({ consents, platform: 'linux', nodeVersion: '1.0.0' });

	it('is advertised under --manage with an interface and a sender', () => {
		const module = createHealthLinkModule({ wakeSender: recordingSender(), network });
		expect(module.tags!(environment(MANAGE))).toEqual(['wake']);
	});

	it.each([
		['without --manage', { consents: WORK_ONLY, options: { wakeSender: recordingSender(), network } }],
		['without an interface', { consents: MANAGE, options: { wakeSender: recordingSender(), network: () => null } }],
		['without a sender', { consents: MANAGE, options: { network } }]
	])('is not advertised %s', (_label, { consents, options }) => {
		expect(createHealthLinkModule(options).tags!(environment(consents))).toEqual([]);
	});
});
