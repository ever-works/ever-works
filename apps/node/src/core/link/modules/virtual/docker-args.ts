import { fleetVirtualContainerName, isFleetVirtualName } from '@ever-works/contracts';
import { mountSpec } from '../machine-facts/docker-ops';

/**
 * Virtual computers (FL-16, plan §6.1, §6.7, threat 1) — the exact argv of
 * every Docker call FL-16 makes, built here so a test can pin it for every
 * system. Argument arrays only (the runner never uses a shell); every value is
 * validated before it reaches an argv, and nothing here is a free-form flag.
 *
 * What a child is NEVER given (NFR Security, threat 4): the Docker socket, the
 * host's config folder, the host's node credential, privileged mode or a host
 * namespace. It sees exactly two things of its own: its home, a named Docker
 * volume `ew-virtual-<childId>-home` (kept by a rebuild, removed by a destroy),
 * and `run/` under the host's virtual data folder, read-only, holding only the
 * bootstrap. A named volume rather than a host folder (lane decision 9): what
 * the guest writes as its own root never lands in a host folder the node's
 * user could not then delete.
 */

/** Label every virtual computer's container carries, so `vm.list` finds them all. */
export const VIRTUAL_CONTAINER_LABEL = 'works.ever.fleet.virtual';
/** Label naming the child Node id. */
export const VIRTUAL_CHILD_LABEL = 'works.ever.fleet.virtual.child';

/** Where the child's own folders are mounted inside it. */
export const GUEST_HOME = '/home/ever';
export const GUEST_RUN = '/run/ever-works';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChildNodeId(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

export interface ContainerRunInput {
	childNodeId: string;
	/** The child's Fleet name (its hostname). */
	name: string;
	/** `repository@sha256:…` (or a tag before the first pin). */
	image: string;
	cpus: number;
	memoryGiB: number;
	/** Absolute host path of the child's `run/` folder (the bootstrap). */
	runDir: string;
}

/** The named volume a child's home lives in. */
export function homeVolumeName(childNodeId: string): string {
	if (!isChildNodeId(childNodeId)) throw new Error('a virtual computer id must be a uuid');
	return `ew-virtual-${childNodeId}-home`;
}

/**
 * `docker run` for a Container (plan §6.7): detached, named
 * `ew-virtual-<childId>`, its own hostname, an init process, the CPU / memory
 * caps and a process cap, restarted with the Docker daemon unless stopped, the
 * two mounts, and the bootstrap as its command.
 */
export function containerRunArgs(input: ContainerRunInput): string[] {
	if (!isChildNodeId(input.childNodeId)) throw new Error('a virtual computer id must be a uuid');
	if (!isFleetVirtualName(input.name)) throw new Error('a virtual computer name must match the name pattern');
	if (!Number.isInteger(input.cpus) || input.cpus < 1 || input.cpus > 64) throw new Error('cpus out of range');
	if (!Number.isInteger(input.memoryGiB) || input.memoryGiB < 1 || input.memoryGiB > 256) {
		throw new Error('memory out of range');
	}
	// `--mount` is comma-separated key=value pairs: a comma would split the path.
	if (!input.runDir.startsWith('/') || input.runDir.includes(',')) {
		throw new Error('a virtual computer folder must be an absolute path');
	}
	return [
		'run',
		'-d',
		'--name',
		fleetVirtualContainerName(input.childNodeId),
		'--hostname',
		input.name,
		'--init',
		'--cpus',
		String(input.cpus),
		'--memory',
		`${input.memoryGiB}g`,
		'--pids-limit',
		'4096',
		'--restart',
		'unless-stopped',
		'--label',
		`${VIRTUAL_CONTAINER_LABEL}=true`,
		'--label',
		`${VIRTUAL_CHILD_LABEL}=${input.childNodeId}`,
		'--env',
		`HOME=${GUEST_HOME}`,
		'--mount',
		`type=volume,source=${homeVolumeName(input.childNodeId)},target=${GUEST_HOME}`,
		'--mount',
		mountSpec(input.runDir, GUEST_RUN, true),
		'--entrypoint',
		'/bin/sh',
		input.image,
		`${GUEST_RUN}/bootstrap.sh`
	];
}

const GUEST_PATH_PATTERN = /^\/[A-Za-z0-9._\/-]+$/;

/** `docker volume rm -f` of a destroyed child's home. */
export function homeVolumeRemoveArgs(childNodeId: string): string[] {
	return ['volume', 'rm', '-f', homeVolumeName(childNodeId)];
}

function guestContainer(childNodeId: string, path: string): string {
	if (!isChildNodeId(childNodeId)) throw new Error('a virtual computer id must be a uuid');
	if (!GUEST_PATH_PATTERN.test(path)) throw new Error('a guest path must be a plain absolute path');
	return fleetVirtualContainerName(childNodeId);
}

/** `docker exec <child> test -f <path>` — whether the guest wrote a marker. */
export function guestTestFileArgs(childNodeId: string, path: string): string[] {
	return ['exec', guestContainer(childNodeId, path), 'test', '-f', path];
}

/**
 * `docker exec -i <child> sh -c '<constant>'` — writes STDIN to the guest's
 * private token file (0600, atomically by rename). The script is a constant
 * built from a validated path: the token travels on stdin only, never on a
 * command line or a host disk.
 */
export function guestWriteTokenArgs(childNodeId: string, path: string): string[] {
	const container = guestContainer(childNodeId, path);
	const dir = path.slice(0, path.lastIndexOf('/')) || '/';
	return ['exec', '-i', container, 'sh', '-c', `umask 077 && mkdir -p ${dir} && cat > ${path}.part && mv ${path}.part ${path}`];
}

/** `docker exec <child> rm -f <path>` — the belt behind `enroll --token-file`'s own delete. */
export function guestRemoveFileArgs(childNodeId: string, path: string): string[] {
	return ['exec', guestContainer(childNodeId, path), 'rm', '-f', path];
}

/** `docker start` / `docker stop -t <grace>` / `docker rm -f` of one child. */
export function containerControlArgs(
	action: 'start' | 'stop' | 'remove' | 'inspect' | 'logs',
	childNodeId: string,
	graceSec = 10
): string[] {
	if (!isChildNodeId(childNodeId)) throw new Error('a virtual computer id must be a uuid');
	const name = fleetVirtualContainerName(childNodeId);
	switch (action) {
		case 'start':
			return ['start', name];
		case 'stop':
			return ['stop', '-t', String(Math.max(0, Math.min(600, Math.round(graceSec)))), name];
		case 'remove':
			return ['rm', '-f', name];
		case 'inspect':
			return ['inspect', '--format', '{{.State.Status}}', name];
		case 'logs':
			return ['logs', '--tail', '5', name];
	}
}

/** Every virtual computer's container on this machine, one JSON object per line. */
export function containerListArgs(): string[] {
	return ['ps', '-a', '--no-trunc', '--filter', `label=${VIRTUAL_CONTAINER_LABEL}=true`, '--format', '{{json .}}'];
}

/** `docker pull <ref>`. */
export function imagePullArgs(ref: string): string[] {
	return ['pull', ref];
}

/** The content digest a pulled reference resolved to (`repository@sha256:…`). */
export function imageDigestArgs(ref: string): string[] {
	return ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', ref];
}
