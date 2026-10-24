import { existsSync } from 'node:fs';
import {
	compareFleetServices,
	fleetEffectiveConfirmationClass,
	fleetServiceMatchesFind,
	FLEET_SERVICE_ACTION_BASE_CLASS,
	FLEET_SERVICE_ACTIONS_WITH_BLAST_RADIUS,
	FLEET_SERVICES_CAPABILITY,
	FLEET_SERVICES_LIST_MAX,
	isFleetServiceManager,
	isFleetServiceName,
	makeFleetLinkError,
	type FleetBlastRadius,
	type FleetConfirmationClass,
	type FleetServiceAction,
	type FleetServiceActionResult,
	type FleetServiceManager,
	type FleetServiceScope,
	type FleetServicesListResult,
	type FleetServiceState,
	type FleetServiceView
} from '@ever-works/contracts';
import type { CommandRunner } from '../../capabilities';
import { assertServiceAction, assertServiceName, assertServiceScope } from './machine-facts/argv-safety';
import { isNodeService, serviceBlastRadius, type BlastRadiusContext } from './machine-facts/blast-radius';
import { createMachineCommandRunner } from './machine-facts/exec';
import { createBrewManager, createLaunchdManager, type ManagerActOutcome } from './machine-facts/launchd-manager';
import { readProcesses, statsByPid, type ParsedProcess } from './machine-facts/process-list';
import { createRootRunner, type RootRunner } from './machine-facts/root-runner';
import { nodeAncestry } from './machine-facts/self-protection';
import { createSystemdManager } from './machine-facts/systemd-manager';
import { createWindowsServicesManager } from './machine-facts/windows-services';
import { MachineVerbError, type MachineVerbContext, type NodeModule } from './registry';

/**
 * Services on computers (FL-09 P1, spec §4.1) — the `services` node module:
 * the `services.list` and `services.action` verbs on the `machine` channel
 * and the `services` capability tag.
 *
 * Linux reads systemd's system and user units, macOS launchd (system + the
 * node user's gui domain) and Homebrew, Windows its services. Rows come back
 * failed first (FR-2) with CPU and memory for running ones, the acts the
 * manager supports, the class each is confirmed with, the blast radius the
 * node computed (FR-5) and whether root is needed (FR-4).
 *
 * `services.action` re-checks everything on the machine whatever the
 * platform did (README rule: the node never trusts that it did): the name
 * and act against the strict patterns (FR-36), the blast radius — an act
 * that could cut the machine off answers `confirmation_required` with the
 * sentence unless the request acknowledged it — and the node's own service,
 * which Ever Works never stops from here (U10). Root acts follow the root
 * rule: `sudo -n` or a `root_required` refusal whose hint is the exact
 * command to run on the machine (S3, U9).
 */

export interface ServicesModuleDeps {
	runner?: CommandRunner;
	platform?: string;
	root?: RootRunner;
	/** This node's pid and parent (the node's own service is never acted on). */
	selfPid?: number;
	parentPid?: number | null;
	uid?: () => number;
	/** True when systemd is PID 1 (`/run/systemd/system` exists, `sd_booted`). */
	hasSystemd?: () => boolean;
	/** Extra names the node is installed under. */
	nodeServiceNames?: readonly string[];
	/** True when Containers here are computers in the Fleet (FL-16). */
	hostsChildNodes?: () => boolean;
	now?: () => Date;
}

interface ServiceRowDraft {
	name: string;
	description: string | null;
	manager: FleetServiceManager;
	scope: FleetServiceScope;
	state: FleetServiceState;
	since: string | null;
	exitCode: number | null;
	atBoot: boolean | null;
	pid: number | null;
	actions: FleetServiceAction[];
	unsupported: Partial<Record<FleetServiceAction, string>>;
	needsRoot: boolean;
}

const ALL_ACTIONS: readonly FleetServiceAction[] = ['start', 'stop', 'restart', 'enable', 'disable'];

/** The managers a platform has, in reading order (U5: none on a Linux without systemd). */
export function serviceManagersFor(platform: string, hasSystemd: boolean): FleetServiceManager[] {
	if (platform === 'linux') return hasSystemd ? ['systemd'] : [];
	if (platform === 'darwin') return ['launchd', 'brew'];
	if (platform === 'win32') return ['windows'];
	return [];
}

function scopesFor(requested: unknown): FleetServiceScope[] {
	if (requested === 'system') return ['system'];
	if (requested === 'user') return ['user'];
	return ['system', 'user'];
}

