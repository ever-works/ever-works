import {
	FLEET_KVM_CAPABILITY,
	FLEET_VIRTUAL_HOST_CAPABILITY,
	FLEET_VIRTUAL_WINDOWS_CAPABILITY,
	makeFleetLinkError,
	type FleetVirtualListResult,
	type FleetVirtualMachineFact
} from '@ever-works/contracts';
import type { CommandRunner } from '../../capabilities';
import { DOCKER, parseDockerLabels, parseJsonLines } from './machine-facts/docker-cli';
import { createMachineCommandRunner } from './machine-facts/exec';
import { containerListArgs, isChildNodeId, VIRTUAL_CHILD_LABEL } from './virtual/docker-args';
import type { VirtualState } from './virtual/state';
import { resolveWindowsImage, type WindowsPasswordStore } from './virtual/windows';
import { MachineVerbError, type NodeModule } from './registry';

/**
 * Virtual computers (FL-16, plan §6.5, CONTRACTS §3.3 `vm.*`, R-40) — the
 * `virtual` node module:
 *
 *  - tag `virtual-host` while `--manage` is on (on Linux and macOS): this node
 *    runs FL-16's `vm-create` / `vm-control` executors, so the platform may pin
 *    those jobs to it (every such job also requires `managed` and `docker`);
 *  - `vm.list` — every child this machine hosts: its container's state
 *    (`running` · `stopped` · `creating`), or `gone` for a child whose folder is
 *    here but whose container is not (spec FR-30's reconcile reads it);
 *  - `vm.status { childId }` — one child's state.
 *
 * Reads only: everything that changes a child is a durable job (CONTRACTS §12).
 * Never a password, a token or a host path in a reply.
 */

export interface VirtualModuleDeps {
	state: VirtualState;
	runner?: CommandRunner;
	/** Windows VMs (P2): whether `/dev/kvm` is usable here (the `kvm` tag). */
	kvm?: () => boolean;
	/** Windows VMs (P2): the node's environment (an operator-configured installer image → `virtual-windows`). */
	env?: NodeJS.ProcessEnv;
	/** Windows VMs (P2): the generated passwords, for `vm.password.reveal`. */
	passwords?: WindowsPasswordStore | null;
}

/** A container's `State` column → the fact's state. */
function factState(state: string): FleetVirtualMachineFact['state'] {
	if (state === 'running' || state === 'restarting') return 'running';
	if (state === 'created') return 'creating';
	return 'stopped';
}

/** Every child this machine hosts (containers by label, plus folders whose container is gone). */
export async function listVirtualMachines(deps: { state: VirtualState; runner: CommandRunner }): Promise<FleetVirtualListResult> {
	const result = await deps.runner.run(DOCKER, containerListArgs(), { timeoutMs: 15_000 });
	if (result.code !== 0) return { docker: false, machines: [] };
	const machines = new Map<string, FleetVirtualMachineFact>();
	for (const row of parseJsonLines(result.stdout)) {
		const labels = parseDockerLabels(typeof row.Labels === 'string' ? row.Labels : '');
		const childNodeId = labels.get(VIRTUAL_CHILD_LABEL);
		if (!isChildNodeId(childNodeId)) continue;
		const meta = await deps.state.readMeta(childNodeId);
		machines.set(childNodeId, {
			childNodeId,
			name: meta?.name ?? childNodeId,
			kind: meta?.kind ?? 'container',
			systemId: meta?.systemId ?? null,
			state: factState(typeof row.State === 'string' ? row.State : ''),
			cpus: meta?.cpus ?? null,
			memoryGiB: meta?.memoryGiB ?? null,
			dataBytes: null,
			imageDigest: meta?.image?.digest ?? null
		});
	}
	for (const childNodeId of await deps.state.listChildIds()) {
		if (machines.has(childNodeId)) continue;
		const meta = await deps.state.readMeta(childNodeId);
		if (!meta) continue;
		machines.set(childNodeId, {
			childNodeId,
			name: meta.name,
			kind: meta.kind,
			systemId: meta.systemId,
			state: 'gone',
			cpus: meta.cpus,
			memoryGiB: meta.memoryGiB,
			dataBytes: null,
			imageDigest: meta.image?.digest ?? null
		});
	}
	return { docker: true, machines: [...machines.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function createVirtualModule(deps: VirtualModuleDeps): NodeModule {
	const full = { state: deps.state, runner: deps.runner ?? createMachineCommandRunner() };
	return {
		id: 'virtual',
		tags: (environment) => {
			if (!environment.consents.manage) return [];
			if (environment.platform !== 'linux' && environment.platform !== 'darwin') return [];
			const tags = [FLEET_VIRTUAL_HOST_CAPABILITY];
			// Windows VMs (P2, CONTRACTS §1.2): `kvm` when /dev/kvm is usable here (Linux
			// x86-64 only), `virtual-windows` when the operator configured an installer image.
			if (deps.kvm?.()) {
				tags.push(FLEET_KVM_CAPABILITY);
				if (resolveWindowsImage(deps.env ?? process.env)) tags.push(FLEET_VIRTUAL_WINDOWS_CAPABILITY);
			}
			return tags;
		},
		machineVerbs: {
			'vm.list': {
				stateChanging: false,
				run: () => listVirtualMachines(full)
			},
			'vm.status': {
				stateChanging: false,
				run: async (context) => {
					const childId = context.params.childId;
					if (!isChildNodeId(childId)) {
						throw new MachineVerbError(makeFleetLinkError('invalid', 'childId must be a virtual computer id'));
					}
					const listed = await listVirtualMachines(full);
					const fact = listed.machines.find((machine) => machine.childNodeId === childId.toLowerCase());
					if (!fact) throw new MachineVerbError(makeFleetLinkError('not_found', 'no such virtual computer here'));
					return fact;
				}
			},
			/**
			 * Copy password (P2, FR-21): the generated password, read once from this
			 * host's keychain and answered on this request only — never logged, never
			 * an operation. State-changing for the gate (refused while the kill switch
			 * holds the link paused); the platform checks the owner-only rule first.
			 */
			'vm.password.reveal': {
				stateChanging: true,
				run: async (context) => {
					const childId = context.params.childId;
					if (!isChildNodeId(childId)) {
						throw new MachineVerbError(makeFleetLinkError('invalid', 'childId must be a virtual computer id'));
					}
					const meta = await deps.state.readMeta(childId);
					if (!meta) throw new MachineVerbError(makeFleetLinkError('not_found', 'no such virtual computer here'));
					if (meta.kind !== 'vm') {
						throw new MachineVerbError(makeFleetLinkError('unsupported_on_node', 'a Container has no generated password'));
					}
					const password = deps.passwords ? await deps.passwords.get(childId) : null;
					if (!password) {
						throw new MachineVerbError(makeFleetLinkError('not_found', 'no password is kept for it on this computer'));
					}
					return { password };
				}
			}
		}
	};
}
