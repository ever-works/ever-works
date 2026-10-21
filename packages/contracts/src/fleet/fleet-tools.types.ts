/**
 * Fleet — the Agent, MCP and CLI surface (FL-19, CONTRACTS §2.1, §2.2, §8, §11.3).
 *
 * Everything a person can do to a computer from the Fleet hub, an Agent can do
 * through a tool, an external assistant through the MCP server and a shell
 * through `ever-works fleet …` — the same API, the same shapes, the same typed
 * errors with a fix hint. This file is the ONE declarative table those three
 * surfaces are built from and tested against: {@link FLEET_TOOL_CATALOGUE}.
 *
 * ## What a row says
 *
 *  - `name` — `fleet_<family>_<verb>` (CONTRACTS §11.3). The tool family is a
 *    NAME, not a permission: each row also names the CONTRACTS §2.1
 *    permission family the computer's audience is checked for.
 *  - read-only rows carry `readOnly: true`; every other row `destructive`,
 *    its confirmation class (CONTRACTS §2.2) and its AW-24 action category
 *    (the trust-ladder rung the Agent's call is held or refused by).
 *  - `owner` — the epic that defines the row (its plan §9). Where this table
 *    and an owner disagree, the owner is right and the row is corrected.
 *  - `status` — `live` when the backing route / tool exists on this build;
 *    `planned` is a REGISTRATION POINT for a family that has not landed yet:
 *    it is listed (so the Capabilities block and the docs can say what is
 *    coming) but no surface exposes it until its epic flips it to `live`.
 *
 * ## Additive
 *
 * The existing `list_fleet_nodes` Agent tool and the eight existing MCP fleet
 * entries ({@link FLEET_TOOL_LEGACY_NAMES}) stay exactly as they are beside
 * the new names (CONTRACTS §11.3, spec FR-3).
 */

import type { ActionCategory } from '../safety/action-category.types.js';
import type { FleetActionFamily } from './fleet-access.types.js';
import type { FleetConsentKey, FleetLinkError } from './fleet-link.types.js';
import type { FleetActionConfirmFields, FleetConfirmationClass } from './fleet-machine-actions.types.js';
import type { FleetKillSwitchState } from './fleet-panic.types.js';
import type { NeedsALookItem } from './fleet-needs-a-look.types.js';

// ─── Families ───────────────────────────────────────────────────────────────

/**
 * The tool families of spec FR-1, in display order: the plural noun or API
 * path segment of the thing acted on. Compose is under `docker`, paste under
 * `desktop`, health, wake and git identity under `nodes`.
 */
export const FLEET_TOOL_FAMILIES = [
	'status',
	'nodes',
	'sessions',
	'desktop',
	'logs',
	'services',
	'processes',
	'docker',
	'ports',
	'files',
	'commands',
	'schedules',
	'checkouts',
	'tasks',
	'virtual',
	'cloud',
	'runners',
	'usage',
	'operations'
] as const;

export type FleetToolFamily = (typeof FLEET_TOOL_FAMILIES)[number];

export function isFleetToolFamily(value: unknown): value is FleetToolFamily {
	return typeof value === 'string' && (FLEET_TOOL_FAMILIES as readonly string[]).includes(value);
}

/**
 * `fleet_<family>` or `fleet_<family>_<verb>`: lower-case words joined by `_`.
 * `fleet_status` is the one name with no verb.
 */
export const FLEET_TOOL_NAME_PATTERN = /^fleet_[a-z]+(?:_[a-z]+)*$/;

export function isFleetToolName(value: unknown): value is string {
	return typeof value === 'string' && FLEET_TOOL_NAME_PATTERN.test(value);
}

/**
 * Names that predate this catalogue and stay exactly as they are (spec FR-3,
 * CONTRACTS §11.3): the Agent's `list_fleet_nodes` and the eight MCP fleet
 * entries (`list_fleet_nodes` is on both surfaces). The parity tests allow
 * exactly these beside the catalogue.
 */
export const FLEET_TOOL_LEGACY_NAMES = [
	'list_fleet_nodes',
	'get_fleet_node',
	'get_fleet_runner_status',
	'get_fleet_execution_preferences',
	'get_agent_node_affinity',
	'set_agent_node_affinity',
	'clear_agent_node_affinity',
	'drain_fleet_node'
] as const;

export type FleetToolLegacyName = (typeof FLEET_TOOL_LEGACY_NAMES)[number];

// ─── Flags (CONTRACTS §9) ───────────────────────────────────────────────────

/** The deployment flag a row inherits (FL-19 has none of its own). */
export const FLEET_TOOL_FLAGS = [
	'FLEET_ENABLED',
	'FLEET_NODE_LINK_ENABLED',
	'FLEET_HEALTH_HISTORY_ENABLED',
	'FLEET_SESSIONS_ENABLED',
	'FLEET_DESKTOP_ENABLED',
	'FLEET_MACHINE_FACTS_ENABLED',
	'FLEET_PORT_TUNNEL_ENABLED',
	'FLEET_COMMANDS_ENABLED',
	'FLEET_CHECKOUTS_ENABLED',
	'FLEET_VIRTUAL_ENABLED',
	'FLEET_CLOUD_ENABLED',
	'FLEET_ACTIONS_RUNNERS_ENABLED',
	'FLEET_USAGE_SCAN_ENABLED'
] as const;

export type FleetToolFlag = (typeof FLEET_TOOL_FLAGS)[number];

// ─── Annotations and rows ───────────────────────────────────────────────────

/** The epics that own catalogue rows. */
export type FleetToolOwnerEpic =
	| 'FL-02'
	| 'FL-03'
	| 'FL-04'
	| 'FL-05'
	| 'FL-06'
	| 'FL-07'
	| 'FL-08'
	| 'FL-09'
	| 'FL-10'
	| 'FL-11'
	| 'FL-12'
	| 'FL-13'
	| 'FL-14'
	| 'FL-15'
	| 'FL-16'
	| 'FL-17'
	| 'FL-18'
	| 'FL-19'
	| 'FL-20';

export type FleetToolStatus = 'live' | 'planned';

export type FleetToolPhase = 'P1' | 'P2' | 'P3';

export type FleetToolHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The platform route a row is built over: OpenAPI-style template (`{id}`), under `/api`. */
export interface FleetToolRoute {
	method: FleetToolHttpMethod;
	path: string;
}

