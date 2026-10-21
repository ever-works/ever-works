import { controlModule } from './control';
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
	 * Servers and ports (FL-10) — the `ports` module (`ports.list`,
	 * `ports.open`), built by the runtime around the machine's runner and its
	 * preview browser (`createPortsModule`). Absent without `--manage`.
	 */
	ports?: NodeModule;
	/**
	 * The `desktop` family (`createDesktopFamilyModule`): its `preview` source
	 * is FL-10's; FL-07 adds the Agent-browser and desktop sources to the same
	 * module. Absent, every `desktop` channel is refused as an unknown family.
	 */
	desktop?: NodeModule;
}

/** Compose the link's own modules, every registered module, and any extras. */
export function composeNodeLinkModules(options: ComposeNodeLinkModulesOptions = {}): ComposedNodeModules {
	const { extra = [], session, ports, desktop, ...machineOptions } = options;
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
		...(ports ? [ports] : []),
		...(desktop ? [desktop] : []),
		...extra
	]);
	return composed;
}

export { controlModule, createLinkControlState, FLEET_MANAGED_CAPABILITY } from './control';
export type { LinkControlStateHolder } from './control';
export { createMachineModule, MACHINE_CHANNEL_MAX_IN_FLIGHT } from './machine';
export { createSessionModule, type SessionModule, type SessionModuleLink, type SessionModuleOptions } from './session';
export { createDesktopFamilyModule, type DesktopFamilySources, type DesktopSourceOpener } from './desktop';
export { createPortsModule, type PortsModule, type PortsModuleOptions } from './ports';
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
