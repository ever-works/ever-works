import type { FleetConfirmationClass } from './fleet-machine-actions.types.js';

/**
 * Docker on computers (FL-09 P2, spec §4.4) — containers and images as the
 * node reads them through the Docker command-line tool (never its socket,
 * README D8), and the "Run a container" request with its validation.
 *
 * Read from the Node, never stored (README §1). Compose (P3) adds its shapes
 * below the P2 ones.
 */

/** Capability tag a node advertises when `docker --version` answers (existing, CONTRACTS §1.2). */
export const FLEET_DOCKER_CAPABILITY = 'docker';

// ─── Names, ids, references (FR-36) ─────────────────────────────────────────

/** A container name Docker accepts (`[a-zA-Z0-9][a-zA-Z0-9_.-]+`), at most 128. */
export const FLEET_DOCKER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** A container or image id: 12–64 lowercase hex, optionally `sha256:`-prefixed. */
export const FLEET_DOCKER_ID_PATTERN = /^(?:sha256:)?[a-f0-9]{12,64}$/;

/**
 * An image reference: `[registry[:port]/]repo[/repo…][:tag][@sha256:digest]`.
 * Never starts with `-` (it could be read as an option), no whitespace, no
 * shell metacharacter, at most 255 characters.
 */
export const FLEET_IMAGE_REF_PATTERN =
	/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

export function isFleetDockerName(value: unknown): value is string {
	return typeof value === 'string' && FLEET_DOCKER_NAME_PATTERN.test(value);
}

export function isFleetDockerId(value: unknown): value is string {
	return typeof value === 'string' && FLEET_DOCKER_ID_PATTERN.test(value);
}

/** A container named by id or by name. */
export function isFleetContainerRef(value: unknown): value is string {
	return isFleetDockerId(value) || isFleetDockerName(value);
}

export function isFleetImageRef(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 255 && FLEET_IMAGE_REF_PATTERN.test(value);
}

// ─── Containers ─────────────────────────────────────────────────────────────

export const FLEET_CONTAINER_STATES = [
	'created',
	'running',
	'paused',
	'restarting',
	'removing',
	'exited',
	'dead',
	'unknown'
] as const;

export type FleetContainerState = (typeof FLEET_CONTAINER_STATES)[number];

export function asFleetContainerState(value: unknown): FleetContainerState {
	return typeof value === 'string' && (FLEET_CONTAINER_STATES as readonly string[]).includes(value.toLowerCase())
		? (value.toLowerCase() as FleetContainerState)
		: 'unknown';
}

/** The acts on one container (P3 adds `exec`, the shell inside). */
export const FLEET_CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'remove'] as const;

export type FleetContainerAction = (typeof FLEET_CONTAINER_ACTIONS)[number];

export function isFleetContainerAction(value: unknown): value is FleetContainerAction {
	return typeof value === 'string' && (FLEET_CONTAINER_ACTIONS as readonly string[]).includes(value);
}

/** FR-17: start / stop / restart — `confirm`; remove — `confirm-destructive` (type the name). */
export const FLEET_CONTAINER_ACTION_BASE_CLASS: Readonly<Record<FleetContainerAction, FleetConfirmationClass>> = {
	start: 'confirm',
	stop: 'confirm',
	restart: 'confirm',
	remove: 'confirm-destructive'
};

export interface FleetContainerPort {
	hostIp: string | null;
	/** Null for a port the container exposes without publishing it ("internal"). */
	hostPort: number | null;
	containerPort: number;
	proto: 'tcp' | 'udp' | 'sctp';
}

/** One container (spec §5.5). */
export interface FleetContainerView {
	/** The short (12-character) id. */
	id: string;
	name: string;
	image: string;
	state: FleetContainerState;
	/** Docker's own status line (`Up 2 hours`, `Exited (1) 3 days ago`). */
	status: string;
	ports: FleetContainerPort[];
	createdAt: string | null;
	composeProject: string | null;
	composeService: string | null;
	/** CPU percent while running. */
	cpuPercent: number | null;
	memBytes: number | null;
	/** True when the container is itself a computer in the Fleet (FL-16). */
	isNode: boolean;
	/** The acts its state allows (remove only once it is not running). */
	actions: FleetContainerAction[];
	confirmation: Partial<Record<FleetContainerAction, FleetConfirmationClass>>;
}

