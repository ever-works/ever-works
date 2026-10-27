import { createHash } from 'node:crypto';
import { FLEET_LAN_ID_LENGTH, normalizeFleetMacAddress } from '@ever-works/contracts';

/**
 * Computer health (FL-03, second phase) — this machine's network identity:
 * the hardware address of its primary interface (what a Wake-on-LAN packet
 * needs) and an OPAQUE identity of the network that interface is on, so the
 * platform can match siblings on the same network without ever storing an
 * address (spec FR-23, CONTRACTS §1.1).
 *
 * Pure over the shape `os.networkInterfaces()` returns, so every rule here is
 * tested with fixtures; `node-io.ts` binds the real call.
 *
 * ## Which interface is "primary"
 *
 * The first IPv4, non-internal interface with a real hardware address whose
 * name does not look like a virtual adapter (container bridges, VPN tunnels,
 * hypervisor host-only networks): a wake packet sent on a container bridge
 * reaches nothing. When only virtual-looking interfaces exist, the first of
 * them is used rather than nothing.
 *
 * ## What leaves the machine
 *
 * `macAddress` (validated) and `lanId` = the first 16 hex characters of
 * `sha256("ever-works-lan/v1\n" + <network address>/<prefix length>)`. The
 * interface's own address, its name and the broadcast address never do; the
 * broadcast address is used only HERE, by `wake.send`, to send the packet.
 */

/** One address entry, as `os.networkInterfaces()` reports it. */
export interface NetworkInterfaceEntry {
	address: string;
	netmask: string;
	family: string | number;
	mac: string;
	internal: boolean;
	cidr?: string | null;
}

export type NetworkInterfaceMap = Readonly<Record<string, readonly NetworkInterfaceEntry[] | undefined>>;

/** What the heartbeat carries. */
export interface ReportedNetworkIdentity {
	macAddress: string;
	lanId: string;
}

/** What this machine knows about its primary interface — the broadcast stays local. */
export interface LocalNetworkIdentity extends ReportedNetworkIdentity {
	/** The interface's IPv4 directed broadcast address (`192.168.1.255`), used by `wake.send` only. */
	broadcast: string;
}

/** Interface names that are virtual adapters on Linux, macOS and Windows. */
const VIRTUAL_INTERFACE_PATTERN =
	/^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|cali|cilium|kube|tun|tap|utun|wg|tailscale|zt|ham|awdl|llw|anpi|bridge|gif|stf|ppp|ipsec|vEthernet|VirtualBox|VMware|Hyper-V|Npcap|Loopback)/i;

function isIpv4(entry: NetworkInterfaceEntry): boolean {
	// Node ≤ 17 reported the family as a number on some platforms.
	return entry.family === 'IPv4' || entry.family === 4;
}

function parseIpv4(address: string): number[] | null {
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function prefixLength(mask: number[]): number | null {
	let bits = 0;
	let seenZero = false;
	for (const octet of mask) {
		for (let bit = 7; bit >= 0; bit -= 1) {
			const set = (octet >> bit) & 1;
			if (set === 1 && seenZero) return null; // not a contiguous mask
			if (set === 1) bits += 1;
			else seenZero = true;
		}
	}
	return bits;
}

/** A usable primary-interface candidate, with its network and broadcast addresses. */
interface Candidate {
	name: string;
	mac: string;
	network: string;
	prefix: number;
	broadcast: string;
}

function toCandidate(name: string, entry: NetworkInterfaceEntry): Candidate | null {
	if (entry.internal || !isIpv4(entry)) return null;
	const mac = normalizeFleetMacAddress(entry.mac);
	if (!mac) return null;
	const address = parseIpv4(entry.address);
	const mask = parseIpv4(entry.netmask);
	if (!address || !mask) return null;
	const prefix = prefixLength(mask);
	// A /31 or /32 has no broadcast to wake on; a /0 is not a network.
	if (prefix === null || prefix === 0 || prefix > 30) return null;
	// Link-local (169.254/16): an interface that never got a lease.
	if (address[0] === 169 && address[1] === 254) return null;
	const network = address.map((octet, index) => octet & mask[index]!);
	const broadcast = address.map((octet, index) => (octet & mask[index]!) | (~mask[index]! & 0xff));
	return { name, mac, network: network.join('.'), prefix, broadcast: broadcast.join('.') };
}

/** The opaque identity of a network: `sha256("ever-works-lan/v1\n" + cidr)`, first 16 hex characters. */
export function hashFleetNetwork(network: string, prefix: number): string {
	return createHash('sha256')
		.update(`ever-works-lan/v1\n${network}/${prefix}`)
		.digest('hex')
		.slice(0, FLEET_LAN_ID_LENGTH);
}

/**
 * This machine's primary interface identity, or null when it has none a wake
 * could use (no IPv4 interface with a real hardware address).
 */
export function resolveNetworkIdentity(
	interfaces: NetworkInterfaceMap | null | undefined
): LocalNetworkIdentity | null {
	if (!interfaces) return null;
	const physical: Candidate[] = [];
	const virtual: Candidate[] = [];
	for (const [name, entries] of Object.entries(interfaces)) {
		for (const entry of entries ?? []) {
			const candidate = toCandidate(name, entry);
			if (!candidate) continue;
			(VIRTUAL_INTERFACE_PATTERN.test(name) ? virtual : physical).push(candidate);
		}
	}
	const chosen = physical[0] ?? virtual[0];
	if (!chosen) return null;
	return {
		macAddress: chosen.mac,
		lanId: hashFleetNetwork(chosen.network, chosen.prefix),
		broadcast: chosen.broadcast
	};
}
