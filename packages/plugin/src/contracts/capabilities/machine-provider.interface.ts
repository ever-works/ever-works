import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Cloud computers (FL-17, CONTRACTS R-15) — the `machine-provider` capability.
 *
 * A machine provider creates, powers and destroys machines at a cloud
 * provider on the owner's own account, and says what they cost. The platform
 * never names a provider: it resolves every plugin that declares this
 * capability through `MachineProviderFacadeService` and lists what the
 * facade returns (Constitution I/II).
 *
 * What the platform hands a provider, and what it never does:
 *
 *  - a **bootstrap script** the platform generated (`#cloud-config` user
 *    data). It installs the node runtime and enrols the machine with a
 *    one-time, 15-minute token; the provider passes it through untouched and
 *    MUST NOT log it.
 *  - optionally a **throwaway public key**, so a provider that would otherwise
 *    email a root password does not. Its private half was discarded by the
 *    platform before the call; the provider MUST NOT ask for one.
 *  - **tags**, at least `ever-works` and `ever-works-node:<nodeId>`, which the
 *    provider MUST attach to the machine so reconciliation can recognise it.
 *
 * Prices are integers in **cents** (USD unless the provider says otherwise in
 * `currency`) and are the provider's LIST prices: estimates, never a bill.
 *
 * Every method receives the per-call resolved settings (Work > User > Admin >
 * plugin defaults) from the facade; the provider token lives there as an
 * `x-secret` user-scope setting and never anywhere else.
 */

/** Machine-provider capability id (`PLUGIN_CAPABILITIES.MACHINE_PROVIDER`). */
export const MACHINE_PROVIDER_CAPABILITY = 'machine-provider' as const;

/** The software a bootstrap can preinstall (spec FR-3). The overlay-VPN client's key arrives in P3. */
export type MachineProviderSoftwareId = 'docker' | 'node' | 'claude-code' | 'codex' | 'overlay-vpn';

export const MACHINE_PROVIDER_SOFTWARE_IDS: readonly MachineProviderSoftwareId[] = [
	'docker',
	'node',
	'claude-code',
	'codex',
	'overlay-vpn'
];

export function isMachineProviderSoftwareId(value: unknown): value is MachineProviderSoftwareId {
	return typeof value === 'string' && (MACHINE_PROVIDER_SOFTWARE_IDS as readonly string[]).includes(value);
}

/** One region the account may create machines in. */
export interface MachineProviderRegion {
	/** The provider's own slug (`nyc3`). */
	id: string;
	/** Human label (`New York 3`). */
	label: string;
	/** False when the provider currently refuses new machines there. */
	available: boolean;
}

/** One size, with its list prices. */
export interface MachineProviderSize {
	/** The provider's own slug (`s-2vcpu-4gb`). */
	id: string;
	/** Human label (`2 CPU · 4 GB · 80 GB`). */
	label: string;
	vcpus: number;
	memoryMiB: number;
	diskGiB: number;
	/** List price per hour, in cents — may be fractional (`3.571` = $0.03571/h). */
	priceHourlyCents: number;
	/** List price per month, in whole cents (the cap a month of use never exceeds). */
	priceMonthlyCents: number;
	/** Region ids this size can be created in. */
	regions: string[];
	/** False when the provider no longer offers it. */
	available: boolean;
}

/** A software preset the provider can install (the bootstrap does the installing). */
export interface MachineProviderSoftware {
	id: MachineProviderSoftwareId;
	/** Ticked by default in the dialog (docker, node, claude-code, codex — spec FR-3). */
	default: boolean;
}

/** Everything the New cloud computer dialog needs for one provider + account. */
export interface MachineProviderOptions {
	regions: MachineProviderRegion[];
	sizes: MachineProviderSize[];
	software: MachineProviderSoftware[];
	/** True when the provider bills a powered-off machine at its size (spec FR-16). */
	billsWhileOff: boolean;
	/** ISO-4217 currency of every price (default `USD`). */
	currency?: string;
	/** The account the token belongs to, as a label (`acme`); never a credential. */
	account: { label: string };
	/** The operating-system image the provider boots (`Ubuntu 24.04 LTS`). */
	imageLabel?: string;
}

