import { existsSync } from 'node:fs';
import {
	isFleetComposeAction,
	isFleetComposeProject,
	isFleetComposeService,
	isFleetContainerShell,
	type FleetComposeDescription,
	type FleetComposeListResult,
	type FleetContainerShellsResult,
	FLEET_MACHINE_OPERATIONS_PER_NODE,
	isFleetContainerAction,
	isFleetContainerRef,
	isFleetDockerId,
	isFleetHostPath,
	isFleetImageRef,
	makeFleetLinkError,
	validateFleetRunRequest,
	FLEET_RUN_DANGEROUS_HINT,
	type FleetContainerAction,
	type FleetContainersListResult,
	type FleetDockerStatus,
	type FleetImagePruneResult,
	type FleetImagePullResult,
	type FleetImageRemoveResult,
	type FleetImagesListResult
} from '@ever-works/contracts';
import type { CommandRunner } from '../../capabilities';
import { realpath } from 'node:fs/promises';
import { isWithinAllowedRoots } from '../allowed-roots';
import {
	countImageUse,
	DOCKER,
	dockerStatus,
	parseContainers,
	parseImages,
	parseStats
} from './machine-facts/docker-cli';
import { createPullProgress, dockerRunArgv, parsePruneSummary, safeOutputLine } from './machine-facts/docker-ops';
import {
	composeActionArgs,
	composeFileArgs,
	mergeComposeServices,
	parseComposeConfig,
	parseComposeLs,
	parseComposePs,
	projectView
} from './machine-facts/compose';
import { createMachineCommandRunner, firstLine } from './machine-facts/exec';
import { createStreamRunner, type StreamRunner } from './machine-facts/stream';
import { MachineVerbError, type MachineVerbContext, type NodeModule } from './registry';

/**
 * Docker on computers (FL-09 P2, spec §4.4) — the `docker` node module: the
 * `docker.*` verbs on the `machine` channel, through the Docker CLI only
 * (README D8, FR-25 — nothing here opens or mounts the daemon's socket).
 *
 *  - reads: `docker.containers` (with CPU and memory of running ones),
 *    `docker.images` (with in-use counts and what "Remove unused" frees);
 *  - acts: `docker.container.action` (start / stop / restart / remove — a
 *    running container is never removed, anonymous volumes are kept, named
 *    ones never touched), `docker.image.remove` (an image in use answers
 *    `busy` naming the container);
 *  - operations: `docker.run`, `docker.image.pull`, `docker.image.prune` — long
 *    enough that the machine family reports them as operations with
 *    progress. At most {@link FLEET_MACHINE_OPERATIONS_PER_NODE} run at once
 *    (a sixth answers `busy`, U16); each is killed after 60 minutes.
 *
 * `docker.run` re-validates the request on the machine (FR-28, U13): the
 * allow-listed fields only, bind-mount sources under this computer's shared
 * folders (R-18, R-39), no socket; environment values travel through the
 * CLI's own environment, never its command line, and are masked out of every
 * output line (FR-29).
 */

export interface DockerModuleDeps {
	runner?: CommandRunner;
	stream?: StreamRunner;
	platform?: string;
	/** The shared folders a bind mount may come from (R-18; the runtime resolves them). */
	allowedRoots?: () => Promise<string[]>;
	now?: () => Date;
	/** Whether a Compose config file is still there (U14); injected for tests. */
	fileExists?: (path: string) => boolean;
}

const ACTION_TIMEOUT_MS = 120_000;

/**
 * True when a bind-mount source is one of the shared folders or inside one
 * (R-18): the source must exist, and both it and the roots are compared by
 * their REAL paths, so a link inside a root that points out of it is refused
 * (the shared resolver answers the lexical question; the symlink check is the
 * caller's, R-39).
 */
export async function bindSourceAllowed(
	source: string,
	roots: readonly string[],
	platform: string,
	resolveReal: (target: string) => Promise<string> = (target) => realpath(target)
): Promise<boolean> {
	let real: string;
	try {
		real = await resolveReal(source);
	} catch {
		return false;
	}
	const realRoots: string[] = [];
	for (const root of roots) {
		try {
			realRoots.push(await resolveReal(root));
		} catch {
			// a root that is not there admits nothing
		}
	}
	return isWithinAllowedRoots(real, realRoots, platform);
}

