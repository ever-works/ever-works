import type { ManagementLaneExecutor } from '../management-lane';
import type { RunnerHostDeps } from '../link/modules/runners/host';
import { createRunnerControlExecutor } from './runner-control';
import { createRunnerInstallExecutor } from './runner-install';

/**
 * Actions runners on computers (FL-18, CONTRACTS R-34, T-14) — the two
 * management-lane executors a node started with `--work` registers:
 * `runner-install` and `runner-control`. The runtime builds them only when this
 * machine has a service manager runners can be installed through (the
 * `actions-runner` tag); the lane leases them only while `--work` is on, and the
 * work lane never does.
 */
export function createRunnerExecutors(deps: RunnerHostDeps): ManagementLaneExecutor[] {
	return [
		{ kind: 'runner-install', run: createRunnerInstallExecutor(deps) },
		{ kind: 'runner-control', run: createRunnerControlExecutor(deps) }
	];
}