/**
 * What a tool declares about itself (spec FR-2). Optional on every existing
 * descriptor; every catalogue row carries one.
 */
export interface FleetToolAnnotation {
	/** A read: no confirmation, no audit row (except where CONTRACTS §7 names one), no Decision. */
	readOnly?: true;
	/** A state change that removes or stops something (`destructiveHint` on MCP). */
	destructive?: boolean;
	/** CONTRACTS §2.2 — the class the call must satisfy. A row with two lists the stricter case in `confirmationNote`. */
	confirmationClass?: FleetConfirmationClass;
	/** AW-24 — the kind of work, which picks the trust-ladder rung. Reads are `read.internal`. */
	category?: ActionCategory;
	/** CONTRACTS §2.1 — the family whose audience (and consent) the computer checks. */
	permissionFamily: FleetActionFamily;
}

export interface FleetToolCatalogueEntry extends FleetToolAnnotation {
	name: string;
	family: FleetToolFamily;
	/** The verb part of the name (`list`, `action`, `container_action`); empty for `fleet_status`. */
	verb: string;
	owner: FleetToolOwnerEpic;
	/** The FL-19 phase that exposes it on the three surfaces. */
	phase: FleetToolPhase;
	flag: FleetToolFlag;
	status: FleetToolStatus;
	/** The platform route. Absent for a tool with no REST twin (`fleet_sessions_send`). */
	route?: FleetToolRoute;
	/** The `ever-works fleet …` verb, when the CLI has one. */
	cli?: string;
	/** Accepts `wait: false` and may answer `{ operationId }` (spec FR-14). */
	waitable?: true;
	/** Never runs on an Agent's say-so, whatever the rung (held for a person, CONTRACTS R-33). */
	alwaysHeld?: true;
	/** When the class depends on the call ("confirm; blast-radius when the node warns"). */
	confirmationNote?: string;
}

type RowInput = Omit<FleetToolCatalogueEntry, 'family' | 'verb' | 'readOnly'> & { readOnly?: true };

/** Split `fleet_<family>_<verb>` (the family is the first word after `fleet_`). */
function row(input: RowInput): FleetToolCatalogueEntry {
	const rest = input.name.slice('fleet_'.length);
	const cut = rest.indexOf('_');
	const family = (cut === -1 ? rest : rest.slice(0, cut)) as FleetToolFamily;
	const verb = cut === -1 ? '' : rest.slice(cut + 1);
	return Object.freeze({ ...input, family, verb });
}

function read(
	name: string,
	permissionFamily: FleetActionFamily,
	owner: FleetToolOwnerEpic,
	flag: FleetToolFlag,
	status: FleetToolStatus,
	extra: Partial<RowInput> = {}
): FleetToolCatalogueEntry {
	return row({
		name,
		readOnly: true,
		category: 'read.internal',
		permissionFamily,
		owner,
		phase: 'P1',
		flag,
		status,
		...extra
	});
}

function act(
	name: string,
	permissionFamily: FleetActionFamily,
	owner: FleetToolOwnerEpic,
	flag: FleetToolFlag,
	status: FleetToolStatus,
	annotation: { destructive: boolean; confirmationClass: FleetConfirmationClass; category: ActionCategory },
	extra: Partial<RowInput> = {}
): FleetToolCatalogueEntry {
	return row({ name, permissionFamily, owner, phase: 'P2', flag, status, ...annotation, ...extra });
}

const plain = (category: ActionCategory, destructive = false) => ({
	destructive,
	confirmationClass: 'plain' as const,
	category
});
const confirm = (category: ActionCategory, destructive = true) => ({
	destructive,
	confirmationClass: 'confirm' as const,
	category
});
const typed = (category: ActionCategory) => ({
	destructive: true,
	confirmationClass: 'confirm-destructive' as const,
	category
});

const GET = (path: string): FleetToolRoute => ({ method: 'GET', path });
const POST = (path: string): FleetToolRoute => ({ method: 'POST', path });
const PATCH = (path: string): FleetToolRoute => ({ method: 'PATCH', path });
const DELETE = (path: string): FleetToolRoute => ({ method: 'DELETE', path });

/**
 * Every fleet tool of every family (FL-19 plan §9.1, each row defined by its
 * owning epic's plan §9). Order = display order of the Capabilities block.
 */