function refuse(
	code: Parameters<typeof makeFleetLinkError>[0],
	hint: string,
	details?: Record<string, unknown>
): MachineVerbError {
	return new MachineVerbError(makeFleetLinkError(code, hint, details));
}

export function createDockerModule(deps: DockerModuleDeps = {}): NodeModule {
	const runner = deps.runner ?? createMachineCommandRunner();
	const stream = deps.stream ?? createStreamRunner();
	const platform = deps.platform ?? process.platform;
	const now = deps.now ?? (() => new Date());
	const fileExists = deps.fileExists ?? ((path: string) => existsSync(path));
	let runningOperations = 0;

	/** Docker must answer: `unsupported_on_node` when it is not installed (U6), `operation_failed` when its daemon is down (U7). */
	const requireDaemon = async (machine: string): Promise<FleetDockerStatus> => {
		const status = await dockerStatus(runner);
		if (!status.installed)
			throw refuse('unsupported_on_node', `Docker is not installed on ${machine}`, { docker: status });
		if (!status.daemonRunning) {
			throw refuse('operation_failed', `Docker is installed but not running on ${machine}`, { docker: status });
		}
		return status;
	};

	/** Run one long act under the per-node operation cap. */
	const asOperation = async <T>(machine: string, work: () => Promise<T>): Promise<T> => {
		if (runningOperations >= FLEET_MACHINE_OPERATIONS_PER_NODE) {
			throw refuse('busy', `${machine} is already running ${FLEET_MACHINE_OPERATIONS_PER_NODE} operations`);
		}
		runningOperations += 1;
		try {
			return await work();
		} finally {
			runningOperations -= 1;
		}
	};

	const containers = async (context: MachineVerbContext): Promise<FleetContainersListResult> => {
		const status = await dockerStatus(runner);
		if (!status.installed || !status.daemonRunning) {
			return { docker: status, containers: [], sampledAt: now().toISOString() };
		}
		const listed = await runner.run(DOCKER, ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], {
			timeoutMs: 15_000
		});
		if (listed.code !== 0) throw refuse('operation_failed', firstLine(listed.stderr, 'docker ps failed'));
		const rows = parseContainers(listed.stdout);
		if (rows.some((row) => row.state === 'running')) {
			const stats = await runner.run(DOCKER, ['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'], {
				timeoutMs: 15_000
			});
			if (stats.code === 0) {
				const byId = parseStats(stats.stdout);
				for (const row of rows) {
					const found = byId.get(row.id);
					if (found && row.state === 'running') {
						row.cpuPercent = found.cpuPercent;
						row.memBytes = found.memBytes;
					}
				}
			}
		}
		context.logger?.info(`docker: listed ${rows.length} containers`);
		return { docker: status, containers: rows, sampledAt: now().toISOString() };
	};

	const images = async (): Promise<FleetImagesListResult> => {
		const status = await dockerStatus(runner);
		if (!status.installed || !status.daemonRunning) {
			return { docker: status, images: [], unusedCount: 0, unusedBytes: 0, sampledAt: now().toISOString() };
		}
		const [listed, used] = await Promise.all([
			runner.run(DOCKER, ['images', '--no-trunc', '--format', '{{json .}}'], { timeoutMs: 15_000 }),
			runner.run(DOCKER, ['ps', '-a', '--no-trunc', '--format', '{{.Image}}'], { timeoutMs: 15_000 })
		]);
		if (listed.code !== 0) throw refuse('operation_failed', firstLine(listed.stderr, 'docker images failed'));
		const refs =
			used.code === 0
				? used.stdout
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean)
				: [];
		const rows = countImageUse(parseImages(listed.stdout), refs);
		const unused = rows.filter((row) => row.inUseBy === 0);
		return {
			docker: status,
			images: rows,
			unusedCount: unused.length,
			unusedBytes: unused.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0),
			sampledAt: now().toISOString()
		};
	};

	const containerAction = async (context: MachineVerbContext) => {
		const id = context.params.id;
		const action = context.params.action;
		if (!isFleetContainerRef(id)) throw refuse('invalid', 'that is not a container id or name', { field: 'id' });
		if (!isFleetContainerAction(action)) {
			throw refuse('invalid', 'action must be start, stop, restart or remove', { field: 'action' });
		}
		await requireDaemon(context.nodeName);
		const verb: Record<FleetContainerAction, string[]> = {
			start: ['start', id],
			stop: ['stop', id],
			restart: ['restart', id],
			// No -v: anonymous volumes are kept; no -f: a running container is never removed (U12).
			remove: ['rm', id]
		};
		const result = await runner.run(DOCKER, verb[action], { timeoutMs: ACTION_TIMEOUT_MS });
		if (result.code !== 0) {
			const message = firstLine(result.stderr || result.stdout, `docker ${verb[action][0]} failed`);
			if (/no such container/i.test(message))
				throw refuse('not_found', `${id} is not a container on ${context.nodeName}`);
			if (/running container|stop the container/i.test(message)) {
				throw refuse('busy', `${id} is running; stop it first`);
			}
			throw refuse('operation_failed', message);
		}
		context.logger?.info(`docker: ${action} ${id}`);
		if (action === 'remove') return { id, action, state: 'removed' };
		const inspected = await runner.run(DOCKER, ['inspect', '--format', '{{.State.Status}}', id], {
			timeoutMs: 10_000
		});
		return { id, action, state: inspected.code === 0 ? inspected.stdout.trim() || 'unknown' : 'unknown' };
	};

	const run = async (context: MachineVerbContext) => {
		const validated = validateFleetRunRequest(context.params.request);
		if (!validated.ok) throw refuse('invalid', validated.hint, { field: validated.field });
		const request = validated.request;
		const roots = deps.allowedRoots ? await deps.allowedRoots().catch(() => [] as string[]) : [];
		for (const volume of request.volumes) {
			if (!isFleetHostPath(volume.source)) continue;
			if (!(await bindSourceAllowed(volume.source, roots, platform))) {
				throw refuse('invalid', FLEET_RUN_DANGEROUS_HINT, { field: 'volumes', source: volume.source });
			}
		}
		await requireDaemon(context.nodeName);
		const masked = request.env.map((variable) => variable.value);
		const { args, env } = dockerRunArgv(request);
		const progress = createPullProgress();
		return asOperation(context.nodeName, async () => {
			const result = await stream(DOCKER, args, {
				extraEnv: env,
				signal: context.signal,
				onLine: (line) => {
					const update = progress(line);
					context.progress(
						update
							? {
									...update,
									...(update.message ? { message: safeOutputLine(update.message, masked) } : {})
								}
							: { message: safeOutputLine(line, masked) }
					);
				}
			});
			if (result.aborted) throw refuse('operation_failed', 'cancelled');
			if (result.timedOut) throw refuse('operation_failed', 'timed out after 60 min');
			if (result.code !== 0) {
				throw refuse(
					'operation_failed',
					safeOutputLine(result.stderrTail[result.stderrTail.length - 1] ?? 'docker run failed', masked)
				);
			}
			const containerId =
				[...result.stdoutTail]
					.reverse()
					.find((line) => /^[a-f0-9]{64}$/.test(line.trim()))
					?.trim() ?? null;
			context.logger?.info(`docker: ran ${request.image}${request.name ? ` as ${request.name}` : ''}`);
			return {
				containerId: containerId ? containerId.slice(0, 12) : null,
				name: request.name ?? null,
				image: request.image
			};
		});
	};

	const pull = async (context: MachineVerbContext): Promise<FleetImagePullResult> => {
		const ref = context.params.ref;
		if (!isFleetImageRef(ref)) throw refuse('invalid', 'that is not an image reference', { field: 'ref' });
		await requireDaemon(context.nodeName);
		const progress = createPullProgress();
		return asOperation(context.nodeName, async () => {
			const result = await stream(DOCKER, ['pull', ref], {
				signal: context.signal,
				onLine: (line) => {
					const update = progress(line);
					if (update)
						context.progress({
							...update,
							...(update.message ? { message: safeOutputLine(update.message) } : {})
						});
				}
			});
			if (result.aborted) throw refuse('operation_failed', 'cancelled');
			if (result.timedOut) throw refuse('operation_failed', 'timed out after 60 min');
			if (result.code !== 0) {
				throw refuse(
					'operation_failed',
					safeOutputLine(result.stderrTail[result.stderrTail.length - 1] ?? 'docker pull failed')
				);
			}
			const digest = [...result.stdoutTail].reverse().find((line) => line.startsWith('Digest:'));
			context.logger?.info(`docker: pulled ${ref}`);
			return { ref, imageId: digest ? digest.replace(/^Digest:\s*/, '').slice(0, 80) : null };
		});
	};

	const removeImage = async (context: MachineVerbContext): Promise<FleetImageRemoveResult> => {
		const id = context.params.id;
		if (!isFleetDockerId(id)) throw refuse('invalid', 'that is not an image id', { field: 'id' });
		await requireDaemon(context.nodeName);
		const result = await runner.run(DOCKER, ['rmi', id], { timeoutMs: ACTION_TIMEOUT_MS });
		if (result.code !== 0) {
			const message = firstLine(result.stderr || result.stdout, 'docker rmi failed');
			if (/no such image/i.test(message))
				throw refuse('not_found', `${id} is not an image on ${context.nodeName}`);
			const user = /(?:running|stopped) container ([a-f0-9]{12})/i.exec(message);
			if (/being used|must be forced|conflict/i.test(message)) {
				throw refuse('busy', user ? `container ${user[1]} uses this image` : 'a container uses this image', {
					...(user ? { container: user[1] } : {})
				});
			}
			throw refuse('operation_failed', message);
		}
		const removed = result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => /^(Untagged|Deleted):/.test(line))
			.map((line) => line.replace(/^(Untagged|Deleted):\s*/, '').slice(0, 120));
		return { removed };
	};

	const prune = async (context: MachineVerbContext): Promise<FleetImagePruneResult> => {
		const listed = await images();
		if (!listed.docker.installed)
			throw refuse('unsupported_on_node', `Docker is not installed on ${context.nodeName}`);
		if (!listed.docker.daemonRunning) {
			throw refuse('operation_failed', `Docker is installed but not running on ${context.nodeName}`);
		}
		if (listed.unusedCount === 0) return { reclaimedBytes: 0, removedCount: 0, nothingToDo: true };
		return asOperation(context.nodeName, async () => {
			const result = await stream(DOCKER, ['image', 'prune', '-a', '-f'], {
				signal: context.signal,
				onLine: (line) => context.progress({ message: safeOutputLine(line) })
			});
			if (result.aborted) throw refuse('operation_failed', 'cancelled');
			if (result.code !== 0)
				throw refuse(
					'operation_failed',
					safeOutputLine(result.stderrTail[result.stderrTail.length - 1] ?? 'docker image prune failed')
				);
			return parsePruneSummary(result.stdoutTail);
		});
	};

	// ─── Compose (P3) ─────────────────────────────────────────────────────

	const composeProjects = async () => {
		const result = await runner.run(DOCKER, ['compose', 'ls', '--all', '--format', 'json'], { timeoutMs: 15_000 });
		if (result.code !== 0) throw refuse('operation_failed', firstLine(result.stderr, 'docker compose ls failed'));
		return parseComposeLs(result.stdout).map((row) => projectView(row, fileExists));
	};

	const composeList = async (): Promise<FleetComposeListResult> => {
		const status = await dockerStatus(runner);
		if (!status.installed || !status.daemonRunning) {
			return { docker: status, projects: [], sampledAt: now().toISOString() };
		}
		return { docker: status, projects: await composeProjects(), sampledAt: now().toISOString() };
	};

	/** The project as Compose lists it — a request names a project, never a path. */
	const findProject = async (raw: unknown, machine: string) => {
		if (!isFleetComposeProject(raw))
			throw refuse('invalid', 'that is not a Compose project name', { field: 'project' });
		await requireDaemon(machine);
		const project = (await composeProjects()).find((row) => row.name === raw);
		if (!project) throw refuse('not_found', `${raw} is not a Compose project on ${machine}`);
		return project;
	};

	const composeDescribe = async (context: MachineVerbContext): Promise<FleetComposeDescription> => {
		const project = await findProject(context.params.project, context.nodeName);
		const [config, ps] = await Promise.all([
			project.filesMissing
				? Promise.resolve(null)
				: runner.run(
						DOCKER,
						[
							'compose',
							'-p',
							project.name,
							...composeFileArgs(project.configFiles),
							'config',
							'--format',
							'json'
						],
						{ timeoutMs: 20_000 }
					),
			runner.run(DOCKER, ['compose', '-p', project.name, 'ps', '-a', '--format', 'json'], { timeoutMs: 15_000 })
		]);
		if (config && config.code !== 0) {
			// The files are there but Compose cannot read them: say so with its first line (U14).
			throw refuse('operation_failed', firstLine(config.stderr, 'docker compose config failed'));
		}
		const parsedConfig = config ? parseComposeConfig(config.stdout) : { services: [], networks: [], volumes: [] };
		const rows = ps.code === 0 ? parseComposePs(ps.stdout) : [];
		const runningIds = rows.filter((row) => row.state === 'running' && row.id).map((row) => row.id);
		let stats = new Map<string, { cpuPercent: number | null; memBytes: number | null }>();
		if (runningIds.length > 0) {
			const read = await runner.run(
				DOCKER,
				['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', ...runningIds],
				{
					timeoutMs: 15_000
				}
			);
			if (read.code === 0) stats = parseStats(read.stdout);
		}
		return {
			project,
			services: mergeComposeServices(parsedConfig, rows, stats),
			networks: parsedConfig.networks,
			volumes: parsedConfig.volumes
		};
	};

	const composeAction = async (context: MachineVerbContext) => {
		const action = context.params.action;
		if (!isFleetComposeAction(action))
			throw refuse('invalid', 'action must be up, down, restart or pull', { field: 'action' });
		const service = context.params.service;
		if (service !== undefined && service !== null && !isFleetComposeService(service)) {
			throw refuse('invalid', 'that is not a Compose service name', { field: 'service' });
		}
		const project = await findProject(context.params.project, context.nodeName);
		if (!project.actions.includes(action)) {
			throw refuse(
				'unsupported_on_node',
				`${project.name}'s Compose files are missing on ${context.nodeName}; only Down is possible`
			);
		}
		const args = composeActionArgs(
			project.name,
			project.filesMissing ? [] : project.configFiles,
			action,
			typeof service === 'string' ? service : undefined
		);
		const progress = createPullProgress();
		return asOperation(context.nodeName, async () => {
			const result = await stream(DOCKER, args, {
				signal: context.signal,
				onLine: (line) => {
					const update = action === 'pull' ? progress(line) : null;
					context.progress(
						update
							? { ...update, ...(update.message ? { message: safeOutputLine(update.message) } : {}) }
							: { message: safeOutputLine(line) }
					);
				}
			});
			if (result.aborted) throw refuse('operation_failed', 'cancelled');
			if (result.timedOut) throw refuse('operation_failed', 'timed out after 60 min');
			if (result.code !== 0) {
				throw refuse(
					'operation_failed',
					safeOutputLine(result.stderrTail[result.stderrTail.length - 1] ?? `docker compose ${action} failed`)
				);
			}
			context.logger?.info(
				`docker: compose ${action} ${project.name}${typeof service === 'string' ? ` ${service}` : ''}`
			);
			return { project: project.name, action, ...(typeof service === 'string' ? { service } : {}) };
		});
	};

	/** Which shells a running container has (FR-35): `bash`, `sh`. */
	const containerShells = async (context: MachineVerbContext): Promise<FleetContainerShellsResult> => {
		const id = context.params.id;
		if (!isFleetContainerRef(id)) throw refuse('invalid', 'that is not a container id or name', { field: 'id' });
		await requireDaemon(context.nodeName);
		const found: FleetContainerShellsResult['shells'] = [];
		for (const shell of ['bash', 'sh'] as const) {
			const probe = await runner.run(DOCKER, ['exec', id, shell, '-c', 'exit 0'], { timeoutMs: 10_000 });
			if (probe.code === 0 && isFleetContainerShell(shell)) found.push(shell);
		}
		return { shells: found };
	};

	return {
		id: 'docker',
		machineVerbs: {
			'compose.list': { stateChanging: false, run: () => composeList() },
			'compose.describe': { stateChanging: false, run: composeDescribe },
			'compose.action': { stateChanging: true, run: composeAction },
			'docker.container.shells': { stateChanging: false, run: containerShells },
			'docker.containers': { stateChanging: false, run: containers },
			'docker.images': { stateChanging: false, run: () => images() },
			'docker.container.action': { stateChanging: true, run: containerAction },
			'docker.run': { stateChanging: true, run },
			'docker.image.pull': { stateChanging: true, run: pull },
			'docker.image.remove': { stateChanging: true, run: removeImage },
			'docker.image.prune': { stateChanging: true, run: prune }
		}
	};
}
