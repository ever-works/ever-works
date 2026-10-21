export { LocalWorkspacePlugin } from './local-workspace.plugin.js';
export { LocalWorkspacePlugin as default } from './local-workspace.plugin.js';
export {
	execFileWithVerifiedCancellation,
	terminateVerifiedProcessTree,
	ProcessTreeTerminationError
} from './verified-exec.js';
export {
	checkoutHardeningEntries,
	checkoutHardeningEnv,
	emptyHooksDir,
	FILTER_DRIVER_PROBE_ARGS,
	finalizeHardeningEntries,
	gitConfigEnvOverlay,
	parseFilterDriverConfig,
	type FilterDriverConfigEntry
} from './git-hardening.js';
