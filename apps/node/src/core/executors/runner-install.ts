import { rm } from 'node:fs/promises';
import {
	fleetActionsRunnerVersionOf,
	FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
	isFleetActionsRunnerLabel,
	isFleetActionsRunnerMode,
	isFleetActionsRunnerName,
	isFleetActionsRunnerScope,
	isFleetActionsRunnerTarget,
	type FleetActionsRunnerInstallItem,
	type FleetJobView,
	type FleetRunnerInstallPayload
} from '@ever-works/contracts';
import { configureRunner } from '../link/modules/runners/config';
import { configureDockerRunner, pinRunnerImage, startDockerRunner } from '../link/modules/runners/docker';
import { assertRunnerDownloadFor, downloadRunnerArchive, extractRunnerArchive } from '../link/modules/runners/download';
import { fetchRunnerToken, reportRunner, RunnerHostError, type RunnerHostDeps } from '../link/modules/runners/host';
import { assertCanInstallService, installRunnerService } from '../link/modules/runners/service';
import type { RunnerMeta } from '../link/modules/runners/state';

/**
 * Actions runners on computers (FL-18, plan §6.1, spec FR-6 – FR-11, T-14) —
 * the node's `runner-install` executor, run by the management lane under
 * `--work` (CONTRACTS R-34). One job installs every runner of one Install.
 *
 * Phases (FR-11), each reported to the platform as it starts, per runner:
 *
 *   downloading         GitHub's runner build for this OS and architecture — once per job
 *   verifying           GitHub's SHA-256, BEFORE anything is extracted (FR-6, U6)
 *   awaiting-token      the build is in place and the service can be installed:
 *                       the platform mints the registration token NOW (FR-7)
 *   registering         `config --unattended`, the token in the child's environment only
 *   installing-service  systemd (`svc.sh`, passwordless sudo), launchd, Windows service (FR-9)
 *   starting            the service starts; `done` + `idle` when it runs
 *
 * Refusals that would hold for every runner (no passwordless sudo, not
 * elevated, no service manager — U3 – U5) are checked BEFORE a token is asked
 * for, so nothing is registered at GitHub that could not be run; the first
 * such refusal fails every runner of the job with the same sentence (the exact
 * command included). A runner that failed on its own (GitHub refused its name,
 * U10) is reported `failed` and the others still install; the job fails at the
 * end if any did.
 *
 * Resumable (U11): a runner whose folder already says it is registered (a
 * lapsed claim re-run) is not downloaded or registered again — only its
 * service is (re)installed and started.
 *
 * Docker-isolated (P3, FR-27): the same verified build in the same folder, then
 * GitHub's runner image pinned to its digest (`../link/modules/runners/docker`):
 * registration in a throw-away container (the token in Docker's environment
 * only) and the runner in its own `--restart unless-stopped` container, with the
 * host's Docker daemon only under the labelled opt-in.
 */

/** The `runner-install` payload off the job, validated on the machine (never trusted from the platform). */
export function parseRunnerInstallPayload(job: FleetJobView): FleetRunnerInstallPayload {
	const raw = (job.payload ?? {}) as Partial<FleetRunnerInstallPayload>;
	if (typeof raw.nodeId !== 'string' || !raw.nodeId) throw new RunnerHostError('the job names no computer');
	if (!isFleetActionsRunnerScope(raw.scope) || !isFleetActionsRunnerTarget(raw.scope, raw.target)) {
		throw new RunnerHostError('the job names no repository or organisation');
	}
	if (typeof raw.url !== 'string' || raw.url !== `https://github.com/${raw.target}`) {
		throw new RunnerHostError('the job names an unexpected registration URL');
	}
	if (!isFleetActionsRunnerMode(raw.mode)) throw new RunnerHostError('the job names no run mode');
	if (
		!Array.isArray(raw.runners) ||
		raw.runners.length === 0 ||
		raw.runners.length > FLEET_ACTIONS_RUNNERS_MAX_PER_NODE
	) {
		throw new RunnerHostError('the job names no runners');
	}
	const runners: FleetActionsRunnerInstallItem[] = [];
	const seen = new Set<string>();
	for (const entry of raw.runners) {
		if (!entry || typeof entry.runnerId !== 'string' || !isFleetActionsRunnerName(entry.name)) {
			throw new RunnerHostError('the job names a runner that is not valid');
		}
		if (seen.has(entry.name.toLowerCase())) throw new RunnerHostError('the job names one runner twice');
		seen.add(entry.name.toLowerCase());
		runners.push({ runnerId: entry.runnerId, name: entry.name });
	}
	const labels = Array.isArray(raw.labels) ? raw.labels.filter((label) => isFleetActionsRunnerLabel(label)) : [];
	return {
		nodeId: raw.nodeId,
		runners,
		scope: raw.scope,
		target: raw.target as string,
		url: raw.url,
		labels,
		mode: raw.mode,
		download: raw.download as FleetRunnerInstallPayload['download'],
		...(raw.mode === 'docker' ? { shareDockerDaemon: raw.shareDockerDaemon === true } : {})
	};
}

