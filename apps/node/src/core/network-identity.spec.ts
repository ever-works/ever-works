import { describe, expect, it } from 'vitest';
import { hashFleetNetwork, resolveNetworkIdentity, type NetworkInterfaceMap } from './network-identity';

/** Computer health, second phase (FL-03) — the primary interface and its opaque network identity (FR-23). */

const ethernet = {
	address: '192.168.1.42',
	netmask: '255.255.255.0',
	family: 'IPv4',
	mac: 'AA:BB:CC:DD:EE:F0',
	internal: false
};

describe('resolveNetworkIdentity', () => {
	it('reports the primary interface: normalised MAC, hashed network, local broadcast', () => {
		const identity = resolveNetworkIdentity({ eth0: [ethernet] });
		expect(identity).toEqual({
			macAddress: 'aa:bb:cc:dd:ee:f0',
			lanId: hashFleetNetwork('192.168.1.0', 24),
			broadcast: '192.168.1.255'
		});
		expect(identity!.lanId).toMatch(/^[0-9a-f]{16}$/);
	});

	it('never puts the address itself in the identity', () => {
		const identity = resolveNetworkIdentity({ eth0: [ethernet] });
		expect(identity!.lanId).not.toContain('192');
	});

	it('gives two machines on the same network the same identity, and another network a different one', () => {
		const a = resolveNetworkIdentity({ eth0: [ethernet] });
		const b = resolveNetworkIdentity({ eth0: [{ ...ethernet, address: '192.168.1.7', mac: 'aa:bb:cc:dd:ee:01' }] });
		const c = resolveNetworkIdentity({ eth0: [{ ...ethernet, address: '10.0.0.7', netmask: '255.0.0.0' }] });
		expect(a!.lanId).toBe(b!.lanId);
		expect(a!.lanId).not.toBe(c!.lanId);
	});

	it('prefers a physical interface over a container bridge or a VPN tunnel', () => {
		const interfaces: NetworkInterfaceMap = {
			docker0: [{ ...ethernet, address: '172.17.0.1', netmask: '255.255.0.0', mac: '02:42:ac:11:00:01' }],
			tailscale0: [{ ...ethernet, address: '100.64.0.2', netmask: '255.192.0.0', mac: '02:00:00:00:00:02' }],
			en0: [ethernet]
		};
		expect(resolveNetworkIdentity(interfaces)!.macAddress).toBe('aa:bb:cc:dd:ee:f0');
	});

	it('falls back to a virtual-looking interface when it is the only one', () => {
		const identity = resolveNetworkIdentity({
			'vEthernet (Default Switch)': [{ ...ethernet, mac: '00:15:5d:01:02:03' }]
		});
		expect(identity!.macAddress).toBe('00:15:5d:01:02:03');
	});

	it.each([
		['loopback', { ...ethernet, internal: true }],
		['IPv6 only', { ...ethernet, family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::' }],
		['no hardware address', { ...ethernet, mac: '00:00:00:00:00:00' }],
		['link-local (no lease)', { ...ethernet, address: '169.254.10.20', netmask: '255.255.0.0' }],
		['a point-to-point /32', { ...ethernet, netmask: '255.255.255.255' }],
		['a broken netmask', { ...ethernet, netmask: '255.0.255.0' }]
	])('ignores %s', (_label, entry) => {
		expect(resolveNetworkIdentity({ eth0: [entry] })).toBeNull();
	});

	it('accepts the numeric family older Node versions reported', () => {
		expect(resolveNetworkIdentity({ eth0: [{ ...ethernet, family: 4 }] })).not.toBeNull();
	});

	it('answers null for no interfaces', () => {
		expect(resolveNetworkIdentity(null)).toBeNull();
		expect(resolveNetworkIdentity({})).toBeNull();
	});
});
