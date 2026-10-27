import {
	fleetVirtualContainerName,
	fleetVirtualSystem,
	isFleetVirtualName,
	type FleetJobView,
	type FleetVirtualSystem,
	type FleetVmCreatePayload
} from '@ever-works/contracts';
import {
	resolveVirtualImage,
	runnableImageRef,
	splitImageDigest,
	type VirtualImage
} from '../link/modules/virtual/catalogue';
import {
	containerBootstrapScript,
	GUEST_ENROLLED_MARKER,
	GUEST_READY_MARKER
} from '../link/modules/virtual/container-bootstrap';
import {
	containerControlArgs,
	containerRunArgs,
	homeVolumeRemoveArgs,
	imageDigestArgs,
	imagePullArgs,
	isChildNodeId
} from '../link/modules/virtual/docker-args';
import {
	docker,
	guestHasFile,
	GUEST_POLL_MS,
	handOverToken,
	report,
	RUNTIME_INSTALL_TIMEOUT_MS,
	VirtualHostError,
	waitFor,
	type VirtualHostDeps
} from '../link/modules/virtual/host';
import { buildWindowsVm } from './vm-windows';

/**
 * Virtual computers (FL-16, plan §6.1, §6.7, T-16) — the host's `vm-create`
 * executor, run by the management lane under `--manage` (CONTRACTS R-34).
 * Phase 1 builds Containers; phase 2 adds the Windows path (`./vm-windows`).
 *
 * Phases (spec FR-13), each reported to the platform as it starts:
 *
 *   pulling-image        the catalogue image (pinned to its digest on first use)
 *   starting             `docker run` with the CPU / memory caps, the home volume
 *                        and the bootstrap (nothing else of the host inside)
 *   installing-runtime   the guest installs Node.js and `ever-works-node`
 *   enrolling            the guest is ready → the token is minted NOW (R-35) and
 *                        handed over through `docker exec -i`
 *   online               the guest enrolled; its own heartbeat turns the row green
 *
 * A failure at any step (spec U8) reports `failed` with the first line of what
 * went wrong, removes the container, its home volume and its folder — nothing
 * half-built is left running — and fails the job. A cancelled job (the owner
 * destroyed it while it was being built) cleans up the same way. Re-running the
 * same create (a lapsed claim) starts over from a clean slate: the container
 * name is the child's, so a leftover is removed first.
 */

/** How long a first pull may take. */
const PULL_TIMEOUT_MS = 20 * 60 * 1000;
const DOCKER_STEP_TIMEOUT_MS = 120_000;

/** The `vm-create` payload off the job, validated on the machine (never trusted from the platform). */
export function parseVmCreatePayload(job: FleetJobView): { payload: FleetVmCreatePayload; system: FleetVirtualSystem } {
	const raw = (job.payload ?? {}) as Partial<FleetVmCreatePayload>;
	if (!isChildNodeId(raw.childNodeId)) throw new VirtualHostError('the job names no virtual computer');
	if (!isChildNodeId(raw.hostNodeId)) throw new VirtualHostError('the job names no host');
	if (!isFleetVirtualName(raw.name)) throw new VirtualHostError('the virtual computer name is not valid');
	const system = fleetVirtualSystem(raw.systemId);
	if (!system) throw new VirtualHostError('the job names an unknown system');
	const cpus = Number(raw.cpus);
	const memoryGiB = Number(raw.memoryGiB);
	if (![2, 4, 8].includes(cpus)) throw new VirtualHostError('CPUs must be 2, 4 or 8');
	if (![4, 8, 16].includes(memoryGiB)) throw new VirtualHostError('memory must be 4, 8 or 16 GB');
	return {
		payload: {
			childNodeId: raw.childNodeId,
			hostNodeId: raw.hostNodeId,
			name: raw.name,
			systemId: system.id,
			kind: system.kind,
			cpus,
			memoryGiB,
			diskGiB: typeof raw.diskGiB === 'number' ? raw.diskGiB : null,
			apiUrl: typeof raw.apiUrl === 'string' ? raw.apiUrl : null
		},
		system
	};
}

/** Pull the system's image (pinning its digest here on first use) and answer what to run. */
export async function pullPinnedImage(
	deps: VirtualHostDeps,
	system: FleetVirtualSystem
): Promise<{ image: VirtualImage; runnable: string }> {
	const lock = await deps.state.readLock();
	const image = resolveVirtualImage(system.id, { env: deps.env, lock });
	if (!image) throw new VirtualHostError(`${system.label} is not in this computer's catalogue`);
	const runnable = runnableImageRef(image);
	await docker(deps, imagePullArgs(runnable), PULL_TIMEOUT_MS, 'could not pull the image');
	if (image.digest) return { image, runnable };
	// First use on this machine: record the digest the tag resolved to.
	const stdout = await docker(
		deps,
		imageDigestArgs(image.ref),
		DOCKER_STEP_TIMEOUT_MS,
		'could not read the image digest'
	);
	const { digest } = splitImageDigest(stdout.trim());
	if (!digest) return { image, runnable };
	if (image.source === 'catalogue') {
		await deps.state.writeLock({ ...lock, [system.id]: { ref: image.ref, digest } });
	}
	const pinned: VirtualImage = { ...image, digest };
	return { image: pinned, runnable: runnableImageRef(pinned) };
}