export const FLEET_TOOL_CATALOGUE: readonly FleetToolCatalogueEntry[] = Object.freeze([
	// ── status (FL-19) ──
	read('fleet_status', 'view', 'FL-19', 'FLEET_ENABLED', 'live', {
		route: GET('/api/fleet/status'),
		cli: 'fleet status'
	}),

	// ── nodes (FL-19, FL-03, FL-15) ──
	read('fleet_nodes_list', 'view', 'FL-19', 'FLEET_ENABLED', 'live', {
		route: GET('/api/fleet/nodes'),
		cli: 'fleet nodes list'
	}),
	read('fleet_nodes_get', 'view', 'FL-19', 'FLEET_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}'),
		cli: 'fleet nodes get'
	}),
	read('fleet_nodes_health', 'view', 'FL-03', 'FLEET_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/health'),
		cli: 'fleet nodes health'
	}),
	read('fleet_nodes_needs_a_look', 'view', 'FL-03', 'FLEET_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/needs-a-look'),
		cli: 'fleet nodes needs-a-look'
	}),
	read('fleet_nodes_git_identity_get', 'view', 'FL-15', 'FLEET_CHECKOUTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/git/identity'),
		cli: 'fleet nodes git-identity'
	}),
	act('fleet_nodes_wake', 'machines', 'FL-03', 'FLEET_ENABLED', 'live', plain('machine.admin'), {
		route: POST('/api/fleet/nodes/{id}/wake'),
		cli: 'fleet nodes wake'
	}),
	act(
		'fleet_nodes_git_identity_set',
		'commands',
		'FL-15',
		'FLEET_CHECKOUTS_ENABLED',
		'live',
		confirm('machine.admin', false),
		{ route: POST('/api/fleet/nodes/{id}/git/identity'), cli: 'fleet nodes git-identity --set' }
	),

	// ── sessions (FL-04, FL-05, FL-06) ──
	read('fleet_sessions_list', 'sessions', 'FL-04', 'FLEET_SESSIONS_ENABLED', 'live', {
		route: GET('/api/fleet/sessions'),
		cli: 'fleet sessions list'
	}),
	read('fleet_sessions_read', 'sessions', 'FL-04', 'FLEET_SESSIONS_ENABLED', 'live', {
		route: GET('/api/fleet/sessions/{id}'),
		cli: 'fleet sessions read'
	}),
	read('fleet_sessions_question', 'sessions', 'FL-05', 'FLEET_SESSIONS_ENABLED', 'live', {
		route: GET('/api/fleet/sessions/{id}'),
		cli: 'fleet sessions question'
	}),
	read('fleet_sessions_actions_list', 'sessions', 'FL-06', 'FLEET_SESSIONS_ENABLED', 'planned', {
		route: GET('/api/fleet/sessions/{id}/actions'),
		cli: 'fleet sessions actions'
	}),
	act('fleet_sessions_start', 'sessions', 'FL-04', 'FLEET_SESSIONS_ENABLED', 'live', plain('machine.run'), {
		route: POST('/api/fleet/nodes/{id}/sessions'),
		cli: 'fleet sessions start'
	}),
	act('fleet_sessions_send', 'sessions', 'FL-04', 'FLEET_SESSIONS_ENABLED', 'live', plain('machine.run')),
	act('fleet_sessions_answer', 'sessions', 'FL-05', 'FLEET_SESSIONS_ENABLED', 'live', confirm('machine.run', false), {
		route: POST('/api/fleet/sessions/{id}/answer'),
		cli: 'fleet sessions answer',
		confirmationNote: 'questions only; a permission prompt is answered by a person (CONTRACTS R-32)'
	}),
	act('fleet_sessions_rename', 'sessions', 'FL-04', 'FLEET_SESSIONS_ENABLED', 'live', plain('write.internal'), {
		route: PATCH('/api/fleet/sessions/{id}'),
		cli: 'fleet sessions rename'
	}),
	act('fleet_sessions_end', 'sessions', 'FL-04', 'FLEET_SESSIONS_ENABLED', 'live', confirm('machine.run'), {
		route: POST('/api/fleet/sessions/{id}/end'),
		cli: 'fleet sessions end'
	}),
	act('fleet_sessions_action', 'sessions', 'FL-06', 'FLEET_SESSIONS_ENABLED', 'planned', plain('machine.run'), {
		route: POST('/api/fleet/sessions/{id}/actions'),
		cli: 'fleet sessions action'
	}),

	// ── desktop (FL-07, FL-11 paste) ──
	read('fleet_desktop_screenshot', 'desktop', 'FL-07', 'FLEET_DESKTOP_ENABLED', 'planned', {
		route: GET('/api/fleet/nodes/{id}/desktop/screenshot'),
		cli: 'fleet desktop screenshot'
	}),
	read('fleet_desktop_displays', 'desktop', 'FL-07', 'FLEET_DESKTOP_ENABLED', 'planned', {
		route: GET('/api/fleet/nodes/{id}/desktop/displays'),
		cli: 'fleet desktop displays'
	}),
	read('fleet_desktop_recordings_list', 'desktop', 'FL-07', 'FLEET_DESKTOP_ENABLED', 'planned', {
		route: GET('/api/fleet/nodes/{id}/desktop/recordings'),
		cli: 'fleet desktop recordings'
	}),
	act('fleet_desktop_input', 'desktop', 'FL-07', 'FLEET_DESKTOP_ENABLED', 'planned', plain('machine.admin', true), {
		route: POST('/api/fleet/nodes/{id}/desktop/input'),
		cli: 'fleet desktop input'
	}),
	act('fleet_desktop_set_display', 'desktop', 'FL-07', 'FLEET_DESKTOP_ENABLED', 'planned', plain('machine.admin'), {
		route: POST('/api/fleet/nodes/{id}/desktop/displays'),
		cli: 'fleet desktop set-display'
	}),
	act(
		'fleet_desktop_display_add',
		'desktop',
		'FL-07',
		'FLEET_DESKTOP_ENABLED',
		'planned',
		confirm('machine.admin'),
		{ phase: 'P3', route: POST('/api/fleet/nodes/{id}/desktop/displays/virtual'), cli: 'fleet desktop display-add' }
	),
	act(
		'fleet_desktop_display_remove',
		'desktop',
		'FL-07',
		'FLEET_DESKTOP_ENABLED',
		'planned',
		confirm('machine.admin'),
		{
			phase: 'P3',
			route: DELETE('/api/fleet/nodes/{id}/desktop/displays/virtual/{displayId}'),
			cli: 'fleet desktop display-remove'
		}
	),
	act('fleet_desktop_paste', 'desktop', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'planned', plain('machine.admin', true), {
		route: POST('/api/fleet/nodes/{id}/desktop/paste'),
		cli: 'fleet desktop paste',
		confirmationNote: 'denied unless a tool grant allows it (AW-15)'
	}),

	// ── logs (FL-08) ──
	read('fleet_logs_sources', 'logs', 'FL-08', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/logs/sources'),
		cli: 'fleet logs sources'
	}),
	read('fleet_logs_read', 'logs', 'FL-08', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: POST('/api/fleet/nodes/{id}/logs/read'),
		cli: 'fleet logs read'
	}),

	// ── services (FL-09) ──
	read('fleet_services_list', 'services', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/services'),
		cli: 'fleet services list'
	}),
	act('fleet_services_action', 'services', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', confirm('machine.admin'), {
		route: POST('/api/fleet/nodes/{id}/services/{name}/{action}'),
		cli: 'fleet services action',
		waitable: true,
		confirmationNote: 'confirm; blast-radius when the node warns it could cut the machine off'
	}),

	// ── processes (FL-09) ──
	read('fleet_processes_list', 'processes', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/processes'),
		cli: 'fleet processes list'
	}),
	act(
		'fleet_processes_signal',
		'processes',
		'FL-09',
		'FLEET_MACHINE_FACTS_ENABLED',
		'live',
		confirm('machine.admin'),
		{ route: POST('/api/fleet/nodes/{id}/processes/{pid}/signal'), cli: 'fleet processes signal' }
	),

	// ── docker (FL-09) ──
	read('fleet_docker_containers_list', 'docker', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/docker/containers'),
		cli: 'fleet docker containers'
	}),
	read('fleet_docker_images_list', 'docker', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/docker/images'),
		cli: 'fleet docker images'
	}),
	read('fleet_docker_compose_list', 'docker', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/docker/compose'),
		cli: 'fleet docker compose'
	}),
	read('fleet_docker_compose_describe', 'docker', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		cli: 'fleet docker compose-describe'
	}),
	act(
		'fleet_docker_container_action',
		'docker',
		'FL-09',
		'FLEET_MACHINE_FACTS_ENABLED',
		'live',
		confirm('machine.admin'),
		{
			route: POST('/api/fleet/nodes/{id}/docker/containers/{cid}/{action}'),
			cli: 'fleet docker container',
			waitable: true,
			confirmationNote: 'confirm; remove is confirm-destructive'
		}
	),
	act('fleet_docker_run', 'docker', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'live', confirm('machine.admin', false), {
		route: POST('/api/fleet/nodes/{id}/docker/containers'),
		cli: 'fleet docker run',
		waitable: true,
		alwaysHeld: true,
		confirmationNote: 'an Agent proposes a run; a person types any secret values'
	}),
	act(
		'fleet_docker_image_action',
		'docker',
		'FL-09',
		'FLEET_MACHINE_FACTS_ENABLED',
		'live',
		confirm('machine.admin'),
		{
			route: POST('/api/fleet/nodes/{id}/docker/images/{iid}/{action}'),
			cli: 'fleet docker image',
			waitable: true,
			confirmationNote: 'pull is plain and not destructive; remove and prune confirm'
		}
	),
	act(
		'fleet_docker_compose_action',
		'docker',
		'FL-09',
		'FLEET_MACHINE_FACTS_ENABLED',
		'live',
		confirm('machine.admin'),
		{
			route: POST('/api/fleet/nodes/{id}/docker/compose/{project}/{action}'),
			cli: 'fleet docker compose-action',
			waitable: true,
			confirmationNote: 'destructive for down'
		}
	),
	act('fleet_docker_exec', 'docker', 'FL-09', 'FLEET_MACHINE_FACTS_ENABLED', 'planned', plain('machine.run'), {
		phase: 'P3',
		cli: 'fleet docker exec'
	}),

	// ── ports (FL-10) ──
	read('fleet_ports_list', 'view', 'FL-10', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/ports'),
		cli: 'fleet ports list'
	}),
	act('fleet_ports_open', 'ports', 'FL-10', 'FLEET_MACHINE_FACTS_ENABLED', 'live', plain('machine.run'), {
		route: POST('/api/fleet/nodes/{id}/ports/{port}/open'),
		cli: 'fleet ports open'
	}),
	act('fleet_ports_preview_open', 'ports', 'FL-10', 'FLEET_PORT_TUNNEL_ENABLED', 'live', plain('machine.run'), {
		route: POST('/api/fleet/nodes/{id}/ports/{port}/preview'),
		cli: 'fleet ports preview'
	}),
	act('fleet_ports_preview_close', 'ports', 'FL-10', 'FLEET_PORT_TUNNEL_ENABLED', 'live', plain('machine.run'), {
		route: DELETE('/api/fleet/nodes/{id}/ports/{port}/preview'),
		cli: 'fleet ports preview-close'
	}),

	// ── files (FL-11) ──
	// P1 (FL-11 lane log decision 15): the roots read joins the family, and the list's route is the
	// one FL-11 built (`…/files/list` — `…/files` is the family's prefix, not a route).
	read('fleet_files_roots', 'files', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/files/roots'),
		cli: 'fleet files roots'
	}),
	read('fleet_files_list', 'files', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/files/list'),
		cli: 'fleet files list'
	}),
	read('fleet_files_stat', 'files', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'live', {
		route: GET('/api/fleet/nodes/{id}/files/stat'),
		cli: 'fleet files stat'
	}),
	read('fleet_files_read', 'files', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'planned', {
		route: GET('/api/fleet/nodes/{id}/files/download'),
		cli: 'fleet files get'
	}),
	act('fleet_files_write', 'files', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'planned', confirm('machine.admin'), {
		route: POST('/api/fleet/nodes/{id}/files/upload'),
		cli: 'fleet files put'
	}),
	act('fleet_files_copy', 'files', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'planned', confirm('machine.admin'), {
		route: POST('/api/fleet/nodes/{id}/files/copy'),
		cli: 'fleet files cp'
	}),
	act('fleet_files_delete', 'files', 'FL-11', 'FLEET_MACHINE_FACTS_ENABLED', 'planned', typed('write.destructive'), {
		route: POST('/api/fleet/nodes/{id}/files/delete'),
		cli: 'fleet files rm',
		alwaysHeld: true
	}),

	// ── commands (FL-12) ──
	read('fleet_commands_list', 'commands', 'FL-12', 'FLEET_COMMANDS_ENABLED', 'live', {
		route: GET('/api/fleet/commands'),
		cli: 'fleet commands list'
	}),
	read('fleet_commands_get', 'commands', 'FL-12', 'FLEET_COMMANDS_ENABLED', 'live', {
		route: GET('/api/fleet/commands/{id}'),
		cli: 'fleet commands get'
	}),
	act('fleet_commands_run', 'commands', 'FL-12', 'FLEET_COMMANDS_ENABLED', 'live', confirm('machine.run'), {
		route: POST('/api/fleet/commands'),
		cli: 'fleet commands run',
		alwaysHeld: true
	}),
	act('fleet_commands_cancel', 'commands', 'FL-12', 'FLEET_COMMANDS_ENABLED', 'live', plain('machine.run'), {
		route: POST('/api/fleet/commands/{id}/cancel'),
		cli: 'fleet commands cancel'
	}),

	// ── schedules (FL-13 P2: live — `apps/api/src/fleet/schedules/fleet-schedules.controller.ts`) ──
	read('fleet_schedules_list', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', {
		route: GET('/api/fleet/schedules'),
		cli: 'fleet schedules list'
	}),
	read('fleet_schedules_get', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', {
		route: GET('/api/fleet/schedules/{id}'),
		cli: 'fleet schedules get'
	}),
	read('fleet_schedules_runs', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', {
		route: GET('/api/fleet/schedules/{id}/runs'),
		cli: 'fleet schedules runs'
	}),
	act('fleet_schedules_create', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', confirm('agent.fanout'), {
		route: POST('/api/fleet/schedules'),
		cli: 'fleet schedules create'
	}),
	act('fleet_schedules_update', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', confirm('agent.fanout'), {
		route: PATCH('/api/fleet/schedules/{id}'),
		cli: 'fleet schedules update'
	}),
	act(
		'fleet_schedules_delete',
		'schedules',
		'FL-13',
		'FLEET_COMMANDS_ENABLED',
		'live',
		confirm('write.destructive'),
		{ route: DELETE('/api/fleet/schedules/{id}'), cli: 'fleet schedules delete' }
	),
	act('fleet_schedules_run', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', confirm('machine.run'), {
		route: POST('/api/fleet/schedules/{id}/run'),
		cli: 'fleet schedules run'
	}),
	act('fleet_schedules_pause', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', plain('agent.fanout'), {
		route: POST('/api/fleet/schedules/{id}/pause'),
		cli: 'fleet schedules pause'
	}),
	act('fleet_schedules_resume', 'schedules', 'FL-13', 'FLEET_COMMANDS_ENABLED', 'live', plain('agent.fanout'), {
		route: POST('/api/fleet/schedules/{id}/resume'),
		cli: 'fleet schedules resume'
	}),

	// ── checkouts (FL-14, FL-06) ──
	read('fleet_checkouts_list', 'checkouts', 'FL-14', 'FLEET_CHECKOUTS_ENABLED', 'live', {
		route: GET('/api/fleet/checkouts'),
		cli: 'fleet checkouts list'
	}),
	read('fleet_checkouts_get', 'checkouts', 'FL-14', 'FLEET_CHECKOUTS_ENABLED', 'live', {
		route: GET('/api/fleet/checkouts/{id}'),
		cli: 'fleet checkouts get'
	}),
	read('fleet_checkouts_changes', 'checkouts', 'FL-06', 'FLEET_CHECKOUTS_ENABLED', 'planned', {
		route: GET('/api/fleet/checkouts/{id}/changes'),
		cli: 'fleet checkouts changes'
	}),
	act('fleet_checkouts_create', 'checkouts', 'FL-14', 'FLEET_CHECKOUTS_ENABLED', 'live', plain('machine.run'), {
		route: POST('/api/fleet/checkouts'),
		cli: 'fleet checkouts create',
		waitable: true
	}),
	act('fleet_checkouts_sync', 'checkouts', 'FL-14', 'FLEET_CHECKOUTS_ENABLED', 'live', plain('machine.run'), {
		route: POST('/api/fleet/checkouts/{id}/sync'),
		cli: 'fleet checkouts sync',
		waitable: true,
		confirmationNote: 'plain for fetch; confirm for pull and push'
	}),
	act(
		'fleet_checkouts_archive',
		'checkouts',
		'FL-14',
		'FLEET_CHECKOUTS_ENABLED',
		'live',
		confirm('machine.run', false),
		{ route: POST('/api/fleet/checkouts/{id}/archive'), cli: 'fleet checkouts archive' }
	),
	act('fleet_checkouts_delete', 'checkouts', 'FL-14', 'FLEET_CHECKOUTS_ENABLED', 'live', confirm('write.destructive'), {
		route: DELETE('/api/fleet/checkouts/{id}'),
		cli: 'fleet checkouts delete',
		confirmationNote: 'confirm; confirm-destructive when it has uncommitted changes'
	}),
	act(
		'fleet_checkouts_open_pull_request',
		'checkouts',
		'FL-06',
		'FLEET_CHECKOUTS_ENABLED',
		'planned',
		plain('publish.external'),
		{ route: POST('/api/fleet/checkouts/{id}/pull-request'), cli: 'fleet checkouts pull-request' }
	),

	// ── tasks (FL-15) ── the hand-off itself is `fleet_sessions_start` with `taskId`
	read('fleet_tasks_handoff_options', 'sessions', 'FL-15', 'FLEET_CHECKOUTS_ENABLED', 'live', {
		route: GET('/api/fleet/tasks/{taskId}/handoff-options'),
		cli: 'fleet tasks handoff-options'
	}),

	// ── virtual (FL-16) ── P1 shipped: Containers. A create, a stop and a destroy are held for
	// the owner's approval by the Agent tools (`agent-fleet-virtual-tools.ts`).
	read('fleet_virtual_list', 'view', 'FL-16', 'FLEET_VIRTUAL_ENABLED', 'live', {
		phase: 'P3',
		route: GET('/api/fleet/nodes/{id}/virtual'),
		cli: 'fleet virtual list'
	}),
	read('fleet_virtual_options', 'view', 'FL-16', 'FLEET_VIRTUAL_ENABLED', 'live', {
		phase: 'P3',
		route: GET('/api/fleet/nodes/{id}/virtual/options'),
		cli: 'fleet virtual options'
	}),
	act('fleet_virtual_create', 'machines', 'FL-16', 'FLEET_VIRTUAL_ENABLED', 'live', confirm('machine.admin'), {
		phase: 'P3',
		route: POST('/api/fleet/nodes/{id}/virtual'),
		cli: 'fleet virtual create',
		waitable: true,
		alwaysHeld: true
	}),
	act('fleet_virtual_power', 'machines', 'FL-16', 'FLEET_VIRTUAL_ENABLED', 'live', confirm('machine.admin'), {
		phase: 'P3',
		route: POST('/api/fleet/nodes/{id}/virtual/{childId}/power'),
		cli: 'fleet virtual power',
		waitable: true,
		confirmationNote: 'plain to start; confirm to stop (an Agent\'s stop is held for the owner)'
	}),
	act('fleet_virtual_destroy', 'machines', 'FL-16', 'FLEET_VIRTUAL_ENABLED', 'live', typed('write.destructive'), {
		phase: 'P3',
		route: POST('/api/fleet/nodes/{id}/virtual/{childId}/destroy'),
		cli: 'fleet virtual destroy',
		waitable: true,
		alwaysHeld: true
	}),

	// ── cloud (FL-17) ──
	read('fleet_cloud_list', 'view', 'FL-17', 'FLEET_CLOUD_ENABLED', 'planned', {
		phase: 'P3',
		route: GET('/api/fleet/cloud'),
		cli: 'fleet cloud list'
	}),
	read('fleet_cloud_options', 'view', 'FL-17', 'FLEET_CLOUD_ENABLED', 'planned', {
		phase: 'P3',
		route: GET('/api/fleet/providers/{plugin}/options'),
		cli: 'fleet cloud options'
	}),
	read('fleet_cloud_usage', 'view', 'FL-17', 'FLEET_CLOUD_ENABLED', 'planned', {
		phase: 'P3',
		route: GET('/api/fleet/cloud/usage'),
		cli: 'fleet cloud usage'
	}),
	act('fleet_cloud_create', 'machines', 'FL-17', 'FLEET_CLOUD_ENABLED', 'planned', confirm('spend.metered'), {
		phase: 'P3',
		route: POST('/api/fleet/cloud'),
		cli: 'fleet cloud create',
		waitable: true,
		confirmationNote: 'confirm with the price; also machine.admin'
	}),
	act('fleet_cloud_power', 'machines', 'FL-17', 'FLEET_CLOUD_ENABLED', 'planned', confirm('machine.admin'), {
		phase: 'P3',
		route: POST('/api/fleet/cloud/{id}/power'),
		cli: 'fleet cloud power',
		waitable: true
	}),
	act('fleet_cloud_destroy', 'machines', 'FL-17', 'FLEET_CLOUD_ENABLED', 'planned', typed('write.destructive'), {
		phase: 'P3',
		route: DELETE('/api/fleet/cloud/{id}'),
		cli: 'fleet cloud destroy',
		waitable: true
	}),
	act('fleet_cloud_idle_policy', 'machines', 'FL-17', 'FLEET_CLOUD_ENABLED', 'planned', plain('machine.admin'), {
		phase: 'P3',
		route: PATCH('/api/fleet/cloud/{id}/idle-policy'),
		cli: 'fleet cloud idle-policy'
	}),

	// ── runners (FL-18) ── P1 shipped: list, install, start / stop / restart, remove. An install, a
	// stop, a restart and a remove asked by an Agent are held for the owner's approval
	// (`agent-fleet-runners-tools.ts`). The Actions jobs read and Cancel workflow run arrive with P2.
	read('fleet_runners_list', 'view', 'FL-18', 'FLEET_ACTIONS_RUNNERS_ENABLED', 'live', {
		phase: 'P3',
		route: GET('/api/fleet/nodes/{id}/runners'),
		cli: 'fleet runners list'
	}),
	read('fleet_runners_jobs', 'view', 'FL-18', 'FLEET_ACTIONS_RUNNERS_ENABLED', 'planned', {
		phase: 'P3',
		route: GET('/api/fleet/runners/jobs'),
		cli: 'fleet runners jobs'
	}),
	act(
		'fleet_runners_install',
		'machines',
		'FL-18',
		'FLEET_ACTIONS_RUNNERS_ENABLED',
		'live',
		confirm('machine.admin'),
		{
			phase: 'P3',
			route: POST('/api/fleet/nodes/{id}/runners'),
			cli: 'fleet runners install',
			waitable: true,
			alwaysHeld: true
		}
	),
	act(
		'fleet_runners_action',
		'machines',
		'FL-18',
		'FLEET_ACTIONS_RUNNERS_ENABLED',
		'live',
		confirm('machine.admin'),
		{
			phase: 'P3',
			route: POST('/api/fleet/nodes/{id}/runners/{runnerId}/{action}'),
			cli: 'fleet runners action',
			waitable: true,
			confirmationNote: "plain to start; confirm to stop and restart (an Agent's stop or restart is held for the owner)"
		}
	),
	act(
		'fleet_runners_remove',
		'machines',
		'FL-18',
		'FLEET_ACTIONS_RUNNERS_ENABLED',
		'live',
		typed('write.destructive'),
		{
			phase: 'P3',
			route: POST('/api/fleet/nodes/{id}/runners/{runnerId}/remove'),
			cli: 'fleet runners remove',
			waitable: true,
			alwaysHeld: true
		}
	),
	act(
		'fleet_runners_cancel_run',
		'machines',
		'FL-18',
		'FLEET_ACTIONS_RUNNERS_ENABLED',
		'planned',
		confirm('machine.admin'),
		{ phase: 'P3', route: POST('/api/fleet/runners/jobs/cancel'), cli: 'fleet runners cancel-run' }
	),

	// ── usage (FL-20) ──
	read('fleet_usage_get', 'view', 'FL-20', 'FLEET_USAGE_SCAN_ENABLED', 'planned', {
		route: GET('/api/fleet/usage'),
		cli: 'fleet usage'
	}),

	// ── operations (FL-02, FL-19) ──
	read('fleet_operations_get', 'view', 'FL-02', 'FLEET_NODE_LINK_ENABLED', 'live', {
		route: GET('/api/fleet/operations/{id}'),
		cli: 'fleet operations get'
	}),
	read('fleet_operations_list', 'view', 'FL-19', 'FLEET_NODE_LINK_ENABLED', 'live', {
		route: GET('/api/fleet/operations'),
		cli: 'fleet operations list'
	}),
	act('fleet_operations_cancel', 'view', 'FL-02', 'FLEET_NODE_LINK_ENABLED', 'live', plain('machine.run'), {
		route: DELETE('/api/fleet/operations/{id}'),
		cli: 'fleet operations cancel'
	})
]);