/** Finish one row: the class per act, the warning, the root rule, and the node's own marker. */
export function buildServiceView(
	draft: ServiceRowDraft,
	context: BlastRadiusContext,
	root: Pick<RootRunner, 'preauthorized'>,
	stats?: { cpuPercent: number; memBytes: number | null }
): FleetServiceView {
	const isNode = isNodeService({ name: draft.name, manager: draft.manager, pid: draft.pid }, context);
	const blastRadius: FleetBlastRadius | null = isNode
		? null
		: serviceBlastRadius({ name: draft.name, manager: draft.manager, pid: draft.pid }, context);
	// A name the strict pattern refuses is listed but never acted on (FR-36).
	const actions = isNode || !isFleetServiceName(draft.name) ? [] : [...draft.actions];
	const unsupported: Partial<Record<FleetServiceAction, string>> = { ...draft.unsupported };
	if (isNode) {
		for (const action of ALL_ACTIONS) {
			unsupported[action] = 'Ever Works will not stop its own node from here. Use the machine or Settings → Fleet.';
		}
	} else if (!isFleetServiceName(draft.name)) {
		for (const action of ALL_ACTIONS) unsupported[action] = 'Ever Works does not act on a service with this name.';
	}
	const confirmation: Partial<Record<FleetServiceAction, FleetConfirmationClass>> = {};
	for (const action of actions) {
		const warned = FLEET_SERVICE_ACTIONS_WITH_BLAST_RADIUS.includes(action) ? blastRadius : null;
		confirmation[action] = fleetEffectiveConfirmationClass(FLEET_SERVICE_ACTION_BASE_CLASS[action], warned);
	}
	const running = draft.state === 'running';
	return {
		id: `${draft.manager}:${draft.scope}:${draft.name}`,
		name: draft.name,
		description: draft.description,
		manager: draft.manager,
		scope: draft.scope,
		state: draft.state,
		since: draft.since,
		exitCode: draft.exitCode,
		atBoot: draft.atBoot,
		pid: running ? draft.pid : null,
		cpuPercent: running && stats ? stats.cpuPercent : null,
		memBytes: running && stats ? stats.memBytes : null,
		actions,
		...(Object.keys(unsupported).length > 0 ? { unsupportedReasons: unsupported } : {}),
		confirmation,
		blastRadius,
		root: {
			required: draft.needsRoot,
			preauthorized: draft.needsRoot ? root.preauthorized() : true,
			command: null
		},
		isNode
	};
}