/** What one runner's install needs besides its id and name (an Install's payload, or a reinstall's). */
export interface RunnerInstallContext {
	scope: FleetRunnerInstallPayload['scope'];
	target: string;
	url: string;
	labels: string[];
	mode: FleetRunnerInstallPayload['mode'];
	download: NonNullable<FleetRunnerInstallPayload['download']>;
	runnerVersion: string | null;
	shareDockerDaemon: boolean;
}

/** The node user's `uid:gid` a runner container runs as, or a refusal. */
function containerUser(deps: RunnerHostDeps): string {
	const user = deps.uidGid?.() ?? null;
	if (!user) {
		throw new RunnerHostError(
			'container-isolated runners need a Unix user id on this computer',
			'unsupported_on_node'
		);
	}
	return user;
}

/**
 * Install one runner (the verified archive is shared through `archive`):
 * extract, refuse before registering, register with the one-time token, run it
 * as a service or in its own container, report `idle`. Throws the first failure.
 */
export async function installOneRunner(
	deps: RunnerHostDeps,
	job: FleetJobView,
	ctx: RunnerInstallContext,
	runner: FleetActionsRunnerInstallItem,
	archive: () => Promise<string>,
	signal: AbortSignal
): Promise<void> {
	const docker = ctx.mode === 'docker';
	if (docker && (deps.platform !== 'linux' || deps.hasDocker?.() !== true)) {
		throw new RunnerHostError(`${deps.nodeName} cannot run container-isolated runners`, 'unsupported_on_node');
	}
	const existing = await deps.state.readMeta(runner.name);
	if (existing && existing.runnerId !== runner.runnerId) {
		throw new RunnerHostError(`a runner named ${runner.name} already exists on ${deps.nodeName}`, 'invalid');
	}
	let meta: RunnerMeta;
	const dir = deps.state.dir(runner.name);
	if (existing?.configured) {
		// A re-run after a lapsed claim: registered already — only the service / container is left.
		meta = existing;
	} else {
		await reportRunner(deps, job, runner.runnerId, { phase: 'downloading', runnerVersion: ctx.runnerVersion });
		const verified = await archive();
		await reportRunner(deps, job, runner.runnerId, { phase: 'verifying' });
		// The archive was verified against GitHub's SHA-256 while it was fetched.
		await deps.state.prepare(runner.name);
		await extractRunnerArchive(deps, verified, dir, { keepArchive: true });
		meta = {
			runnerId: runner.runnerId,
			name: runner.name,
			scope: ctx.scope,
			target: ctx.target,
			labels: ctx.labels,
			mode: ctx.mode,
			runnerVersion: ctx.runnerVersion,
			sha256: ctx.download.sha256.toLowerCase(),
			configured: false,
			serviceUnit: null,
			installedAt: null,
			...(docker ? { shareDockerDaemon: ctx.shareDockerDaemon } : {})
		};
		await deps.state.writeMeta(meta);
		// U3 – U5: refuse BEFORE anything is registered at GitHub.
		if (docker) {
			const image = await pinRunnerImage(deps, ctx.runnerVersion);
			meta = { ...meta, image };
			await deps.state.writeMeta(meta);
		} else {
			await assertCanInstallService(deps, dir);
		}
		await reportRunner(deps, job, runner.runnerId, { phase: 'awaiting-token' });
		const minted = await fetchRunnerToken(deps, job, runner.runnerId, 'register', signal);
		await reportRunner(deps, job, runner.runnerId, { phase: 'registering' });
		const config = {
			platform: deps.platform,
			url: ctx.url,
			name: runner.name,
			labels: ctx.labels,
			replace: minted.replace
		};
		if (docker) {
			await configureDockerRunner(
				deps,
				{ runnerId: runner.runnerId, dir, image: meta.image as string, user: containerUser(deps), config },
				minted.token
			);
		} else {
			await configureRunner(deps.exec, dir, config, minted.token);
		}
		meta = { ...meta, configured: true };
		await deps.state.writeMeta(meta);
	}
	await reportRunner(deps, job, runner.runnerId, { phase: 'installing-service' });
	const serviceUnit = docker
		? await startDockerRunner(deps, {
				runnerId: runner.runnerId,
				dir,
				image: meta.image as string,
				user: containerUser(deps),
				shareDockerDaemon: meta.shareDockerDaemon === true
			})
		: await installRunnerService(deps, dir, meta);
	await reportRunner(deps, job, runner.runnerId, { phase: 'starting', serviceUnit });
	const githubRunnerId = await deps.state.githubRunnerId(runner.name).catch(() => null);
	meta = { ...meta, serviceUnit, installedAt: meta.installedAt ?? new Date(deps.now()).toISOString() };
	await deps.state.writeMeta(meta);
	await reportRunner(deps, job, runner.runnerId, {
		phase: 'done',
		state: 'idle',
		error: null,
		serviceUnit,
		runnerVersion: meta.runnerVersion,
		githubRunnerId
	});
}