const BY_NAME: ReadonlyMap<string, FleetToolCatalogueEntry> = new Map(
	FLEET_TOOL_CATALOGUE.map((entry) => [entry.name, entry])
);

/** One row by tool name, or undefined. */
export function fleetToolEntry(name: string): FleetToolCatalogueEntry | undefined {
	return BY_NAME.get(name);
}

/** The annotation of one tool (the row without its bookkeeping), or undefined. */
export function fleetToolAnnotation(name: string): FleetToolAnnotation | undefined {
	const entry = BY_NAME.get(name);
	if (!entry) return undefined;
	const annotation: FleetToolAnnotation = { permissionFamily: entry.permissionFamily };
	if (entry.readOnly) annotation.readOnly = true;
	if (entry.destructive !== undefined) annotation.destructive = entry.destructive;
	if (entry.confirmationClass) annotation.confirmationClass = entry.confirmationClass;
	if (entry.category) annotation.category = entry.category;
	return annotation;
}

/** The rows of one tool family, in catalogue order. */
export function fleetToolsForFamily(
	family: FleetToolFamily,
	options: { status?: FleetToolStatus } = {}
): FleetToolCatalogueEntry[] {
	return FLEET_TOOL_CATALOGUE.filter(
		(entry) => entry.family === family && (options.status === undefined || entry.status === options.status)
	);
}

