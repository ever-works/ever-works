import type { FleetBlastRadius, FleetConfirmationClass, FleetRootRequirement } from './fleet-machine-actions.types.js';

/**
 * Services on computers (FL-09 P1, spec §4.1) — what a machine's service
 * manager reports, as the node lists it over the link (`services.list`) and
 * the platform returns it (`GET /api/fleet/nodes/:id/services`).
 *
 * Read from the Node, never stored (README §1): no table holds a service.
 */

/** Capability tag a node advertises when it found a service manager it understands (CONTRACTS §1.2). */
export const FLEET_SERVICES_CAPABILITY = 'services';

export const FLEET_SERVICE_MANAGERS = ['systemd', 'launchd', 'brew', 'windows'] as const;

export type FleetServiceManager = (typeof FLEET_SERVICE_MANAGERS)[number];

export function isFleetServiceManager(value: unknown): value is FleetServiceManager {
	return typeof value === 'string' && (FLEET_SERVICE_MANAGERS as readonly string[]).includes(value);
}

/** `system` services run for the machine; `user` ones for the node's own user (systemd `--user`, launchd gui domain). */
export const FLEET_SERVICE_SCOPES = ['system', 'user'] as const;

export type FleetServiceScope = (typeof FLEET_SERVICE_SCOPES)[number];

export function isFleetServiceScope(value: unknown): value is FleetServiceScope {
	return typeof value === 'string' && (FLEET_SERVICE_SCOPES as readonly string[]).includes(value);
}

export const FLEET_SERVICE_STATES = ['running', 'failed', 'inactive', 'activating', 'deactivating', 'unknown'] as const;

export type FleetServiceState = (typeof FLEET_SERVICE_STATES)[number];

export function isFleetServiceState(value: unknown): value is FleetServiceState {
	return typeof value === 'string' && (FLEET_SERVICE_STATES as readonly string[]).includes(value);
}

/** The five acts on a service; `enable` / `disable` are the "At boot" toggle (FR-3). */
export const FLEET_SERVICE_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable'] as const;

export type FleetServiceAction = (typeof FLEET_SERVICE_ACTIONS)[number];

export function isFleetServiceAction(value: unknown): value is FleetServiceAction {
	return typeof value === 'string' && (FLEET_SERVICE_ACTIONS as readonly string[]).includes(value);
}

/**
 * The acts before which the node computes a blast radius (FR-5): the ones
 * that can take a service away. Starting or enabling one never cuts a
 * machine off.
 */
export const FLEET_SERVICE_ACTIONS_WITH_BLAST_RADIUS: readonly FleetServiceAction[] = ['stop', 'restart', 'disable'];

/** Every service act's base class is `confirm`; the node's warning raises it to `blast-radius` (FR-17). */
export const FLEET_SERVICE_ACTION_BASE_CLASS: Readonly<Record<FleetServiceAction, FleetConfirmationClass>> = {
	start: 'confirm',
	stop: 'confirm',
	restart: 'confirm',
	enable: 'confirm',
	disable: 'confirm'
};

/**
 * A service name Ever Works will act on (FR-36): a systemd unit, a launchd
 * label, a Homebrew formula or a Windows service name. Letters, digits and
 * `@ . _ : + $ -`, at most 128, never starting with `-` (so it can never be
 * read as an option) and never containing a shell metacharacter, a space,
 * a quote or a newline. A listed service whose name does not match can be
 * read but not acted on.
 */
export const FLEET_SERVICE_NAME_PATTERN = /^[A-Za-z0-9@._:+][A-Za-z0-9@._:+$-]{0,127}$/;

export function isFleetServiceName(value: unknown): value is string {
	return typeof value === 'string' && FLEET_SERVICE_NAME_PATTERN.test(value) && !value.includes('..');
}

/** Most services one list carries (a machine with more is truncated, failed ones kept first). */
export const FLEET_SERVICES_LIST_MAX = 2000;

/** One service, as the Services tab shows it (spec §5.1). */
export interface FleetServiceView {
	/** `<manager>:<scope>:<name>` — unique on the machine. */
	id: string;
	name: string;
	description: string | null;
	manager: FleetServiceManager;
	scope: FleetServiceScope;
	state: FleetServiceState;
	/** When it entered its current state (ISO), when the manager says. */
	since: string | null;
	/** The last exit status of a failed service, when the manager says. */
	exitCode: number | null;
	/** Starts at boot (system) or at login (user); null when the manager cannot say. */
	atBoot: boolean | null;
	/** The main process, while running. */
	pid: number | null;
	/** CPU percent of one core, while running. */
	cpuPercent: number | null;
	memBytes: number | null;
	/** The acts this manager supports on this service; unsupported acts are absent (FR-3). */
	actions: FleetServiceAction[];
	/** Why an absent act is absent, by act, for the tooltip (FR-3). */
	unsupportedReasons?: Partial<Record<FleetServiceAction, string>>;
	/** The class each supported act is confirmed with, after the node's warning (FR-17). */
	confirmation: Partial<Record<FleetServiceAction, FleetConfirmationClass>>;
	/** What stopping, restarting or disabling it could cut off (FR-5), or null. */
	blastRadius: FleetBlastRadius | null;
	/** Whether its acts need root and whether the node already may (FR-4). */
	root: FleetRootRequirement;
	/** True for the Ever Works node's own service: no buttons, a `⚠ this node` marker (U10). */
	isNode: boolean;
}

/** `services.list` reply / `GET …/services` body. */
export interface FleetServicesListResult {
	/** The managers the node read, in order (empty: "no service manager Ever Works understands", U5). */
	managers: FleetServiceManager[];
	services: FleetServiceView[];
	/** How many services matched before the list was cut at {@link FLEET_SERVICES_LIST_MAX}. */
	total: number;
	/** When the node read them (ISO). */
	sampledAt: string;
	/** A manager the node could not read, with the first line it printed (spec §5.9 error). */
	errors?: { manager: FleetServiceManager; scope: FleetServiceScope; message: string }[];
}

/** `services.action` reply / `POST …/services/:name/:action` body. */
export interface FleetServiceActionResult {
	name: string;
	scope: FleetServiceScope;
	action: FleetServiceAction;
	/** The service's state after the act, as the manager reports it. */
	state: FleetServiceState;
	since: string | null;
	exitCode: number | null;
	atBoot: boolean | null;
}

/** Sort rank: failed first, then running, then the rest (FR-2). */
function serviceRank(state: FleetServiceState): number {
	if (state === 'failed') return 0;
	if (state === 'running' || state === 'activating' || state === 'deactivating') return 1;
	return 2;
}

/** Failed first, then running, then the rest; each group by name, then scope (FR-2). */
export function compareFleetServices(
	a: Pick<FleetServiceView, 'state' | 'name' | 'scope'>,
	b: Pick<FleetServiceView, 'state' | 'name' | 'scope'>
): number {
	const rank = serviceRank(a.state) - serviceRank(b.state);
	if (rank !== 0) return rank;
	const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
	if (byName !== 0) return byName;
	return a.scope.localeCompare(b.scope);
}

/** The Services tab's find field: name or description, case-insensitive (FR-2). */
export function fleetServiceMatchesFind(service: Pick<FleetServiceView, 'name' | 'description'>, find: string): boolean {
	const needle = find.trim().toLowerCase();
	if (!needle) return true;
	return (
		service.name.toLowerCase().includes(needle) ||
		(service.description ?? '').toLowerCase().includes(needle)
	);
}
