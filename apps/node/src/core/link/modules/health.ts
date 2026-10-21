import {
	buildFleetWakePacket,
	FLEET_HEALTH_NOW_VERB,
	FLEET_WAKE_CAPABILITY,
	FLEET_WAKE_PACKET_COUNT,
	FLEET_WAKE_PACKET_SPACING_MS,
	FLEET_WAKE_SEND_VERB,
	FLEET_WAKE_UDP_PORT,
	makeFleetLinkError,
	normalizeFleetMacAddress,
	sanitizeFleetNodeHealthSnapshot,
	type FleetHealthNowResult,
	type FleetNodeHealthSnapshot,
	type FleetWakeSendResult
} from '@ever-works/contracts';
import type { LocalNetworkIdentity } from '../../network-identity';
import { MachineVerbError, type MachineVerb, type NodeModule } from './registry';

/**
 * Fleet node link — the `health` module (FL-03, second phase; CONTRACTS §1.2,
 * §3.3, R-31). Two `machine` verbs and one tag:
 *
 *  - **`health.now`** — answer a fresh health snapshot (Refresh now). A read:
 *    its consent is `link` (`FLEET_LINK_VERB_CONSENT_OVERRIDES`), so a
 *    `--work`- or `--attend`-only machine answers it too, and the kill switch
 *    never refuses it — the switch stops actions, not observation (spec U5).
 *    The snapshot is the heartbeat's own probe, sanitised the same way, so a
 *    refresh and a beat can never disagree about what a field means. It does
 *    not touch the heartbeat cadence (FR-28).
 *  - **`wake.send { macAddress }`** — send the Wake-on-LAN magic packet for a
 *    sibling on THIS machine's network: {@link FLEET_WAKE_PACKET_COUNT}
 *    packets, {@link FLEET_WAKE_PACKET_SPACING_MS} apart, each to the limited
 *    broadcast and to this interface's own directed broadcast, UDP port
 *    {@link FLEET_WAKE_UDP_PORT}. Its consent is `manage` (the machine channel
 *    checks it before this runs), it changes the world, so the kill switch
 *    refuses it. The address is validated here whatever the platform sent; the
 *    destinations are computed HERE from this machine's own interface — the
 *    platform cannot aim a packet anywhere else.
 *  - **`wake` tag** — advertised under `--manage` when this machine has a
 *    primary interface a wake can go out on and a sender is wired.
 */

/** Sends one UDP datagram with broadcast enabled. `node-io.ts` binds `node:dgram`. */
export interface WakeSender {
	send(packet: Uint8Array, address: string, port: number): Promise<void>;
}

export interface HealthLinkModuleOptions {
	/** The heartbeat's health probe (one per process). Absent: `health.now` is not registered. */
	probeHealth?: () => Promise<FleetNodeHealthSnapshot | null> | FleetNodeHealthSnapshot | null;
	/** This machine's primary interface, read fresh per call (a laptop changes networks). */
	network?: () => LocalNetworkIdentity | null;
	/** The datagram sender. Absent: `wake.send` is not registered and `wake` not advertised. */
	wakeSender?: WakeSender;
	/** Test seam for the spacing between packets. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const LIMITED_BROADCAST = '255.255.255.255';

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function readNetwork(options: HealthLinkModuleOptions): LocalNetworkIdentity | null {
	try {
		return options.network?.() ?? null;
	} catch {
		return null;
	}
}

export function createHealthLinkModule(options: HealthLinkModuleOptions): NodeModule {
	const sleep = options.sleep ?? defaultSleep;
	const verbs: Record<string, MachineVerb> = {};

	if (options.probeHealth) {
		const probe = options.probeHealth;
		verbs[FLEET_HEALTH_NOW_VERB] = {
			stateChanging: false,
			run: async (): Promise<FleetHealthNowResult> => {
				let raw: FleetNodeHealthSnapshot | null = null;
				try {
					raw = await probe();
				} catch {
					raw = null;
				}
				const snapshot = sanitizeFleetNodeHealthSnapshot(raw);
				if (!snapshot) {
					throw new MachineVerbError(
						makeFleetLinkError('operation_failed', 'no health fact could be read on this machine')
					);
				}
				return { snapshot };
			}
		};
	}

	if (options.wakeSender) {
		const sender = options.wakeSender;
		verbs[FLEET_WAKE_SEND_VERB] = {
			stateChanging: true,
			run: async (context): Promise<FleetWakeSendResult> => {
				const mac = normalizeFleetMacAddress(context.params.macAddress);
				const packet = mac ? buildFleetWakePacket(mac) : null;
				if (!mac || !packet) {
					throw new MachineVerbError(makeFleetLinkError('invalid', 'macAddress', { field: 'macAddress' }));
				}
				const network = readNetwork(options);
				if (!network) {
					throw new MachineVerbError(
						makeFleetLinkError(
							'unsupported_on_node',
							`${context.nodeName} has no network interface a wake packet can go out on`
						)
					);
				}
				if (network.macAddress === mac) {
					throw new MachineVerbError(makeFleetLinkError('invalid', 'a computer cannot wake itself'));
				}
				const destinations = [...new Set([LIMITED_BROADCAST, network.broadcast])];
				let sent = 0;
				let lastError: unknown = null;
				for (let attempt = 0; attempt < FLEET_WAKE_PACKET_COUNT; attempt += 1) {
					if (attempt > 0) await sleep(FLEET_WAKE_PACKET_SPACING_MS, context.signal);
					if (context.signal.aborted) break;
					let delivered = false;
					for (const address of destinations) {
						try {
							await sender.send(packet, address, FLEET_WAKE_UDP_PORT);
							delivered = true;
						} catch (error) {
							lastError = error;
						}
					}
					if (delivered) sent += 1;
				}
				if (sent === 0) {
					const message = lastError instanceof Error ? lastError.message : 'the packet could not be sent';
					throw new MachineVerbError(makeFleetLinkError('operation_failed', message.split(/\r?\n/, 1)[0]!));
				}
				return { sent, destinations: destinations.length };
			}
		};
	}

	return {
		id: 'health',
		tags: (environment) => {
			if (!environment.consents.manage || !options.wakeSender) return [];
			return readNetwork(options) ? [FLEET_WAKE_CAPABILITY] : [];
		},
		machineVerbs: verbs
	};
}