export function createServicesModule(deps: ServicesModuleDeps = {}): NodeModule {
	const platform = deps.platform ?? process.platform;
	const runner = deps.runner ?? createMachineCommandRunner();
	const root = deps.root ?? createRootRunner({ runner, platform });
	const selfPid = deps.selfPid ?? process.pid;
	const parentPid = deps.parentPid === undefined ? process.ppid : deps.parentPid;
	const uid = deps.uid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : 0));
	const hasSystemd = deps.hasSystemd ?? (() => existsSync('/run/systemd/system'));
	const now = deps.now ?? (() => new Date());

	const systemd = createSystemdManager({ runner, root });
	const launchd = createLaunchdManager({ runner, root, uid });
	const brew = createBrewManager({ runner });
	const windows = createWindowsServicesManager({ runner, root });

	const managers = (): FleetServiceManager[] => serviceManagersFor(platform, platform === 'linux' && hasSystemd());

	const blastContext = (machine: string, processes: readonly ParsedProcess[]): BlastRadiusContext => ({
		platform,
		machine,
		nodePids: nodeAncestry(processes, { selfPid, parentPid }).filter((pid) => pid > 1),
		...(deps.nodeServiceNames ? { nodeServiceNames: deps.nodeServiceNames } : {}),
		hostsChildNodes: deps.hostsChildNodes?.() ?? false
	});

	/** Every service of the requested scopes, as drafts (before the warning and the root rule). */
	const readDrafts = async (
		scopes: FleetServiceScope[]
	): Promise<{ drafts: ServiceRowDraft[]; errors: NonNullable<FleetServicesListResult['errors']> }> => {
		const drafts: ServiceRowDraft[] = [];
		const errors: NonNullable<FleetServicesListResult['errors']> = [];
		for (const manager of managers()) {
			if (manager === 'systemd') {
				for (const scope of scopes) {
					const listed = await systemd.list(scope);
					if (listed.error) {
						// A headless service user has no user bus: that is not an error worth showing.
						if (!(scope === 'user' && /connect to bus|no medium|XDG_RUNTIME_DIR/i.test(listed.error))) {
							errors.push({ manager, scope, message: listed.error });
						}
						continue;
					}
					for (const row of listed.rows) {
						const actions: FleetServiceAction[] = [];
						const unsupported: Partial<Record<FleetServiceAction, string>> = {};
						if (row.masked) {
							unsupported.start = 'This unit is masked; unmask it on the machine first.';
							unsupported.restart = unsupported.start;
						} else {
							actions.push('start', 'restart');
						}
						actions.push('stop');
						if (row.toggleable) actions.push('enable', 'disable');
						else {
							unsupported.enable = 'This unit has no install section, so it cannot be turned on at boot.';
							unsupported.disable = unsupported.enable;
						}
						drafts.push({
							...row,
							manager,
							actions: ALL_ACTIONS.filter((action) => actions.includes(action)),
							unsupported,
							needsRoot: scope === 'system'
						});
					}
				}
			} else if (manager === 'launchd') {
				for (const scope of scopes) {
					const listed = await launchd.list(scope);
					if (listed.error) {
						errors.push({ manager, scope, message: listed.error });
						continue;
					}
					for (const row of listed.rows) {
						drafts.push({
							...row,
							description: null,
							since: null,
							manager,
							actions: [...ALL_ACTIONS],
							unsupported: {},
							needsRoot: scope === 'system'
						});
					}
				}
			} else if (manager === 'brew') {
				if (!scopes.includes('user')) continue;
				const listed = await brew.list();
				if (!listed) continue;
				if (listed.error) {
					errors.push({ manager, scope: 'user', message: listed.error });
					continue;
				}
				for (const row of listed.rows) {
					drafts.push({
						...row,
						description: null,
						since: null,
						manager,
						scope: 'user',
						actions: ['start', 'stop', 'restart', 'enable'],
						unsupported: { disable: 'Homebrew turns a service off at login only by stopping it — use Stop.' },
						needsRoot: false
					});
				}
			} else if (manager === 'windows') {
				if (!scopes.includes('system')) continue;
				const listed = await windows.list();
				if (listed.error) {
					errors.push({ manager, scope: 'system', message: listed.error });
					continue;
				}
				for (const row of listed.rows) {
					const unsupported: Partial<Record<FleetServiceAction, string>> = {};
					const actions: FleetServiceAction[] = ['stop', 'enable', 'disable'];
					if (row.disabled) {
						unsupported.start = 'This service is disabled; turn At boot on first.';
						unsupported.restart = unsupported.start;
					} else {
						actions.push('start', 'restart');
					}
					drafts.push({
						name: row.name,
						description: row.description,
						manager,
						scope: 'system',
						state: row.state,
						since: null,
						exitCode: row.exitCode,
						atBoot: row.atBoot,
						pid: row.pid,
						actions: ALL_ACTIONS.filter((action) => actions.includes(action)),
						unsupported,
						needsRoot: true
					});
				}
			}
		}
		return { drafts, errors };
	};

	const list = async (context: MachineVerbContext): Promise<FleetServicesListResult> => {
		const scopes = scopesFor(context.params.scope);
		const [{ drafts, errors }, processes] = await Promise.all([
			readDrafts(scopes),
			readProcesses(runner, platform).then((read) => ('processes' in read ? read.processes : []))
		]);
		const stats = statsByPid(processes);
		const blast = blastContext(context.nodeName, processes);
		const find = typeof context.params.find === 'string' ? context.params.find.slice(0, 200) : '';
		const views = drafts
			.map((draft) => buildServiceView(draft, blast, root, draft.pid ? stats.get(draft.pid) : undefined))
			.filter((view) => fleetServiceMatchesFind(view, find))
			.sort(compareFleetServices);
		return {
			managers: managers(),
			services: views.slice(0, FLEET_SERVICES_LIST_MAX),
			total: views.length,
			sampledAt: now().toISOString(),
			...(errors.length > 0 ? { errors } : {})
		};
	};

	const managerFor = (raw: unknown): FleetServiceManager => {
		const available = managers();
		if (available.length === 0) {
			throw new MachineVerbError(
				makeFleetLinkError('unsupported_on_node', 'this computer has no service manager Ever Works understands')
			);
		}
		if (raw === undefined || raw === null) return available[0];
		if (!isFleetServiceManager(raw) || !available.includes(raw)) {
			throw new MachineVerbError(makeFleetLinkError('invalid', 'manager is not one this computer has', { field: 'manager' }));
		}
		return raw;
	};

	const act = async (context: MachineVerbContext): Promise<FleetServiceActionResult> => {
		const params = context.params;
		const name = assertServiceName(params.name);
		const action = assertServiceAction(params.action);
		const manager = managerFor(params.manager);
		const scope: FleetServiceScope =
			manager === 'windows' ? 'system' : manager === 'brew' ? 'user' : assertServiceScope(params.scope);

		// The service as it is right now — it must exist, and its pid says whether it is this node.
		const [{ drafts }, processes] = await Promise.all([
			readDrafts([scope]),
			readProcesses(runner, platform).then((read) => ('processes' in read ? read.processes : []))
		]);
		const draft = drafts.find((row) => row.manager === manager && row.name === name);
		if (!draft) {
			throw new MachineVerbError(makeFleetLinkError('not_found', `${name} is not a ${scope} service on ${context.nodeName}`));
		}
		const blast = blastContext(context.nodeName, processes);
		const view = buildServiceView(draft, blast, root);
		if (view.isNode) {
			throw new MachineVerbError(
				makeFleetLinkError('invalid', 'Ever Works will not stop its own node from here. Use the machine or Settings → Fleet.', {
					field: 'name'
				})
			);
		}
		if (!view.actions.includes(action)) {
			throw new MachineVerbError(
				makeFleetLinkError(
					'unsupported_on_node',
					view.unsupportedReasons?.[action] ?? `${manager} cannot ${action} ${name}`,
					{ action }
				)
			);
		}
		const warned = FLEET_SERVICE_ACTIONS_WITH_BLAST_RADIUS.includes(action) ? view.blastRadius : null;
		if (warned && params.acknowledgeBlastRadius !== true) {
			throw new MachineVerbError(
				makeFleetLinkError('confirmation_required', warned.sentence, {
					class: 'blast-radius',
					summary: `${action[0].toUpperCase()}${action.slice(1)} ${name} on ${context.nodeName}?`,
					sentence: warned.sentence,
					blastRadiusKind: warned.kind
				})
			);
		}

		const outcome = await runAct(manager, name, scope, action);
		if (!outcome.ok) {
			if (outcome.refusal === 'root') {
				const shell = manager === 'windows' ? 'powershell' : 'sh';
				throw new MachineVerbError(
					makeFleetLinkError('root_required', outcome.command, { command: outcome.command, shell, machine: context.nodeName })
				);
			}
			if (outcome.refusal === 'not-found') {
				throw new MachineVerbError(makeFleetLinkError('not_found', `${name} is not a service on ${context.nodeName}`));
			}
			throw new MachineVerbError(makeFleetLinkError('operation_failed', outcome.message));
		}
		context.logger?.info(`services: ${action} ${manager}/${scope}/${name} → ${outcome.state}`);
		return {
			name,
			scope,
			action,
			state: outcome.state,
			since: outcome.since,
			exitCode: outcome.exitCode,
			atBoot: outcome.atBoot,
			blastRadius: warned,
			viaRoot: draft.needsRoot
		};
	};

	const runAct = async (
		manager: FleetServiceManager,
		name: string,
		scope: FleetServiceScope,
		action: FleetServiceAction
	): Promise<
		| { ok: true; state: FleetServiceState; since: string | null; exitCode: number | null; atBoot: boolean | null }
		| Exclude<ManagerActOutcome, { ok: true }>
	> => {
		switch (manager) {
			case 'systemd': {
				const result = await systemd.act({ name, scope, action });
				return result.ok ? { ok: true, ...result.row } : result;
			}
			case 'launchd': {
				const result = await launchd.act({ name, scope, action });
				return result.ok ? { ...result, since: null } : result;
			}
			case 'brew': {
				const result = await brew.act({ name, action });
				return result.ok ? { ...result, since: null } : result;
			}
			case 'windows': {
				const result = await windows.act({ name, action });
				if (!result.ok) return result;
				return {
					ok: true,
					state: result.row?.state ?? 'unknown',
					since: null,
					exitCode: result.row?.exitCode ?? null,
					atBoot: result.row?.atBoot ?? null
				};
			}
		}
	};

	return {
		id: 'services',
		tags: (environment) =>
			environment.consents.manage &&
			serviceManagersFor(environment.platform, environment.platform === 'linux' && hasSystemd()).length > 0
				? [FLEET_SERVICES_CAPABILITY]
				: [],
		machineVerbs: {
			'services.list': { stateChanging: false, run: list },
			'services.action': { stateChanging: true, run: act }
		}
	};
}