/** Whether Docker is there and answering (U6, U7). */
export interface FleetDockerStatus {
	installed: boolean;
	/** False when the CLI is installed but the daemon does not answer ("installed but not running"). */
	daemonRunning: boolean;
	/** The server's version when it answered. */
	version: string | null;
	/** The first line Docker printed when it did not answer. */
	message?: string;
}

/** `docker.containers` reply / `GET …/docker/containers` body. */
export interface FleetContainersListResult {
	docker: FleetDockerStatus;
	containers: FleetContainerView[];
	sampledAt: string;
}

// ─── Images ─────────────────────────────────────────────────────────────────

export interface FleetImageView {
	/** The short (12-character) id — what `…/images/:iid/:action` names (never a tag with `/`). */
	id: string;
	/** `repo:tag` names; empty for a dangling image. */
	repoTags: string[];
	sizeBytes: number | null;
	createdAt: string | null;
	/** How many containers (running or not) use it. */
	inUseBy: number;
}

/** `docker.images` reply / `GET …/docker/images` body. */
export interface FleetImagesListResult {
	docker: FleetDockerStatus;
	images: FleetImageView[];
	/** Images no container uses — what "Remove unused" would remove. */
	unusedCount: number;
	unusedBytes: number;
	sampledAt: string;
}

/** The one image act on `…/images/:iid/:action` (pull is POST on the collection, prune DELETE on it). */
export const FLEET_IMAGE_ACTIONS = ['remove'] as const;

export type FleetImageAction = (typeof FLEET_IMAGE_ACTIONS)[number];

export function isFleetImageAction(value: unknown): value is FleetImageAction {
	return typeof value === 'string' && (FLEET_IMAGE_ACTIONS as readonly string[]).includes(value);
}

/** `docker.image.remove` reply. */
export interface FleetImageRemoveResult {
	removed: string[];
}

/** `docker.image.prune` reply (as an operation's result, or at once when there was nothing to do — U15). */
export interface FleetImagePruneResult {
	reclaimedBytes: number;
	removedCount: number;
	/** True when nothing was unused: the node ran nothing and nothing is audited. */
	nothingToDo?: boolean;
}

/** `docker.image.pull` result. */
export interface FleetImagePullResult {
	ref: string;
	/** The pulled image's id, when Docker said. */
	imageId: string | null;
}

// ─── Run a container (FR-28) ────────────────────────────────────────────────

export const FLEET_RUN_RESTART_POLICIES = ['no', 'always', 'unless-stopped', 'on-failure'] as const;

export type FleetRunRestartPolicy = (typeof FLEET_RUN_RESTART_POLICIES)[number];

/** Bounds of one run request. */
export const FLEET_RUN_LIMITS = {
	ports: 32,
	env: 64,
	volumes: 32,
	commandArgs: 64,
	argLength: 1024,
	envValueLength: 8192,
	pathLength: 1024
} as const;

/** An environment variable NAME the dialog accepts (the value is free text, never logged). */
export const FLEET_RUN_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Names refused for a run's environment: the values travel through the Docker
 * CLI's OWN environment (never its command line), so a name the CLI itself
 * reads (`PATH`, `DOCKER_HOST`, a loader variable) would change what runs.
 */
export const FLEET_RUN_RESERVED_ENV = /^(PATH|Path|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z]+|LD_[A-Z_]+|DYLD_[A-Z_]+|DOCKER_[A-Z_]+|NODE_[A-Z_]+|SYSTEMROOT|SystemRoot|ComSpec|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA)$/;

/** A named volume (`pgdata`) rather than a host path. */
export const FLEET_DOCKER_VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** The Docker socket, refused as a mount source or target in every spelling (U13). */
export const FLEET_DOCKER_SOCKET_PATTERN = /docker\.sock|docker_engine|\/run\/containerd/i;

export interface FleetRunPort {
	host: number;
	container: number;
	proto?: 'tcp' | 'udp';
}

export interface FleetRunEnv {
	name: string;
	/** Never stored, never logged, never shown again (FR-29). */
	value: string;
}

export interface FleetRunVolume {
	/** A named volume, or an absolute host path under this computer's shared folders (R-18). */
	source: string;
	/** An absolute path inside the container. */
	target: string;
	readOnly?: boolean;
}

