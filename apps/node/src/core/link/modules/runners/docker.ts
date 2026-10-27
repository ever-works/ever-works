import { isFleetActionsRunnerName } from '@ever-works/contracts';
import { firstOutputLine, RunnerHostError, type RunnerExecResult, type RunnerHostDeps } from './host';
import { RUNNER_TOKEN_ENV, runnerConfigArgs, runnerRemoveArgs, type RunnerConfigInput } from './config';
import type { RunnerMeta } from './state';

/**
 * Actions runners on computers (FL-18 P3, plan §6.1 `runner-docker.ts`, spec
 * FR-27, T-27) — a Docker-isolated runner: each runner in its own container,
 * restarted by Docker, on a Linux computer that has Docker.
 *
 * The runner itself is still GitHub's build this node downloaded and verified
 * against GitHub's SHA-256 (the same folder a service runner uses); the
 * container only supplies the userland it runs in — GitHub's own runner image,
 * pinned to the digest this node resolved the first time it pulled it. The
 * folder is mounted at {@link RUNNER_CONTAINER_DIR} and the container runs as
 * the node's own user, so the runner writes nothing on the host outside its
 * folder.
 *
 *  - **Registration** runs `config.sh` in a throw-away container
 *    (`docker run --rm`); the one-time token reaches it as
 *    `-e ACTIONS_RUNNER_INPUT_TOKEN` WITHOUT a value — Docker copies the value
 *    from the CLI's own environment, so it is never on a command line and
 *    never stored in the long-lived container's configuration.
 *  - **The runner** is `docker run -d --restart unless-stopped … ./run.sh`.
 *  - **No Docker daemon inside** by default: the host's Docker socket is mounted
 *    only when the owner ticked "share the Docker daemon (runs as root)" (FR-27).
 *  - **Never the node's credential**: nothing of the node's configuration folder
 *    is mounted; the environment is Docker's default plus the runner's own.
 */

/** GitHub's own runner image (its tags follow the runner version). */
export const RUNNER_DOCKER_IMAGE = 'ghcr.io/actions/actions-runner';

/** Where the runner's folder is mounted inside its container. */
export const RUNNER_CONTAINER_DIR = '/actions-runner';

/** The host's Docker socket, mounted only with the labelled opt-in. */
export const DOCKER_SOCKET = '/var/run/docker.sock';

/** The label every runner container carries (the runner row's id). */
export const RUNNER_CONTAINER_LABEL = 'works.ever.fleet.actions-runner';

const RUNNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_REF = /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/;
const DOCKER_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 20 * 60 * 1000;

/** The container's name: one per runner row. */
export function runnerContainerName(runnerId: string): string {
	if (!RUNNER_ID.test(runnerId)) throw new RunnerHostError('not a runner id', 'invalid');
	return `ew-actions-runner-${runnerId.toLowerCase()}`;
}

/** The image tag for a runner version (`2.321.0` → `ghcr.io/actions/actions-runner:2.321.0`). */
export function runnerImageTag(version: string | null): string {
	return `${RUNNER_DOCKER_IMAGE}:${version && /^\d+\.\d+\.\d+$/.test(version) ? version : 'latest'}`;
}

/** `docker pull <tag>`. */
export function imagePullArgs(tag: string): string[] {
	return ['pull', '--quiet', tag];
}

/** `docker image inspect` printing the repository digest (`<repo>@sha256:…`). */
export function imageDigestArgs(tag: string): string[] {
	return ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', tag];
}

/** True when `ref` is a pinned `<repo>@sha256:<64 hex>` of GitHub's runner image. */
export function isPinnedRunnerImage(ref: string): boolean {
	return DIGEST_REF.test(ref) && ref.startsWith(`${RUNNER_DOCKER_IMAGE}@`);
}

interface ContainerBase {
	runnerId: string;
	/** The runner's folder on the host. */
	dir: string;
	/** `<repo>@sha256:…` — never a tag. */
	image: string;
	/** `uid:gid` of the node's user. */
	user: string;
}

