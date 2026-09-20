/**
 * Barrel for the specs and for the kind-integration lane (T11), which drives the bootstrap against
 * a real API server. The running process starts at `main.ts`, not here.
 */
export { bootstrap, EXIT_CONFIGURATION_REFUSED } from './bootstrap.js';
export type { BootstrapOptions, BootstrapResult } from './bootstrap.js';
export {
	CONTROL_NAMESPACE_ENV_VAR,
	CONTROLLER_VERSION,
	loadControllerConfig,
	satisfiesMinimumVersion,
	ZONE_ID_ENV_VAR
} from './config.js';
export type { ClusterCredentialSource, ControllerConfig, ControllerConfigResult, ControllerRefusal } from './config.js';
export { RECONCILERS } from './reconcile/index.js';
export { validateRegistry, WATCHABLE_KINDS } from './reconciler.port.js';
export type { Reconciler, ReconcilerContext, ReconcilerLogger, RegistryRefusal } from './reconciler.port.js';