/** True for a read-only row. */
export function isFleetReadTool(entry: Pick<FleetToolCatalogueEntry, 'readOnly'>): boolean {
	return entry.readOnly === true;
}

/**
 * Tool name → AW-24 category for every row, so the safety gate classifies
 * every fleet tool from its own entry point (never from an argument). The
 * platform's explicit entry-point map may override a row (its owner decided).
 */
export function fleetToolEntryPointCategories(): Record<string, ActionCategory> {
	const out: Record<string, ActionCategory> = {};
	for (const entry of FLEET_TOOL_CATALOGUE) {
		if (entry.category) out[entry.name] = entry.category;
	}
	return out;
}

/**
 * Spec FR-25 — every fleet tool description says it spends nothing by itself.
 * Appended once (idempotent).
 */
export const FLEET_TOOL_NO_CREDITS_SENTENCE =
	"This tool spends no credits by itself; the Agent's own Run carries the cost of its reasoning (ask fleet_usage_get what a computer's sessions cost).";

export function withFleetToolNoCreditsSentence(description: string): string {
	if (description.includes(FLEET_TOOL_NO_CREDITS_SENTENCE)) return description;
	const trimmed = description.trimEnd();
	return trimmed.length === 0 ? FLEET_TOOL_NO_CREDITS_SENTENCE : `${trimmed} ${FLEET_TOOL_NO_CREDITS_SENTENCE}`;
}

