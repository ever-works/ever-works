/**
 * Fleet computer health (FL-03, second phase) — the two REACH acts and the
 * network identity they stand on (CONTRACTS §1.1, §1.2, §3.3, §4.1, §7,
 * §10.1, R-31):
 *
 *  - **Refresh now** — the platform asks a connected computer for a fresh
 *    health snapshot over the node link (`health.now` on the `machine`
 *    channel), instead of waiting for its next beat. A `view`-family read:
 *    anyone who can see the computer may ask, and it needs no consent beyond
 *    an open link (R-31), so a `--work`-only computer answers too.
 *  - **Wake** — an offline computer is woken by a SIBLING: another online
 *    computer of the same owner on the same network sends the Wake-on-LAN
 *    packet (`wake.send`). The only way an outbound-only fleet can reach a
 *    sleeping machine. A `machines`-family act on the TARGET; the sibling
 *    needs `--manage` (its `wake` tag).
 *
 * ## Network identity, never addresses
 *
 * A `--manage` node reports its primary hardware address (`macAddress`, the
 * one thing a wake packet needs) and an OPAQUE network identity (`lanId`):
 * a short hash of its primary interface's network, never the address
 * itself. The platform re-hashes `lanId` with the owner's id before storing
 * it, so two owners on the same network never share a stored value and
 * siblings are matched within one owner only. The hardware address is
 * stored for the owner's own computers, never shown in full (masked to its
 * last two octets) and never served to anyone but the owner.
 */

import type { FleetNodeStatus } from './fleet-node.types.js';

// ─── Verbs and tags ─────────────────────────────────────────────────────────

/** `machine` verb: answer a fresh health snapshot (CONTRACTS §3.3, R-31: any open link). */
export const FLEET_HEALTH_NOW_VERB = 'health.now';

/** `machine` verb: send a Wake-on-LAN packet on this machine's network (`manage`). */
export const FLEET_WAKE_SEND_VERB = 'wake.send';

/** Capability tag: this node can send Wake-on-LAN on its network (CONTRACTS §1.2, `--manage`). */
export const FLEET_WAKE_CAPABILITY = 'wake';

/** Capability tag `--manage` adds (FL-02); a waking sibling must carry it too. */
export const FLEET_WAKE_SIBLING_REQUIRED_TAGS: readonly string[] = [FLEET_WAKE_CAPABILITY, 'managed'];

// ─── Limits (CONTRACTS §10.1) ───────────────────────────────────────────────

/** Refresh-now requests one computer may receive per {@link FLEET_HEALTH_REFRESH_RATE_WINDOW_MS}. */
export const FLEET_HEALTH_REFRESH_RATE_LIMIT = 10;

export const FLEET_HEALTH_REFRESH_RATE_WINDOW_MS = 60_000;

/** Refresh now answers within this long or `unreachable` (FR-27). */
export const FLEET_HEALTH_REFRESH_TIMEOUT_MS = 3_000;

/** Wake attempts one computer may receive per {@link FLEET_WAKE_RATE_WINDOW_MS} (FR-25). */
export const FLEET_WAKE_RATE_LIMIT = 3;

export const FLEET_WAKE_RATE_WINDOW_MS = 5 * 60_000;

/** After a wake, the platform reports at these instants whether the target has beat (FR-26). */
export const FLEET_WAKE_CHECK_AFTER_MS: readonly number[] = [20_000, 60_000];

/** How long the listener keeps watching after a wake — the last checkpoint. */
export const FLEET_WAKE_LISTEN_MS = 60_000;

/** The UDP port a magic packet goes to (the "discard" port every NIC listens on for it). */
export const FLEET_WAKE_UDP_PORT = 9;

/** Magic packets one `wake.send` sends, spaced {@link FLEET_WAKE_PACKET_SPACING_MS} apart. */
export const FLEET_WAKE_PACKET_COUNT = 3;

export const FLEET_WAKE_PACKET_SPACING_MS = 200;

/** Length of the stored network identity, in hex characters. */
export const FLEET_LAN_ID_LENGTH = 16;

// ─── Hardware address ───────────────────────────────────────────────────────

/** Longest raw input {@link normalizeFleetMacAddress} looks at (bounded before any parsing). */
const MAX_MAC_INPUT_LENGTH = 32;

/**
 * A hardware (MAC) address as `aa:bb:cc:dd:ee:ff`, or null.
 *
 * Accepts `:`, `-` or `.` separators, or none, in either case. Refuses what a
 * wake packet can never use: the all-zero address (a virtual adapter's
 * placeholder), the broadcast address, and a multicast address (the low bit
 * of the first octet — no network card has one).
 */