/** Remove whatever a failed or cancelled build left: the container, its home volume, its folder. */
export async function cleanUpChild(deps: VirtualHostDeps, childNodeId: string): Promise<void> {
	await deps.runner
		.run('docker', containerControlArgs('remove', childNodeId), { timeoutMs: DOCKER_STEP_TIMEOUT_MS })
		.catch(() => undefined);
	await deps.runner
		.run('docker', homeVolumeRemoveArgs(childNodeId), { timeoutMs: DOCKER_STEP_TIMEOUT_MS })
		.catch(() => undefined);
	await deps.state.removeChild(childNodeId).catch(() => undefined);
}

export function createVmCreateExecutor(deps: VirtualHostDeps) {
	return async (job: FleetJobView, signal: AbortSignal): Promise<Record<string, unknown>> => {
		const { payload, system } = parseVmCreatePayload(job);
		const child = payload.childNodeId;
		if (system.kind !== 'container') {
			// Windows VMs (P2): their own path — prechecks, the installer, the first boot.
			return buildWindowsVm(deps, job, payload, system, signal, deps.nodeName ?? 'this computer');
		}
		const apiUrl = payload.apiUrl ?? deps.apiUrl;
		const runtimeSpec =
			deps.env.EVER_WORKS_NODE_VIRTUAL_RUNTIME_SPEC?.trim() || `ever-works-node@${deps.nodeVersion}`;
		try {
			// A leftover from an earlier attempt of the same create is removed first.
			await deps.runner.run('docker', containerControlArgs('remove', child), {
				timeoutMs: DOCKER_STEP_TIMEOUT_MS
			});

			await report(deps, job, child, { phase: 'pulling-image', state: 'creating', error: null });
			const { image, runnable } = await pullPinnedImage(deps, system);
			await report(deps, job, child, { image: { ref: image.ref, digest: image.digest } });

			await report(deps, job, child, { phase: 'starting' });
			await deps.state.prepare(
				child,
				containerBootstrapScript({ family: system.family, runtimeSpec, nodeMajor: deps.nodeMajor, apiUrl })
			);
			await deps.state.writeMeta({
				childNodeId: child,
				name: payload.name,
				systemId: system.id,
				kind: system.kind,
				cpus: payload.cpus,
				memoryGiB: payload.memoryGiB,
				diskGiB: null,
				image: { ref: image.ref, digest: image.digest },
				createdAt: new Date(deps.now()).toISOString()
			});
			if (signal.aborted) throw new VirtualHostError('the create was cancelled');
			await docker(
				deps,
				containerRunArgs({
					childNodeId: child,
					name: payload.name,
					image: runnable,
					cpus: payload.cpus,
					memoryGiB: payload.memoryGiB,
					runDir: deps.state.runDir(child)
				}),
				DOCKER_STEP_TIMEOUT_MS,
				'could not start the container'
			);

			await report(deps, job, child, { phase: 'installing-runtime' });
			await waitFor(
				deps,
				async () => {
					if (await guestHasFile(deps, child, GUEST_READY_MARKER)) return true;
					const status = (
						await docker(
							deps,
							containerControlArgs('inspect', child),
							15_000,
							'could not read the container'
						)
					).trim();
					if (status === 'exited' || status === 'dead') {
						const logs = await deps.runner.run('docker', containerControlArgs('logs', child), {
							timeoutMs: 15_000
						});
						const last = (logs.stderr || logs.stdout).trim().split(/\r?\n/).pop() ?? '';
						throw new VirtualHostError(
							`the container stopped while installing the runtime${last ? `: ${last.slice(0, 200)}` : ''}`
						);
					}
					return false;
				},
				{
					timeoutMs: RUNTIME_INSTALL_TIMEOUT_MS,
					everyMs: GUEST_POLL_MS,
					signal,
					what: 'installing the node runtime'
				}
			);

			await handOverToken(deps, job, child, GUEST_ENROLLED_MARKER, signal);
			await report(deps, job, child, { phase: 'online', state: 'running' });
			return { childNodeId: child, container: fleetVirtualContainerName(child), image: runnable };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await cleanUpChild(deps, child);
			await report(deps, job, child, { state: 'failed', error: message.split(/\r?\n/)[0].slice(0, 300) });
			throw error instanceof VirtualHostError ? error : new VirtualHostError(message);
		}
	};
}