/**
 * Spec §5.5 — the copy that carries meaning, one function per sentence so the
 * Agent tools, the API and the CLI word a refusal the same way.
 */
export const FLEET_TOOL_COPY = Object.freeze({
	noCredential: (agent: string) =>
		`Tools never carry a credential. ${agent} acts through the platform; the platform asks the computer.`,
	rungOff: (category: string, agent: string) => `'${category}' is Off for ${agent} — raise it on ${agent}'s Safety tab`,
	grantDenied: (tool: string, scope: string) => `${tool} is denied by a tool grant at ${scope} scope`,
	audience: (computer: string, audience: string, family: string) =>
		`ask the owner of ${computer} to allow ${audience}: ${family}`,
	confirm: () => 'call again with confirm: true',
	confirmName: (name: string) => `type the exact name: ${name}`,
	acknowledge: () => 'call again with confirm: true and acknowledgeBlastRadius: true',
	killSwitch: () => 'clear it under Settings → Fleet',
	permissionPromptHuman: () => 'permission prompts are answered by people'
});

/** The AW-24 category labels the hints name ("'Change a computer' is Off for Nina"). */
export const FLEET_TOOL_CATEGORY_LABELS: Readonly<Partial<Record<ActionCategory, string>>> = Object.freeze({
	'read.internal': 'Read inside the workspace',
	'write.internal': 'Change things inside the workspace',
	'write.destructive': 'Delete things',
	'publish.external': 'Publish outside the workspace',
	'spend.metered': 'Spend credits',
	'machine.run': 'Run commands on a computer',
	'machine.admin': 'Change a computer',
	'agent.fanout': 'Hire agents and set schedules'
});