/** What the platform asks a provider to create. */
export interface MachineProviderCreateInput {
	/** The machine's name (also the Fleet Node's name). */
	name: string;
	regionId: string;
	sizeId: string;
	/** The platform-generated first-boot script (user data). Never logged. */
	bootstrapScript: string;
	/** A throwaway OpenSSH public key whose private half no one keeps (spec FR-9). */
	publicKey?: string;
	/** At least `ever-works` and `ever-works-node:<nodeId>` (spec FR-10). */
	tags: string[];
}

/** The state of a machine at its provider. */
export type MachineProviderMachineState = 'provisioning' | 'running' | 'off' | 'gone';

export interface MachineProviderMachine {
	/** The provider's own id for the machine. */
	machineRef: string;
	state: MachineProviderMachineState;
	/** Public IPv4 address, when the provider reports one (shown, never connected to). */
	ipv4?: string | null;
	/** The tags the provider holds for it (reconciliation reads the Node id from them). */
	tags?: string[];
	/** The machine's name at the provider. */
	name?: string;
	/** When the provider says it was created (ISO-8601). */
	createdAt?: string | null;
}

/** What `create` answers. */
export interface MachineProviderCreateResult {
	machineRef: string;
	state: MachineProviderMachineState;
	/** Small, non-secret facts the platform may keep (`ipv4`, the image). */
	meta?: Record<string, string | number | boolean | null>;
}

/** What the provider itself says the account has spent (P2). */
export interface MachineProviderUsage {
	/** The provider's own month-to-date figure, in cents, when the token can read it. */
	providerMonthToDateCents?: number;
	source: 'provider';
}

/**
 * A typed provider refusal: the facade maps it to `operation_failed` with
 * `hint` as the person-readable first line (spec U2 — "droplet limit reached
 * for this account"). `code` is a short machine word (`unauthorized`,
 * `quota`, `not_found`, `rate_limited`, `invalid`, `unavailable`).
 */
export class MachineProviderError extends Error {
	readonly code: string;
	readonly hint: string;
	readonly status?: number;

	constructor(code: string, hint: string, status?: number) {
		super(hint);
		this.name = 'MachineProviderError';
		this.code = code;
		this.hint = hint;
		this.status = status;
	}
}

export function isMachineProviderError(value: unknown): value is MachineProviderError {
	return (
		value instanceof MachineProviderError ||
		(typeof value === 'object' &&
			value !== null &&
			(value as { name?: unknown }).name === 'MachineProviderError' &&
			typeof (value as { hint?: unknown }).hint === 'string')
	);
}

/**
 * Capability: `'machine-provider'`.
 *
 * Every method that changes something is idempotent by `machineRef` (a destroy
 * of a machine that is already gone resolves; a power-off of an off machine
 * resolves). Reads are side-effect free.
 */
export interface IMachineProviderPlugin extends IPlugin {
	/** Provider display name (`DigitalOcean`). User copy only — core code never branches on it. */
	readonly providerName: string;

	/** True when the settings carry what the provider needs (a token, or a completed sign-in). */
	isConfigured(settings?: PluginSettings): boolean;

	/** Regions, sizes with list prices, software presets and the account label. */
	listOptions(settings?: PluginSettings): Promise<MachineProviderOptions>;

	/** Create the machine. MUST attach every tag and pass the bootstrap through untouched. */
	create(input: MachineProviderCreateInput, settings?: PluginSettings): Promise<MachineProviderCreateResult>;

	/** Graceful power-off (`off`) or power-on (`on`). Resolves once the provider accepted it. */
	power(machineRef: string, action: 'on' | 'off', settings?: PluginSettings): Promise<void>;

	/** Delete the machine and its disk. A machine that is already gone resolves. */
	destroy(machineRef: string, settings?: PluginSettings): Promise<void>;

	/** The machine as the provider knows it; `state: 'gone'` when it no longer exists. */
	getMachine(machineRef: string, settings?: PluginSettings): Promise<MachineProviderMachine>;

	/** Every machine at the provider carrying `tag` (reconciliation, P1 minimal / P3 full). */
	listTagged(tag: string, settings?: PluginSettings): Promise<MachineProviderMachine[]>;

	/** The provider's own month-to-date spend, where the token can read it (P2). */
	usage?(machineRefs: readonly string[], settings?: PluginSettings): Promise<MachineProviderUsage>;
}

/** Type guard for machine-provider plugins. */
export function isMachineProviderPlugin(plugin: IPlugin): plugin is IMachineProviderPlugin {
	return Array.isArray(plugin.capabilities) && plugin.capabilities.includes(MACHINE_PROVIDER_CAPABILITY);
}
