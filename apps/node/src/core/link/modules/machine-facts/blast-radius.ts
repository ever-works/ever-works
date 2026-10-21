import {
	fleetBlastRadiusSentence,
	type FleetBlastRadius,
	type FleetBlastRadiusKind,
	type FleetServiceManager
} from '@ever-works/contracts';

/**
 * Machine facts (FL-09, spec FR-5, CONTRACTS §2.2) — what stopping,
 * restarting or disabling a service could cut Ever Works off from.
 *
 * One truth table per OS, as data: a person extends it without touching
 * code. It errs on the side of warning (plan §15): a service that MIGHT carry
 * the machine's way to Ever Works is named, because the cost of one extra
 * red sentence is a second's reading and the cost of a missing one is a
 * drive to the machine.
 *
 * The node's own service is always `node`: matched by the unit / label /
 * Windows service names the node is installed under, and by pid — a service
 * whose main process is this node (or one of its ancestors) is the node,
 * whatever it is called.
 */

interface BlastRadiusRule {
	kind: FleetBlastRadiusKind;
	pattern: RegExp;
}

/** Linux (systemd unit names, without `.service`). */
const LINUX_RULES: readonly BlastRadiusRule[] = [
	{ kind: 'node', pattern: /^ever-works-node(@.*)?$/i },
	{
		kind: 'network',
		pattern:
			/^(NetworkManager|NetworkManager-wait-online|systemd-networkd|systemd-networkd-wait-online|systemd-resolved|networking|network|wicked|connman|dhcpcd|dhclient|wpa_supplicant|iwd|netplan-.+|ifup@.+|ModemManager|avahi-daemon)$/
	},
	{ kind: 'ssh', pattern: /^(ssh|sshd|openssh-server|openssh|dropbear|xrdp|vncserver@.*|x11vnc)$/ },
	{
		kind: 'vpn',
		pattern:
			/^(tailscaled|zerotier-one|netbird|nebula|openvpn(@.*)?|openvpn-client@.+|openvpn-server@.+|wg-quick@.+|wireguard.*|cloudflared.*|strongswan.*|ipsec|headscale|twingate.*)$/
	}
];

/** Linux units that matter only when the machine hosts child computers (FL-16). */
const LINUX_DOCKER_RULE: BlastRadiusRule = { kind: 'docker', pattern: /^(docker|containerd|docker\.socket|podman)$/ };

/** macOS (launchd labels, Homebrew formula names). */
const MAC_RULES: readonly BlastRadiusRule[] = [
	{ kind: 'node', pattern: /ever-?works[.-]?node|node\.ever-?works/i },
	{
		kind: 'network',
		pattern: /^com\.apple\.(configd|mDNSResponder|mDNSResponderHelper|networkd|airportd|wifid|wifivelocityd|netbiosd|symptomsd)$/
	},
	{ kind: 'ssh', pattern: /^(com\.openssh\.sshd|com\.apple\.screensharing|com\.apple\.RemoteDesktop.*)$/ },
	{ kind: 'vpn', pattern: /tailscale|zerotier|wireguard|netbird|nebula|openvpn|cloudflared|twingate/i }
];

const MAC_DOCKER_RULE: BlastRadiusRule = { kind: 'docker', pattern: /^(com\.docker\..+|docker|colima)$/i };

/** Windows (service names). */
const WINDOWS_RULES: readonly BlastRadiusRule[] = [
	{ kind: 'node', pattern: /^EverWorksNode/i },
	{ kind: 'network', pattern: /^(Dnscache|Dhcp|NlaSvc|netprofm|Netman|WlanSvc|nsi|Wcmsvc|iphlpsvc|BFE|WinHttpAutoProxySvc)$/i },
	{ kind: 'ssh', pattern: /^(sshd|TermService|WinRM)$/i },
	{
		kind: 'vpn',
		pattern: /^(Tailscale|ZeroTierOneService|WireGuardTunnel\$.+|WireGuardManager|OpenVPNService.*|netbird|cloudflared|Twingate.*)$/i
	}
];

const WINDOWS_DOCKER_RULE: BlastRadiusRule = { kind: 'docker', pattern: /^(com\.docker\.service|docker)$/i };

export interface BlastRadiusContext {
	/** `process.platform`. */
	platform: string;
	/** The machine's name, as the sentence says it. */
	machine: string;
	/** This node's pid and its ancestors: a service whose main pid is one of them is the node. */
	nodePids: readonly number[];
	/** Extra names this node is installed under (a custom unit or Windows service name). */
	nodeServiceNames?: readonly string[];
	/** True when Containers on this machine are computers in the Fleet (FL-16): Docker becomes a blast radius. */
	hostsChildNodes?: boolean;
}

function rulesFor(context: BlastRadiusContext): readonly BlastRadiusRule[] {
	if (context.platform === 'win32') {
		return context.hostsChildNodes ? [...WINDOWS_RULES, WINDOWS_DOCKER_RULE] : WINDOWS_RULES;
	}
	if (context.platform === 'darwin') {
		return context.hostsChildNodes ? [...MAC_RULES, MAC_DOCKER_RULE] : MAC_RULES;
	}
	return context.hostsChildNodes ? [...LINUX_RULES, LINUX_DOCKER_RULE] : LINUX_RULES;
}

/** The unit name the table matches (systemd's `.service` suffix dropped; Homebrew's launchd prefix dropped). */
export function normalizeServiceName(name: string, manager: FleetServiceManager): string {
	if (manager === 'systemd') return name.replace(/\.service$/, '');
	if (manager === 'brew') return name.replace(/^homebrew\.mxcl\./, '');
	return name;
}

/** The blast radius of taking this service away, or null when it carries nothing Ever Works needs. */
export function serviceBlastRadius(
	service: { name: string; manager: FleetServiceManager; pid?: number | null },
	context: BlastRadiusContext
): FleetBlastRadius | null {
	const kind = serviceBlastRadiusKind(service, context);
	return kind ? { kind, sentence: fleetBlastRadiusSentence(kind, context.machine) } : null;
}

export function serviceBlastRadiusKind(
	service: { name: string; manager: FleetServiceManager; pid?: number | null },
	context: BlastRadiusContext
): FleetBlastRadiusKind | null {
	if (isNodeService(service, context)) return 'node';
	const name = normalizeServiceName(service.name, service.manager);
	for (const rule of rulesFor(context)) {
		if (rule.kind === 'node') continue;
		if (rule.pattern.test(name)) return rule.kind;
	}
	return null;
}

/** True for the Ever Works node's own service (U10: a `⚠ this node` marker, no buttons). */
export function isNodeService(
	service: { name: string; manager: FleetServiceManager; pid?: number | null },
	context: BlastRadiusContext
): boolean {
	if (typeof service.pid === 'number' && service.pid > 0 && context.nodePids.includes(service.pid)) return true;
	const name = normalizeServiceName(service.name, service.manager);
	const extra = context.nodeServiceNames ?? [];
	if (extra.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) return true;
	const nodeRule = rulesFor(context).find((rule) => rule.kind === 'node');
	return nodeRule ? nodeRule.pattern.test(name) : false;
}
