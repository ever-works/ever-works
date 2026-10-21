import type { ComputerLegBroker } from '../computer-leg';
import { controlModule } from './control';
import { createDesktopModule } from './desktop';
import { createDockerModule, type DockerModuleDeps } from './docker';
import { createMachineModule, type MachineModuleOptions } from './machine';
import { createProcessesModule, type ProcessesModuleDeps } from './processes';
import { composeNodeModules, type ComposedNodeModules, type NodeModule } from './registry';
import { createServicesModule, type ServicesModuleDeps } from './services';

/**
 * Fleet node link — the compile-time module list (README D8).
 *
 * To add a machine fact, a channel family or a `machine` verb: write one
 * module file beside this one and append it to {@link NODE_LINK_MODULES}.
 * Nothing else in the link changes. The `control` and `machine` modules are
 * the link's own and are always first.
 */
export const NODE_LINK_MODULES: readonly NodeModule[] = [];

/**
 * Services, Docker, Compose and processes (FL-09) — the machine-facts modules
 * the runtime composes (`machineFacts`): `services` (systemd / launchd +
 * Homebrew / Windows services), `processes` and `docker` (the Docker CLI). A factory rather than an
 * entry in {@link NODE_LINK_MODULES}, so the runtime decides when a process
 * carries them and tests composing the link stay free of real machine verbs.
 */
export function createMachineFactModules(
	deps: { services?: ServicesModuleDeps; processes?: ProcessesModuleDeps; docker?: DockerModuleDeps } = {}
): NodeModule[] {
	return [createServicesModule(deps.services), createProcessesModule(deps.processes), createDockerModule(deps.docker)];
}

export interface ComposeNodeLinkModulesOptions extends Omit<MachineModuleOptions, 'verb'> {
	/** Extra modules after the list above (tests and embedders). */
	extra?: readonly NodeModule[];
	/**
	 * Sessions on computers (FL-04) — the `session` family, built by the
	 * runtime around its session daemon supervisor (`createSessionModule`).
	 * Absent on a process with neither `--manage` nor `--work`, which then
	 * refuses every session channel `unsupported_on_node`.
	 */
	session?: NodeModule;
	/**
	 * Fleet node link (FL-02 T-22) — the runtime's live-view leg broker. With
	 * it, the `desktop` family module (`./desktop`) is composed, carrying a
	 * view's leg over the link; without it the family stays unclaimed.
	 */
	computerLegs?: ComputerLegBroker;
	/**
	 * Checkouts on computers (FL-14) — the `checkouts.*` machine verbs, built
	 * by the runtime around this machine's code folders and Task pool
	 * (`createCheckoutsModule`). Absent on a process with neither `--manage`
	 * nor `--work`, which then answers those verbs `unsupported_on_node`.
	 */
	checkouts?: NodeModule;
	/**
	 * Services, Docker, Compose and processes (FL-09) — the machine-facts
	 * modules ({@link createMachineFactModules}). Their verbs need `--manage`
	 * on this machine (the machine family refuses them `consent_missing`
	 * otherwise); absent, they answer `unsupported_on_node`.
	 */
	machineFacts?: readonly NodeModule[];
}

/** Compose the link's own modules, every registered module, and any extras. */
export function composeNodeLinkModules(options: ComposeNodeLinkModulesOptions = {}): ComposedNodeModules {
	const { extra = [], session, computerLegs, checkouts, machineFacts = [], ...machineOptions } = options;
	let composed: ComposedNodeModules | null = null;
	const machine = createMachineModule({
		...machineOptions,
		verb: (name) => composed?.machineVerb(name)
	});
	composed = composeNodeModules([
		controlModule,
		machine,
		...NODE_LINK_MODULES,
		...(session ? [session] : []),
		...(computerLegs ? [createDesktopModule(computerLegs)] : []),
		...(checkouts ? [checkouts] : []),
		...machineFacts,
		...extra
	]);
	return composed;
}

export { controlModule, createLinkControlState, FLEET_MANAGED_CAPABILITY } from './control';
export type { LinkControlStateHolder } from './control';
export { createMachineModule, MACHINE_CHANNEL_MAX_IN_FLIGHT } from './machine';
export { createDockerModule, type DockerModuleDeps } from './docker';
export { createProcessesModule, type ProcessesModuleDeps } from './processes';
export { createServicesModule, type ServicesModuleDeps } from './services';
export { createHealthLinkModule, type HealthLinkModuleOptions, type WakeSender } from './health';
export { createSessionModule, type SessionModule, type SessionModuleLink, type SessionModuleOptions } from './session';
export { createCheckoutsModule, type CheckoutsModule, type CheckoutsModuleOptions } from './checkouts';
export {
	composeNodeModules,
	MachineVerbError,
	type ComposedNodeModules,
	type MachineVerb,
	type MachineVerbContext,
	type NodeChannelContext,
	type NodeChannelFamilyProvider,
	type NodeChannelHandler,
	type NodeChannelOpenResult,
	type NodeControlHandler,
	type NodeLinkControlState,
	type NodeModule,
	type NodeModuleEnvironment,
	type NodeOperationReporter
} from './registry';
