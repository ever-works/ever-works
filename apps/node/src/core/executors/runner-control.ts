import { rm } from 'node:fs/promises';
import {
	fleetActionsRunnerVersionOf,
	isFleetActionsRunnerControlAction,
	isFleetActionsRunnerLabel,
	isFleetActionsRunnerName,
	type FleetActionsRunnerControlAction,
	type FleetJobView
} from '@ever-works/contracts';
import { deregisterRunner } from '../link/modules/runners/config';
import { controlDockerRunner, deregisterDockerRunner } from '../link/modules/runners/docker';
import { assertRunnerDownloadFor, downloadRunnerArchive } from '../link/modules/runners/download';
import { fetchRunnerToken, reportRunner, RunnerHostError, type RunnerHostDeps } from '../link/modules/runners/host';
import { controlRunnerService, uninstallRunnerService } from '../link/modules/runners/service';
import type { RunnerMeta } from '../link/modules/runners/state';
import { installOneRunner } from './runner-install';

/**
 * Actions runners on computers (FL-18, plan §6.1, spec FR-15, FR-16, FR-28,
 * T-14, T-28) — the node's `runner-control` executor: one act on one runner,
 * run by the management lane under `--work` (CONTRACTS R-34).
 *
 *  - `start` / `stop` / `restart` — the runner's service through this machine's
 *    service manager (systemd under passwordless sudo, launchd, Windows
 *    services elevated), or its container (Docker mode, P3); the new state is
 *    reported at once (FR-15).
 *  - `remove` — the service (or container) is stopped and taken down, the
 *    runner deregistered at GitHub with a one-time remove token handed over now
 *    (environment input only, like the registration token), and EXACTLY its
 *    folder deleted; when the runner cannot deregister itself (its folder is
 *    gone, `config remove` failed) the platform deletes it at GitHub by its id.
 *    Reported `removed` either way (FR-16).
 *  - `reinstall` (P3, FR-28) — the owner's update: taken down and deregistered
 *    like a remove, then installed again from GitHub's current build (verified
 *    the same way) with the same name, labels and mode; reported `idle` again.
 *
 * Only a runner whose folder carries THIS runner id is ever touched: the name
 * in the payload is validated, and a folder of the same name that belongs to
 * another runner row is refused.
 */

const RUNNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunnerControlRequest {
	runnerId: string;
	name: string;
	action: FleetActionsRunnerControlAction;
}

/** The `runner-control` payload off the job, validated on the machine. */
export function parseRunnerControlPayload(job: FleetJobView): RunnerControlRequest {
	const raw = (job.payload ?? {}) as Record<string, unknown>;
	if (typeof raw.runnerId !== 'string' || !RUNNER_ID.test(raw.runnerId))
		throw new RunnerHostError('the job names no runner');
	if (!isFleetActionsRunnerName(raw.name)) throw new RunnerHostError('the job names a runner that is not valid');
	if (!isFleetActionsRunnerControlAction(raw.action)) throw new RunnerHostError('the job names no known act');
	return { runnerId: raw.runnerId.toLowerCase(), name: raw.name, action: raw.action };
}

/** The node user's `uid:gid`, for a Docker-mode runner's throw-away remove container. */
function containerUser(deps: RunnerHostDeps): string | null {
	return deps.uidGid?.() ?? null;
}

/**
 * Take a runner down and deregister it at GitHub (remove, and the first half of
 * reinstall). Answers whether the runner deregistered itself.
 */
async function takeDown(
	deps: RunnerHostDeps,
	job: FleetJobView,
	meta: RunnerMeta,
	dir: string,
	signal: AbortSignal
): Promise<boolean> {
	let deregistered = false;
	if (meta.mode === 'docker') {
		await controlDockerRunner(deps, meta, 'remove');
		const user = containerUser(deps);
		if (meta.configured && meta.image && user) {
			const minted = await fetchRunnerToken(deps, job, meta.runnerId, 'remove', signal).catch(() => null);
			if (minted) {
				deregistered = await deregisterDockerRunner(
					deps,
					{ runnerId: meta.runnerId, dir, image: meta.image, user },
					minted.token
				);
			}
		}
		return deregistered;
	}
	const windows = deps.platform === 'win32';
	// Linux / macOS: the runner refuses to deregister while its service is installed.
	if (!windows) await uninstallRunnerService(deps, dir, meta);
	if (meta.configured) {
		const minted = await fetchRunnerToken(deps, job, meta.runnerId, 'remove', signal).catch(() => null);
		if (minted) deregistered = await deregisterRunner(deps.exec, deps.platform, dir, minted.token);
	}
	// Windows: `config remove` took the service with it; take back one it left.
	if (windows) await uninstallRunnerService(deps, dir, meta);
	return deregistered;
}