export function normalizeFleetMacAddress(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MAC_INPUT_LENGTH) return null;
	const hex = value.trim().toLowerCase().replace(/[:.-]/g, '');
	if (!/^[0-9a-f]{12}$/.test(hex)) return null;
	if (hex === '000000000000' || hex === 'ffffffffffff') return null;
	if ((Number.parseInt(hex.slice(0, 2), 16) & 1) === 1) return null;
	return hex.match(/.{2}/g)!.join(':');
}

/** The masked form a page shows: the last two octets only (`••:••:••:••:3f:9a`), or null. */
export function maskFleetMacAddress(value: unknown): string | null {
	const mac = normalizeFleetMacAddress(value);
	if (!mac) return null;
	return `••:••:••:••:${mac.slice(-5)}`;
}

/** The six bytes of a normalised address. */
export function fleetMacAddressBytes(mac: string): Uint8Array | null {
	const normalized = normalizeFleetMacAddress(mac);
	if (!normalized) return null;
	return Uint8Array.from(normalized.split(':').map((octet) => Number.parseInt(octet, 16)));
}

/**
 * The 102-byte Wake-on-LAN "magic packet": six `0xff` bytes, then the
 * target's six-byte address sixteen times. Null for an address
 * {@link normalizeFleetMacAddress} refuses.
 */
export function buildFleetWakePacket(mac: string): Uint8Array | null {
	const bytes = fleetMacAddressBytes(mac);
	if (!bytes) return null;
	const packet = new Uint8Array(6 + 16 * 6);
	packet.fill(0xff, 0, 6);
	for (let repeat = 0; repeat < 16; repeat += 1) packet.set(bytes, 6 + repeat * 6);
	return packet;
}

// ─── Network identity ───────────────────────────────────────────────────────

/** A reported or stored network identity: lowercase hex, 16 to 64 characters, or null. */
export function normalizeFleetLanId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const id = value.trim().toLowerCase();
	return /^[0-9a-f]{16,64}$/.test(id) ? id : null;
}

// ─── Wake: who can do it ────────────────────────────────────────────────────

/** The sibling a wake goes through. */
export interface FleetWakeRoute {
	nodeId: string;
	name: string;
}

/**
 * Why Wake is not offered (spec §5.5, U4, U6, U7). Each maps to one sentence:
 *
 *  - `not-offline` — the computer is not asleep (nothing to wake);
 *  - `no-hardware-address` — it never reported one (not started with `--manage`, or an older node);
 *  - `no-sibling` — no online computer of the owner on its network advertises `wake`;
 *  - `rate-limited` — already tried {@link FLEET_WAKE_RATE_LIMIT} times in the window;
 *  - `not-allowed` — the viewer is outside the `machines` family on it;
 *  - `kill-switch` — live actions are paused while all computers are stopped.
 */
export type FleetWakeUnavailableReason =
	| 'not-offline'
	| 'no-hardware-address'
	| 'no-sibling'
	| 'rate-limited'
	| 'not-allowed'
	| 'kill-switch';

export const FLEET_WAKE_UNAVAILABLE_REASONS: readonly FleetWakeUnavailableReason[] = [
	'not-offline',
	'no-hardware-address',
	'no-sibling',
	'rate-limited',
	'not-allowed',
	'kill-switch'
];

/** Whether Wake is offered to THIS viewer, and why not. Part of the health read. */
export interface FleetNodeWakeAvailability {
	available: boolean;
	/** Null when available. */
	reason: FleetWakeUnavailableReason | null;
	/** The sibling it would go through — the owner only (a shared viewer never learns the owner's other machines). */
	via: FleetWakeRoute | null;
	/** The last wake attempt on this computer, by anyone. */
	lastWakeAttemptAt: string | null;
}

/** A computer as sibling selection reads it — a structural subset of a node row or view. */
export interface FleetWakeCandidate {
	id: string;
	name: string;
	status: FleetNodeStatus;
	lastHeartbeatAt?: string | Date | null;
	capabilities?: readonly string[] | null;
	lanId?: string | null;
}