/** The first line of an error, bounded — what a person reads on the row. */
function firstLine(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split(/\r?\n/)[0].slice(0, 300);
}

/** A refusal that holds for every runner of the job (and so fails them all at once). */
function failsEveryRunner(error: unknown): boolean {
	return (
		error instanceof RunnerHostError &&
		(error.code === 'root_required' ||
			error.code === 'unsupported_on_node' ||
			/token could not be fetched|was cancelled/.test(error.message))
	);
}

export function createRunnerInstallExecutor(deps: RunnerHostDeps) {
	return async (job: FleetJobView, signal: AbortSignal): Promise<Record<string, unknown>> => {
		const payload = parseRunnerInstallPayload(job);
		const download = assertRunnerDownloadFor(payload.download, deps.platform, deps.arch);
		const ctx: RunnerInstallContext = {
			scope: payload.scope,
			target: payload.target,
			url: payload.url,
			labels: payload.labels,
			mode: payload.mode,
			download,
			runnerVersion: fleetActionsRunnerVersionOf(download.filename),
			shareDockerDaemon: payload.shareDockerDaemon === true
		};
		// One download per install, shared by every runner of it (decision 7).
		const archive: { path: string | null } = { path: null };
		const fetchArchive = async (): Promise<string> => {
			if (!archive.path) archive.path = await downloadRunnerArchive(deps, download, signal);
			return archive.path;
		};
		const installed: string[] = [];
		const failed: Array<{ name: string; error: string }> = [];

		const failRest = async (from: number, error: string) => {
			for (const rest of payload.runners.slice(from)) {
				if (installed.includes(rest.runnerId) || failed.some((entry) => entry.name === rest.name)) continue;
				failed.push({ name: rest.name, error });
				await reportRunner(deps, job, rest.runnerId, { state: 'failed', error });
			}
		};

		try {
			for (let index = 0; index < payload.runners.length; index += 1) {
				const runner = payload.runners[index];
				if (signal.aborted) throw new RunnerHostError('the install was cancelled');
				try {
					await installOneRunner(deps, job, ctx, runner, fetchArchive, signal);
					installed.push(runner.runnerId);
				} catch (error) {
					const message = firstLine(error);
					failed.push({ name: runner.name, error: message });
					await reportRunner(deps, job, runner.runnerId, { state: 'failed', error: message });
					// Nothing registered for this runner: take its folder back (a registered one stays for Remove).
					const meta = await deps.state.readMeta(runner.name).catch(() => null);
					if (!meta?.configured && (!meta || meta.runnerId === runner.runnerId)) {
						await deps.state.remove(runner.name).catch(() => undefined);
					}
					if (failsEveryRunner(error)) {
						await failRest(index + 1, message);
						throw error;
					}
				}
			}
		} finally {
			if (archive.path) await rm(archive.path, { force: true }).catch(() => undefined);
		}

		if (failed.length > 0) {
			const first = failed[0];
			throw new RunnerHostError(
				installed.length > 0
					? `${failed.length} of ${payload.runners.length} runners did not install (${first.name}: ${first.error})`
					: `${first.name}: ${first.error}`
			);
		}
		return { installed: installed.length, runnerIds: installed };
	};
}