export function createRunnerControlExecutor(deps: RunnerHostDeps) {
	return async (job: FleetJobView, signal: AbortSignal): Promise<Record<string, unknown>> => {
		const { runnerId, name, action } = parseRunnerControlPayload(job);
		const meta = await deps.state.readMeta(name);
		if (meta && meta.runnerId.toLowerCase() !== runnerId) {
			throw new RunnerHostError(`the folder of ${name} on ${deps.nodeName} belongs to another runner`, 'invalid');
		}
		const dir = deps.state.dir(name);
		try {
			switch (action) {
				case 'start':
				case 'stop':
				case 'restart': {
					if (!meta) {
						await reportRunner(deps, job, runnerId, {
							state: 'offline',
							error: `${name} is not on ${deps.nodeName}`
						});
						throw new RunnerHostError(`${name} is not on ${deps.nodeName}; remove it and install it again`);
					}
					if (meta.mode === 'docker') await controlDockerRunner(deps, meta, action);
					else await controlRunnerService(deps, dir, meta, action);
					const state = action === 'stop' ? 'stopped' : 'idle';
					await reportRunner(deps, job, runnerId, { state, error: null });
					return { runnerId, state };
				}
				case 'remove': {
					await reportRunner(deps, job, runnerId, { phase: 'removing' });
					const deregistered = meta ? await takeDown(deps, job, meta, dir, signal) : false;
					await deps.state.remove(name);
					await reportRunner(deps, job, runnerId, { state: 'removed', error: null, deregistered });
					return { runnerId, state: 'removed', deregistered };
				}
				case 'reinstall': {
					// P3 (FR-28): the payload carries GitHub's current build for this computer.
					const raw = (job.payload ?? {}) as Record<string, unknown>;
					const download = assertRunnerDownloadFor(
						raw.download as Parameters<typeof assertRunnerDownloadFor>[0],
						deps.platform,
						deps.arch
					);
					const url = typeof raw.url === 'string' ? raw.url : '';
					if (!meta) throw new RunnerHostError(`${name} is not on ${deps.nodeName}; install it again`);
					if (url !== `https://github.com/${meta.target}`) {
						throw new RunnerHostError('the job names an unexpected registration URL');
					}
					const labels = Array.isArray(raw.labels)
						? raw.labels.filter((label): label is string => isFleetActionsRunnerLabel(label))
						: meta.labels;
					await reportRunner(deps, job, runnerId, { phase: 'removing' });
					await takeDown(deps, job, meta, dir, signal);
					await deps.state.remove(name);
					const archive: { path: string | null } = { path: null };
					try {
						await installOneRunner(
							deps,
							job,
							{
								scope: meta.scope,
								target: meta.target,
								url,
								labels,
								mode: meta.mode,
								download,
								runnerVersion: fleetActionsRunnerVersionOf(download.filename),
								shareDockerDaemon: meta.shareDockerDaemon === true
							},
							{ runnerId, name },
							async () => {
								if (!archive.path) archive.path = await downloadRunnerArchive(deps, download, signal);
								return archive.path;
							},
							signal
						);
					} catch (error) {
						const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
						await reportRunner(deps, job, runnerId, { state: 'failed', error: message.slice(0, 300) });
						throw error;
					} finally {
						if (archive.path) await rm(archive.path, { force: true }).catch(() => undefined);
					}
					return { runnerId, state: 'idle', runnerVersion: fleetActionsRunnerVersionOf(download.filename) };
				}
			}
			throw new RunnerHostError('the job names no known act');
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 300);
			if (action !== 'remove') await reportRunner(deps, job, runnerId, { error: message });
			else await reportRunner(deps, job, runnerId, { error: message, phase: 'done' });
			throw error instanceof RunnerHostError ? error : new RunnerHostError(message);
		}
	};
}