// ─── Errors, confirmations, waiting ─────────────────────────────────────────

/** Spec FR-5 / CONTRACTS §8 — every tool refusal: `{ error: { code, hint, details } }`. */
export type FleetToolErrorBody = FleetLinkError;

export interface FleetToolError {
	error: FleetToolErrorBody;
}

/** Narrow a tool reply to the typed refusal envelope. */
export function isFleetToolError(value: unknown): value is FleetToolError {
	if (!value || typeof value !== 'object') return false;
	const error = (value as { error?: unknown }).error;
	return Boolean(
		error &&
			typeof error === 'object' &&
			typeof (error as { code?: unknown }).code === 'string' &&
			typeof (error as { hint?: unknown }).hint === 'string'
	);
}

/**
 * The arguments every non-read tool accepts (CONTRACTS §2.2): the confirmation
 * fields, and `wait` (default true) for one that may take longer than 5 s.
 */
export interface FleetConfirmArgs extends FleetActionConfirmFields {
	wait?: boolean;
}

/** How long a `wait: true` call waits before answering with the operation id instead (plan §3). */
export const FLEET_TOOL_WAIT_CAP_MS = 25_000;

/** `wait: false` — or a wait that ran out — answers with this (spec FR-14). */
export interface FleetToolOperationPending {
	operationId: string;
	state: 'running';
	hint: string;
}

/** An Agent call held at the Ask or Draft rung (spec S3): a Decision is waiting in My Decisions. */
export interface FleetToolHeld {
	held: true;
	decisionId: string;
	hint: string;
}

/**
 * Spec U12 default (§8b) — a held fleet action approved more than this long
 * after it was raised does not run: approval answers `confirmation_required`
 * with a fresh summary and the Agent must ask again.
 */
export const FLEET_HELD_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isFleetHeldActionStale(raisedAt: Date | string, now: Date = new Date()): boolean {
	const raised = typeof raisedAt === 'string' ? Date.parse(raisedAt) : raisedAt.getTime();
	if (!Number.isFinite(raised)) return true;
	return now.getTime() - raised > FLEET_HELD_ACTION_MAX_AGE_MS;
}

// ─── fleet_status (spec FR-4, S1) ───────────────────────────────────────────

/** One computer in `GET /api/fleet/status`. */
export interface FleetStatusComputer {
	id: string;
	name: string;
	status: string;
	kind: string;
	platform: string | null;
	/** The caller's role on it (`owner` for their own). */
	viewerRole: string;
	consents: Partial<Record<FleetConsentKey, boolean>> | null;
	/** Compact health: null when this node version reports none. */
	health: {
		cpuPercent?: number;
		memPercent?: number;
		diskPercent?: number;
		diskFreeMiB?: number;
		/** ISO receipt time of the snapshot. */
		at?: string;
	} | null;
	/** Live sessions on it the caller may see; null when sessions are off or could not be read. */
	sessionCount: number | null;
	lastSeenAt: string | null;
}