function beatMs(value: string | Date | null | undefined): number {
	if (value instanceof Date) return value.getTime();
	return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/**
 * Is this computer asleep, as far as the platform can tell? Offline by status,
 * or silent for longer than the offline window (the sweep only runs on the
 * owner's list read). A row that never beat is `enrolling`, never asleep.
 */
export function isFleetNodeAsleep(
	node: Pick<FleetWakeCandidate, 'status' | 'lastHeartbeatAt'>,
	now: number,
	offlineAfterMs: number
): boolean {
	if (node.status === 'enrolling') return false;
	if (node.status === 'offline') return true;
	const at = beatMs(node.lastHeartbeatAt);
	if (!Number.isFinite(at)) return false;
	return now - at > offlineAfterMs;
}

/**
 * The siblings that can wake `target`, best first: the same owner (the
 * caller passes only the owner's computers), the same network identity, not
 * the target, online by status AND by its last beat, and advertising both
 * `wake` and `managed`. Ordered by the most recent beat.
 */
export function selectFleetWakeSiblings<T extends FleetWakeCandidate>(
	target: Pick<FleetWakeCandidate, 'id' | 'lanId'>,
	candidates: readonly T[],
	options: { now: number; offlineAfterMs: number }
): T[] {
	const lanId = normalizeFleetLanId(target.lanId);
	if (!lanId) return [];
	return candidates
		.filter((candidate) => {
			if (candidate.id === target.id) return false;
			if (normalizeFleetLanId(candidate.lanId) !== lanId) return false;
			if (candidate.status !== 'online') return false;
			const at = beatMs(candidate.lastHeartbeatAt);
			if (!Number.isFinite(at) || options.now - at > options.offlineAfterMs) return false;
			const tags = Array.isArray(candidate.capabilities) ? candidate.capabilities : [];
			return FLEET_WAKE_SIBLING_REQUIRED_TAGS.every((tag) => tags.includes(tag));
		})
		.sort((a, b) => beatMs(b.lastHeartbeatAt) - beatMs(a.lastHeartbeatAt));
}

/**
 * The machine-side reason Wake cannot be offered, in the order the owner can
 * act on it (spec FR-24): not asleep → no hardware address → no sibling.
 * Null when a wake is possible. The viewer-side reasons (`not-allowed`,
 * `kill-switch`, `rate-limited`) are the platform's to add.
 */
export function fleetWakeBlocker(
	target: Pick<FleetWakeCandidate, 'status' | 'lastHeartbeatAt'> & { hasHardwareAddress: boolean },
	siblings: readonly unknown[],
	options: { now: number; offlineAfterMs: number }
): Extract<FleetWakeUnavailableReason, 'not-offline' | 'no-hardware-address' | 'no-sibling'> | null {
	if (!isFleetNodeAsleep(target, options.now, options.offlineAfterMs)) return 'not-offline';
	if (!target.hasHardwareAddress) return 'no-hardware-address';
	if (siblings.length === 0) return 'no-sibling';
	return null;
}

// ─── Wake: the act and its answer ───────────────────────────────────────────

/** `POST /api/fleet/nodes/:id/wake` — 202: the packet went out through `via`. */
export interface FleetNodeWakeResult {
	nodeId: string;
	via: FleetWakeRoute;
	/** When the platform asked the sibling (the platform's clock). */
	sentAt: string;
	/** The listener watches for the target's next beat until then (FR-26). */
	listenUntil: string;
	/** When the page should ask again: {@link FLEET_WAKE_CHECK_AFTER_MS}. */
	checkAfterMs: readonly number[];
}

/** `GET /api/fleet/nodes/:id/wake` — has the target answered the last wake (FR-26)? */
export interface FleetNodeWakeStatus {
	nodeId: string;
	lastWakeAttemptAt: string | null;
	lastHeartbeatAt: string | null;
	/** The target beat AFTER the last wake attempt. */
	answered: boolean;
	/** Still inside the listening window of the last attempt. */
	listening: boolean;
}

/** Did the computer beat after the wake? Pure, so the page and the API agree. */
export function fleetWakeAnswered(
	lastWakeAttemptAt: string | Date | null | undefined,
	lastHeartbeatAt: string | Date | null | undefined
): boolean {
	const wokeAt = beatMs(lastWakeAttemptAt ?? null);
	const beatAt = beatMs(lastHeartbeatAt ?? null);
	return Number.isFinite(wokeAt) && Number.isFinite(beatAt) && beatAt > wokeAt;
}

/** The `wake.send` request a sibling receives. */
export interface FleetWakeSendParams {
	macAddress: string;
}

/** What a sibling answers to `wake.send`. */
export interface FleetWakeSendResult {
	/** Packets sent. */
	sent: number;
	/** How many destinations each packet went to (the limited broadcast and the interface's own). */
	destinations: number;
}

/** What a node answers to `health.now`: a snapshot shaped like the heartbeat's `health` (sanitised by the platform). */
export interface FleetHealthNowResult {
	snapshot: unknown;
}

// ─── Refresh now: who can do it ─────────────────────────────────────────────

/**
 * Why Refresh now is not offered (spec §5.6, U1, U2, U5):
 *
 *  - `offline` — the computer is offline;
 *  - `no-link` — no consent able to open a link (`--work`, `--attend`, `--manage`);
 *  - `not-connected` — it could have a link, but none is open right now;
 *  - `kill-switch` — live actions are paused;
 *  - `link-disabled` — this deployment does not accept node links.
 */
export type FleetHealthRefreshUnavailableReason =
	| 'offline'
	| 'no-link'
	| 'not-connected'
	| 'kill-switch'
	| 'link-disabled';

export interface FleetHealthRefreshAvailability {
	available: boolean;
	reason: FleetHealthRefreshUnavailableReason | null;
}
