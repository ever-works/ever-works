import {
	FLEET_ACTIONS_RUNNER_CAPABILITY,
	FLEET_ACTIONS_RUNNER_LIST_VERB,
	FLEET_ACTIONS_RUNNER_STATUS_VERB,
	makeFleetLinkError,
	type FleetActionsRunnerListResult,
	type FleetActionsRunnerNodeFact
} from '@ever-works/contracts';
import type { RunnerHostDeps } from './runners/host';
import { runnerServiceManagerFor, runnerServiceState, serviceNameOf } from './runners/service';
import { MachineVerbError, type NodeModule } from './registry';

/**
 * Actions runners on computers (FL-18, plan §6.1, §6.4, CONTRACTS §3.3
 * `runner.*`, R-40) — the `runners` node module:
 *
 *  - tag `actions-runner` while `--work` is on and this machine has a service
 *    manager runners can be installed through (systemd, launchd, Windows
 *    services — spec U3): the platform pins `runner-install` / `runner-control`
 *    only to a node advertising it, and the management lane leases them only
 *    under `--work` (R-34);
 *  - `runner.list` — every runner this machine holds (its folder's
 *    `ever-works.json`), with what its service manager says about it, its
 *    version and its GitHub id (the refresh merges this with GitHub's view,
 *    FR-13);
 *  - `runner.status { runnerId }` — one runner.
 *
 * Reads only: installing, starting, stopping, restarting and removing a runner
 * are durable jobs (CONTRACTS §12). Never a token, never a path in a reply.
 */

export type RunnersModuleDeps = Pick<
	RunnerHostDeps,
	'state' | 'exec' | 'platform' | 'hasSystemd' | 'isElevated' | 'isRoot' | 'user' | 'nodeName' | 'client' | 'arch'
> &
	Partial<RunnerHostDeps>;

/** True when runners can be installed as services on this machine (the `actions-runner` tag's second half). */
export function canHostActionsRunners(platform: string, hasSystemd: boolean): boolean {
	return runnerServiceManagerFor(platform, hasSystemd) !== null;
}

/** Every runner this machine holds, with its service state (`runner.list`). */
export async function listActionsRunners(deps: RunnersModuleDeps): Promise<FleetActionsRunnerListResult> {
	const manager = runnerServiceManagerFor(deps.platform, deps.hasSystemd());
	const full = deps as RunnerHostDeps;
	const runners: FleetActionsRunnerNodeFact[] = [];
	for (const meta of await deps.state.list()) {
		const serviceState = await runnerServiceState(full, meta).catch(() => 'unknown' as const);
		runners.push({
			runnerId: meta.runnerId,
			name: meta.name,
			scope: meta.scope,
			target: meta.target,
			mode: meta.mode,
			serviceState,
			serviceUnit: (await serviceNameOf(full, meta).catch(() => null)) ?? meta.serviceUnit,
			runnerVersion: meta.runnerVersion,
			githubRunnerId: await deps.state.githubRunnerId(meta.name).catch(() => null),
			configured: meta.configured
		});
	}
	return { serviceManager: manager, runners };
}

const RUNNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRunnersModule(deps: RunnersModuleDeps): NodeModule {
	return {
		id: 'runners',
		tags: (environment) =>
			environment.consents.work && canHostActionsRunners(environment.platform, deps.hasSystemd())
				? [FLEET_ACTIONS_RUNNER_CAPABILITY]
				: [],
		machineVerbs: {
			[FLEET_ACTIONS_RUNNER_LIST_VERB]: {
				stateChanging: false,
				run: () => listActionsRunners(deps)
			},
			[FLEET_ACTIONS_RUNNER_STATUS_VERB]: {
				stateChanging: false,
				run: async (context) => {
					const runnerId = context.params.runnerId;
					if (typeof runnerId !== 'string' || !RUNNER_ID.test(runnerId)) {
						throw new MachineVerbError(makeFleetLinkError('invalid', 'runnerId must be an Actions runner id'));
					}
					const listed = await listActionsRunners(deps);
					const fact = listed.runners.find((runner) => runner.runnerId === runnerId.toLowerCase());
					if (!fact) throw new MachineVerbError(makeFleetLinkError('not_found', 'no such Actions runner here'));
					return fact;
				}
			}
		}
	};
}
