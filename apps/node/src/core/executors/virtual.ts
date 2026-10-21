import type { ManagementLaneExecutor } from '../management-lane';
import type { VirtualHostDeps } from '../link/modules/virtual/host';
import { createVmControlExecutor } from './vm-control';
import { createVmCreateExecutor } from './vm-create';

/**
 * Virtual computers (FL-16, CONTRACTS R-34, T-18) — the two management-lane
 * executors a host started with `--manage` registers: `vm-create` and
 * `vm-control`. The runtime builds them only on a Linux or macOS host with a
 * virtual data folder; the jobs themselves require `managed`, `docker` and
 * `virtual-host`, so a host without Docker is never handed one.
 */
export function createVirtualExecutors(deps: VirtualHostDeps): ManagementLaneExecutor[] {
	return [
		{ kind: 'vm-create', run: createVmCreateExecutor(deps) },
		{ kind: 'vm-control', run: createVmControlExecutor(deps) }
	];
}

/** Sleep `ms`, ending early (resolved) when `signal` aborts — the caller re-checks it. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
