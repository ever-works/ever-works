import type { ManagementLaneExecutor } from '../management-lane';
import { createUsageScanExecutor, type UsageScanDeps } from './usage-scan-executor';

/**
 * Usage & cost on the fleet (FL-20, CONTRACTS R-34) — the management lane's
 * `usage-scan` executor for a node started with `--usage-scan`. A job
 * executor, not a link module: it has no link vocabulary (R-40), so it lives
 * here and is appended to the lane's executors by the runtime.
 */
export function createUsageScanExecutors(deps: UsageScanDeps): ManagementLaneExecutor[] {
	return [{ kind: 'usage-scan', run: createUsageScanExecutor(deps) }];
}

export { anyUsageRootExists, resolveUsageRoots, type UsageRootsInput } from './usage-roots';
export { nodeUsageFs, type UsageFs } from './usage-fs';
export { runUsageScan, UsageScanRefusedError, type UsageScanDeps } from './usage-scan-executor';