/** The "Run a container" request (spec §5.5, FR-28). Every field is allow-listed: there is no free-form flag. */
export interface FleetRunRequest {
	image: string;
	name?: string;
	ports: FleetRunPort[];
	env: FleetRunEnv[];
	volumes: FleetRunVolume[];
	restart: FleetRunRestartPolicy;
	/** The command and its arguments, each one argv element. */
	command?: string[];
}

/** Request keys that ask for something "Run a container" never does (U13). */
const DANGEROUS_KEYS = [
	'privileged',
	'network',
	'net',
	'pid',
	'ipc',
	'uts',
	'userns',
	'capAdd',
	'cap_add',
	'devices',
	'device',
	'securityOpt',
	'extraArgs',
	'args',
	'entrypoint'
];

/** The U13 hint, word for word. */
export const FLEET_RUN_DANGEROUS_HINT =
	'Mounts must be under this computer’s shared folders; privileged, host-namespace and socket mounts are not available from here.';

export type FleetRunValidation =
	| { ok: true; request: FleetRunRequest }
	| { ok: false; field: string; hint: string };

function isAbsoluteContainerPath(value: string): boolean {
	return value.startsWith('/') && !value.includes('\0') && !/(^|\/)\.\.(\/|$)/.test(value);
}

/** True for a host path (absolute on Unix or Windows) rather than a named volume. */
export function isFleetHostPath(value: string): boolean {
	return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * Validate a run request off the wire (FR-28, U13) — on the platform AND on
 * the machine. Host-path mounts are checked against the shared folders on the
 * machine only (the platform does not know them); everything else is here.
 */
export function validateFleetRunRequest(raw: unknown): FleetRunValidation {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, field: 'request', hint: 'a run request is an object' };
	const input = raw as Record<string, unknown>;
	for (const key of DANGEROUS_KEYS) {
		if (key in input) return { ok: false, field: key, hint: FLEET_RUN_DANGEROUS_HINT };
	}
	if (!isFleetImageRef(input.image)) return { ok: false, field: 'image', hint: 'that is not an image reference' };
	if (input.name !== undefined && input.name !== '' && !isFleetDockerName(input.name)) {
		return { ok: false, field: 'name', hint: 'a container name is letters, digits, _ . -' };
	}
	const ports: FleetRunPort[] = [];
	const rawPorts = Array.isArray(input.ports) ? input.ports : input.ports === undefined ? [] : null;
	if (!rawPorts || rawPorts.length > FLEET_RUN_LIMITS.ports) return { ok: false, field: 'ports', hint: 'too many ports' };
	for (const entry of rawPorts) {
		const port = (entry ?? {}) as Record<string, unknown>;
		const valid = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
		if (!valid(port.host) || !valid(port.container)) return { ok: false, field: 'ports', hint: 'a port is a number from 1 to 65535' };
		if (port.proto !== undefined && port.proto !== 'tcp' && port.proto !== 'udp') {
			return { ok: false, field: 'ports', hint: 'a port is tcp or udp' };
		}
		ports.push({ host: port.host as number, container: port.container as number, proto: (port.proto as 'tcp' | 'udp') ?? 'tcp' });
	}
	const env: FleetRunEnv[] = [];
	const rawEnv = Array.isArray(input.env) ? input.env : input.env === undefined ? [] : null;
	if (!rawEnv || rawEnv.length > FLEET_RUN_LIMITS.env) return { ok: false, field: 'env', hint: 'too many environment variables' };
	const seen = new Set<string>();
	for (const entry of rawEnv) {
		const variable = (entry ?? {}) as Record<string, unknown>;
		if (typeof variable.name !== 'string' || !FLEET_RUN_ENV_NAME_PATTERN.test(variable.name)) {
			return { ok: false, field: 'env', hint: 'an environment variable name is letters, digits and _' };
		}
		if (FLEET_RUN_RESERVED_ENV.test(variable.name)) {
			return { ok: false, field: 'env', hint: `${variable.name} cannot be set from here` };
		}
		if (seen.has(variable.name)) return { ok: false, field: 'env', hint: `${variable.name} is set twice` };
		seen.add(variable.name);
		if (typeof variable.value !== 'string' || variable.value.length > FLEET_RUN_LIMITS.envValueLength || variable.value.includes('\0')) {
			return { ok: false, field: 'env', hint: `the value of ${variable.name} is too long or not text` };
		}
		env.push({ name: variable.name, value: variable.value });
	}
	const volumes: FleetRunVolume[] = [];
	const rawVolumes = Array.isArray(input.volumes) ? input.volumes : input.volumes === undefined ? [] : null;
	if (!rawVolumes || rawVolumes.length > FLEET_RUN_LIMITS.volumes) return { ok: false, field: 'volumes', hint: 'too many volumes' };
	for (const entry of rawVolumes) {
		const volume = (entry ?? {}) as Record<string, unknown>;
		if (typeof volume.source !== 'string' || typeof volume.target !== 'string') {
			return { ok: false, field: 'volumes', hint: 'a volume has a source and a target' };
		}
		const { source, target } = volume;
		if (FLEET_DOCKER_SOCKET_PATTERN.test(source) || FLEET_DOCKER_SOCKET_PATTERN.test(target)) {
			return { ok: false, field: 'volumes', hint: FLEET_RUN_DANGEROUS_HINT };
		}
		if (source.length > FLEET_RUN_LIMITS.pathLength || target.length > FLEET_RUN_LIMITS.pathLength) {
			return { ok: false, field: 'volumes', hint: 'a path is too long' };
		}
		if (!isFleetHostPath(source) && !FLEET_DOCKER_VOLUME_NAME_PATTERN.test(source)) {
			return { ok: false, field: 'volumes', hint: 'a volume source is a named volume or a folder' };
		}
		// `:` and `,` would split Docker's -v syntax; a target must be an absolute container path.
		if (/[,\n\r\0]/.test(source) || (source.includes(':') && !/^[A-Za-z]:[\\/]/.test(source)) || source.slice(2).includes(':')) {
			return { ok: false, field: 'volumes', hint: 'a volume source cannot contain : or ,' };
		}
		if (!isAbsoluteContainerPath(target) || /[:,]/.test(target)) {
			return { ok: false, field: 'volumes', hint: 'a volume target is an absolute path inside the container' };
		}
		volumes.push({ source, target, readOnly: volume.readOnly === true });
	}
	const restart = input.restart === undefined ? 'no' : input.restart;
	if (typeof restart !== 'string' || !(FLEET_RUN_RESTART_POLICIES as readonly string[]).includes(restart)) {
		return { ok: false, field: 'restart', hint: 'restart is no, always, unless-stopped or on-failure' };
	}
	let command: string[] | undefined;
	if (input.command !== undefined) {
		if (!Array.isArray(input.command) || input.command.length > FLEET_RUN_LIMITS.commandArgs) {
			return { ok: false, field: 'command', hint: 'the command is a list of arguments' };
		}
		for (const arg of input.command) {
			if (typeof arg !== 'string' || arg.length > FLEET_RUN_LIMITS.argLength || /[\0\r\n]/.test(arg)) {
				return { ok: false, field: 'command', hint: 'a command argument is one line of text' };
			}
		}
		command = input.command.length > 0 ? [...(input.command as string[])] : undefined;
	}
	const request: FleetRunRequest = {
		image: input.image,
		ports,
		env,
		volumes,
		restart: restart as FleetRunRestartPolicy
	};
	if (typeof input.name === 'string' && input.name) request.name = input.name;
	if (command) request.command = command;
	return { ok: true, request };
}

/** One argv element as a person would read it (for the preview line only — never executed). */
function shown(arg: string): string {
	return /^[A-Za-z0-9@%+=:,./_-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact command line a run executes, as the dialog shows it before the
 * person confirms (FR-28, spec §5.5) — with every environment VALUE replaced
 * by `…` (FR-29): `docker run -d --name cache -p 6379:6379 -e REDIS_ARGS=…
 * --restart unless-stopped redis:7`.
 */
export function fleetRunPreview(request: FleetRunRequest): string {
	const parts = ['docker', 'run', '-d'];
	if (request.name) parts.push('--name', request.name);
	for (const port of request.ports) {
		parts.push('-p', `${port.host}:${port.container}${port.proto && port.proto !== 'tcp' ? `/${port.proto}` : ''}`);
	}
	for (const variable of request.env) parts.push('-e', `${variable.name}=…`);
	for (const volume of request.volumes) {
		parts.push('-v', `${volume.source}:${volume.target}${volume.readOnly ? ':ro' : ''}`);
	}
	if (request.restart !== 'no') parts.push('--restart', request.restart);
	parts.push(request.image, ...(request.command ?? []));
	return parts.map((part, index) => (index < 3 || part.endsWith('=…') ? part : shown(part))).join(' ');
}
