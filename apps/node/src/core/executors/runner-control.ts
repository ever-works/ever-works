import {
	isFleetActionsRunnerControlAction,
	isFleetActionsRunnerName,
	type FleetActionsRunnerControlAction,
	type FleetJobView
} from '@ever-works/contracts';
import { deregisterRunner } from '../link/modules/runners/config';
import { fetchRunnerToken, reportRunner, RunnerHostError, type RunnerHostDeps } from '../link/modules/runners/host';
import { controlRunnerService, uninstallRunnerService } from '../link/modules/runners/service';

/**
 * Actions runners on computers (FL-18, plan §6.1, spec FR-15, FR-16, T-14) —
 * the node's `runner-control` executor: one act on one runner, run by the
 * management lane under `--work` (CONTRACTS R-34).
 *
 *  - `start` / `stop` / `restart` — the runner's service through this machine's
 *    service manager (systemd under passwordless sudo, launchd, Windows
 *    services elevated); the new state is reported at once (FR-15).
 *  - `remove` — the service is stopped and uninstalled, the runner deregistered
 *    at GitHub with a one-time remove token handed over now (environment input
 *    only, like the registration token), and EXACTLY its folder deleted; when the
 *    runner cannot deregister itself (its folder is gone, `config remove` failed)
 *    the platform deletes it at GitHub by its id. Reported `removed` either way
 *    (FR-16).
 *  - `reinstall` — phase 3; refused here until it ships.
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
					await controlRunnerService(deps, dir, meta, action);
					const state = action === 'stop' ? 'stopped' : 'idle';
					await reportRunner(deps, job, runnerId, { state, error: null });
					return { runnerId, state };
				}
				case 'remove': {
					await reportRunner(deps, job, runnerId, { phase: 'removing' });
					let deregistered = false;
					if (meta) {
						const windows = deps.platform === 'win32';
						// Linux / macOS: the runner refuses to deregister while its service is installed.
						if (!windows) await uninstallRunnerService(deps, dir, meta);
						if (meta.configured) {
							const minted = await fetchRunnerToken(deps, job, runnerId, 'remove', signal).catch(
								() => null
							);
							if (minted)
								deregistered = await deregisterRunner(deps.exec, deps.platform, dir, minted.token);
						}
						// Windows: `config remove` took the service with it; take back one it left.
						if (windows) await uninstallRunnerService(deps, dir, meta);
					}
					await deps.state.remove(name);
					await reportRunner(deps, job, runnerId, { state: 'removed', error: null, deregistered });
					return { runnerId, state: 'removed', deregistered };
				}
				case 'reinstall':
					throw new RunnerHostError(
						'reinstalling a runner is not available on this computer yet',
						'unsupported_on_node'
					);
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