/** `GET /api/fleet/status` — "how is my fleet?" in one read-only call. */
export interface FleetStatusView {
	computers: FleetStatusComputer[];
	needsALook: NeedsALookItem[];
	/** True when a needs-a-look producer failed and was skipped (never proof that nothing needs a look). */
	needsALookPartial: boolean;
	killSwitch: FleetKillSwitchState;
	generatedAt: string;
}

// ─── The gate (spec FR-6 … FR-9, CONTRACTS §2.1) ────────────────────────────

/**
 * The gate order (AW-24 FR-19, plan §11): the first refusal wins and is the
 * one named. Published as a constant, not control flow.
 */
export const FLEET_TOOL_GATE_ORDER = [
	'kill_switch',
	'workspace_pause',
	'agent_pause',
	'grants',
	'ladder',
	'caps',
	'audience',
	'consent'
] as const;

export type FleetToolGateName = (typeof FLEET_TOOL_GATE_ORDER)[number];

/** The consent each permission family needs on the computer (CONTRACTS §1.1, §3.3). Null = none. */
export const FLEET_TOOL_FAMILY_CONSENT: Readonly<Record<FleetActionFamily, FleetConsentKey | null>> = Object.freeze({
	view: null,
	sessions: 'work',
	desktop: 'attend',
	logs: 'manage',
	services: 'manage',
	docker: 'manage',
	processes: 'manage',
	ports: 'manage',
	files: 'manage',
	commands: 'manage',
	schedules: 'manage',
	checkouts: 'manage',
	machines: 'manage'
});

/** What one Agent may do in one tool family (spec FR-24) — `GET /api/fleet/tools/gate?agentId=`. */
export interface FleetToolsGateComputer {
	nodeId: string;
	name: string;
	read: boolean;
	act: boolean;
	/** `audience` or `consent` when this computer refuses; null when it allows. */
	refusedBy: 'audience' | 'consent' | null;
	hint: string | null;
}

export type FleetToolsGateActRung = 'auto' | 'ask' | 'draft' | 'off';

export interface FleetToolsGateFamilyRow {
	family: FleetToolFamily;
	/** The CONTRACTS §2.1 family the computers are checked for (the strictest of the family's acts). */
	permissionFamily: FleetActionFamily;
	/** Any read tool of the family is granted and live. */
	read: boolean;
	/** The rung the family's acts resolve to, or null when it has no act (or none is live). */
	act: FleetToolsGateActRung | null;
	/** The first gate refusing the family's acts (CONTRACTS §2.1 order), null when nothing refuses. */
	refusedBy: FleetToolGateName | null;
	/** The sentence of spec §5.5 naming the refusal. */
	reason: string | null;
	/** Where to change it: the Agent's Safety tab, its Capabilities, Settings → Fleet, a computer's Settings. */
	fixRoute: 'agent-safety' | 'agent-capabilities' | 'fleet-settings' | 'computer-settings' | null;
	/** Tools of the family that exist on this build (status `live`). */
	tools: string[];
	/** Planned tools (registration points for families that have not landed). */
	planned: string[];
	computers: FleetToolsGateComputer[];
}

export interface FleetToolsGateView {
	agentId: string;
	agentName: string;
	killSwitch: boolean;
	families: FleetToolsGateFamilyRow[];
	generatedAt: string;
}

// ─── CLI (spec FR-19 … FR-21, CONTRACTS §11.3) ──────────────────────────────

/** `ever-works fleet …` exit codes: 0 ok, 1 refused or failed, 2 usage or missing confirmation, 124 timed out. */
export const FLEET_CLI_EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, timeout: 124 } as const);

export type FleetCliExitCode = (typeof FLEET_CLI_EXIT)[keyof typeof FLEET_CLI_EXIT];

/** The one machine contract of `--json`. */
export type FleetCliEnvelope<T> = { ok: true; data: T } | { ok: false; error: FleetToolErrorBody };

/** The exit code a refusal maps to: missing confirmation and bad input are usage (2), the rest 1. */
export function fleetCliExitFor(code: string | null | undefined): FleetCliExitCode {
	if (code === 'confirmation_required' || code === 'invalid') return FLEET_CLI_EXIT.usage;
	if (code === 'timeout' || code === 'timed_out') return FLEET_CLI_EXIT.timeout;
	return FLEET_CLI_EXIT.failed;
}

// ─── MCP (spec FR-17) ───────────────────────────────────────────────────────

/**
 * Fleet routes that are NEVER exposed as a tool (spec FR-17, plan §9.2):
 * enrolment, heartbeat, lease, node credentials, attach tokens and the
 * node-facing internal routes. Prefix match on the path template.
 */
export const FLEET_TOOL_FORBIDDEN_PATH_PREFIXES: readonly string[] = Object.freeze([
	'/api/fleet/enroll',
	'/api/fleet/heartbeat',
	'/api/fleet/jobs',
	'/api/fleet/rotate-credential',
	'/api/fleet/link-token',
	'/api/fleet/nodes/enrollment-token',
	'/api/fleet/enrollment-tokens',
	'/api/internal/fleet'
]);

/** Path fragments that are never a tool either, wherever they sit (a viewer token, a credential). */
export const FLEET_TOOL_FORBIDDEN_PATH_FRAGMENTS: readonly string[] = Object.freeze([
	'/attach-token',
	'/credential',
	'/rotate-credential'
]);

export function isFleetToolForbiddenPath(path: string): boolean {
	return (
		FLEET_TOOL_FORBIDDEN_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ||
		FLEET_TOOL_FORBIDDEN_PATH_FRAGMENTS.some((fragment) => path.includes(fragment))
	);
}

/** MCP annotation of a row: `readOnlyHint` for reads, `destructiveHint` otherwise. */
export function fleetToolMcpAnnotations(
	entry: Pick<FleetToolCatalogueEntry, 'readOnly' | 'destructive'>
): { readOnlyHint?: boolean; destructiveHint?: boolean } {
	if (entry.readOnly) return { readOnlyHint: true };
	return { destructiveHint: entry.destructive === true };
}