function baseRunArgs(input: ContainerBase): string[] {
	if (!isPinnedRunnerImage(input.image))
		throw new RunnerHostError('the runner image is not pinned to a digest', 'invalid');
	if (!/^\d+:\d+$/.test(input.user)) throw new RunnerHostError('the container user is not a uid:gid', 'invalid');
	// `--mount` is comma-separated key=value pairs: a comma, quote or newline in the folder would split it.
	if (/[,"\r\n]/.test(input.dir)) {
		throw new RunnerHostError('the runner folder has a character Docker cannot mount', 'invalid');
	}
	return [
		'--user',
		input.user,
		'--label',
		`${RUNNER_CONTAINER_LABEL}=${input.runnerId.toLowerCase()}`,
		'--mount',
		`type=bind,source=${input.dir},target=${RUNNER_CONTAINER_DIR}`,
		'--workdir',
		RUNNER_CONTAINER_DIR
	];
}

/**
 * `docker run --rm` that registers the runner. The token is `-e NAME` with no
 * value (Docker reads it from its own environment) — never on argv.
 */
export function runnerDockerConfigArgs(input: ContainerBase & { config: RunnerConfigInput }): string[] {
	return [
		'run',
		'--rm',
		'--name',
		`${runnerContainerName(input.runnerId)}-config`,
		...baseRunArgs(input),
		'-e',
		RUNNER_TOKEN_ENV,
		input.image,
		`${RUNNER_CONTAINER_DIR}/config.sh`,
		...runnerConfigArgs({ ...input.config, platform: 'linux' })
	];
}

/** `docker run --rm` that deregisters the runner (`config.sh remove`, the remove token by name only). */
export function runnerDockerRemoveArgs(input: ContainerBase): string[] {
	return [
		'run',
		'--rm',
		'--name',
		`${runnerContainerName(input.runnerId)}-remove`,
		...baseRunArgs(input),
		'-e',
		RUNNER_TOKEN_ENV,
		input.image,
		`${RUNNER_CONTAINER_DIR}/config.sh`,
		...runnerRemoveArgs()
	];
}

/** The long-lived runner container. The Docker socket only with the labelled opt-in. */
export function runnerDockerRunArgs(input: ContainerBase & { shareDockerDaemon: boolean }): string[] {
	return [
		'run',
		'-d',
		'--name',
		runnerContainerName(input.runnerId),
		'--restart',
		'unless-stopped',
		'--init',
		...baseRunArgs(input),
		...(input.shareDockerDaemon ? ['--mount', `type=bind,source=${DOCKER_SOCKET},target=${DOCKER_SOCKET}`] : []),
		input.image,
		`${RUNNER_CONTAINER_DIR}/run.sh`
	];
}

/** start / stop / restart / rm -f / inspect of one runner's container. */
export function runnerContainerArgs(
	action: 'start' | 'stop' | 'restart' | 'remove' | 'inspect',
	runnerId: string
): string[] {
	const name = runnerContainerName(runnerId);
	switch (action) {
		case 'start':
			return ['start', name];
		case 'stop':
			return ['stop', '-t', '30', name];
		case 'restart':
			return ['restart', '-t', '30', name];
		case 'remove':
			return ['rm', '-f', name];
		case 'inspect':
			return ['inspect', '--format', '{{.State.Status}}', name];
	}
}

async function docker(
	deps: Pick<RunnerHostDeps, 'exec'>,
	args: string[],
	timeoutMs: number,
	what: string,
	env?: Readonly<Record<string, string>>
): Promise<RunnerExecResult> {
	const result = await deps.exec({ command: 'docker', args, timeoutMs, ...(env ? { env } : {}) });
	if (result.spawnError) throw new RunnerHostError('Docker was not found on this computer', 'unsupported_on_node');
	if (result.code !== 0) throw new RunnerHostError(`${what}: ${firstOutputLine(result, 'docker failed')}`);
	return result;
}

/** Pull GitHub's runner image for this version and answer it pinned to its digest (trust on first use). */
export async function pinRunnerImage(deps: Pick<RunnerHostDeps, 'exec'>, version: string | null): Promise<string> {
	const tag = runnerImageTag(version);
	await docker(deps, imagePullArgs(tag), PULL_TIMEOUT_MS, `could not pull ${tag}`);
	const inspected = await docker(
		deps,
		imageDigestArgs(tag),
		DOCKER_TIMEOUT_MS,
		`could not read the digest of ${tag}`
	);
	const ref = inspected.stdout.trim();
	if (!isPinnedRunnerImage(ref)) throw new RunnerHostError(`${tag} has no digest Ever Works can pin`);
	return ref;
}

/** Register the runner in a throw-away container; the token travels in Docker's environment only. */
export async function configureDockerRunner(
	deps: Pick<RunnerHostDeps, 'exec'>,
	input: ContainerBase & { config: RunnerConfigInput },
	token: string
): Promise<void> {
	if (!isFleetActionsRunnerName(input.config.name)) throw new RunnerHostError('not a runner name', 'invalid');
	await docker(deps, runnerDockerConfigArgs(input), 5 * 60 * 1000, 'GitHub did not register the runner', {
		[RUNNER_TOKEN_ENV]: token
	});
}

/** Start the long-lived container (removing a leftover of the same name first). */
export async function startDockerRunner(
	deps: Pick<RunnerHostDeps, 'exec'>,
	input: ContainerBase & { shareDockerDaemon: boolean }
): Promise<string> {
	await deps.exec({
		command: 'docker',
		args: runnerContainerArgs('remove', input.runnerId),
		timeoutMs: DOCKER_TIMEOUT_MS
	});
	await docker(deps, runnerDockerRunArgs(input), DOCKER_TIMEOUT_MS, 'could not start the runner container');
	return runnerContainerName(input.runnerId);
}

/** Deregister in a throw-away container with the remove token (Docker's environment only). */
export async function deregisterDockerRunner(
	deps: Pick<RunnerHostDeps, 'exec'>,
	input: ContainerBase,
	token: string
): Promise<boolean> {
	const result = await deps.exec({
		command: 'docker',
		args: runnerDockerRemoveArgs(input),
		timeoutMs: 5 * 60 * 1000,
		env: { [RUNNER_TOKEN_ENV]: token }
	});
	return !result.spawnError && result.code === 0;
}

/** start / stop / restart / remove of a runner's container. */
export async function controlDockerRunner(
	deps: Pick<RunnerHostDeps, 'exec'>,
	meta: Pick<RunnerMeta, 'runnerId' | 'name'>,
	action: 'start' | 'stop' | 'restart' | 'remove'
): Promise<void> {
	const result = await deps.exec({
		command: 'docker',
		args: runnerContainerArgs(action, meta.runnerId),
		timeoutMs: DOCKER_TIMEOUT_MS
	});
	if (result.spawnError) throw new RunnerHostError('Docker was not found on this computer', 'unsupported_on_node');
	if (result.code !== 0 && !(action === 'remove' && /No such container/i.test(result.stderr))) {
		throw new RunnerHostError(
			`could not ${action} ${meta.name}: ${firstOutputLine(result, `docker ${action} failed`)}`
		);
	}
}

/** What Docker says about one runner's container (`runner.list`). */
export async function dockerRunnerState(
	deps: Pick<RunnerHostDeps, 'exec'>,
	runnerId: string
): Promise<'running' | 'stopped' | 'missing' | 'unknown'> {
	const result = await deps.exec({
		command: 'docker',
		args: runnerContainerArgs('inspect', runnerId),
		timeoutMs: 15_000
	});
	if (result.spawnError) return 'unknown';
	if (result.code !== 0) return /No such/i.test(result.stderr) ? 'missing' : 'unknown';
	const status = result.stdout.trim();
	if (status === 'running' || status === 'restarting') return 'running';
	if (status === 'exited' || status === 'created' || status === 'paused' || status === 'dead') return 'stopped';
	return 'unknown';
}
