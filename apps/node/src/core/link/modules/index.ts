import type { ComputerLegBroker } from '../computer-leg';
import { controlModule } from './control';
import { createDesktopModule } from './desktop';
import { createMachineModule, type MachineModuleOptions } from './machine';
import { composeNodeModules, type ComposedNodeModules, type NodeModule } from './registry';

/**
 * Fleet node link — the compile-time module list (README D8).
 *
 * To add a machine fact, a channel family or a `machine` verb: write one
 * module file beside this one and append it to {@link NODE_LINK_MODULES}.
 * Nothing else in the link changes. The `control` and `machine` modules are
 * the link's own and are always first.
 */
export const NODE_LINK_MODULES: readonly NodeModule[] = [];

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
	 * Commands on computers (FL-12) — the `command` family, built by the
	 * runtime for a process started with `--manage` (`createCommandModule`).
	 * Absent, every command channel is refused `unsupported_on_node`.
	 */
	command?: NodeModule;
	/**
	 * Fleet node link (FL-02 T-22) — the runtime's live-view leg broker. With
	 * it, the `desktop` family module (`./desktop`) is composed, carrying a
	 * view's leg over the link; without it the family stays unclaimed.
	 */
	computerLegs?: ComputerLegBroker;
}

/** Compose the link's own modules, every registered module, and any extras. */
export function composeNodeLinkModules(options: ComposeNodeLinkModulesOptions = {}): ComposedNodeModules {
	const { extra = [], session, command, computerLegs, ...machineOptions } = options;
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
		...(command ? [command] : []),
		...(computerLegs ? [createDesktopModule(computerLegs)] : []),
		...extra
	]);
	return composed;
}

export { controlModule, createLinkControlState, FLEET_MANAGED_CAPABILITY } from './control';
export type { LinkControlStateHolder } from './control';
export { createMachineModule, MACHINE_CHANNEL_MAX_IN_FLIGHT } from './machine';
export { createSessionModule, type SessionModule, type SessionModuleLink, type SessionModuleOptions } from './session';
export { createCommandModule, type CommandModuleOptions } from './command';
export { CommandOutputStore } from './command/command-output-store';
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
