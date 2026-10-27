import { posix } from 'node:path';
import {
	fleetVirtualSystem,
	isFleetVirtualCpus,
	isFleetVirtualMemoryGiB,
	type FleetJobView
} from '@ever-works/contracts';
import { resolveVirtualImage, runnableImageRef, splitImageDigest } from '../link/modules/virtual/catalogue';
import { containerBootstrapScript } from '../link/modules/virtual/container-bootstrap';
import {
	containerControlArgs,
	containerRunArgs,
	containerUpdateArgs,
	imageDigestArgs,
	imagePullArgs
} from '../link/modules/virtual/docker-args';
import { docker, report, VirtualHostError, type VirtualHostDeps } from '../link/modules/virtual/host';
import { resolveWindowsImage, windowsCreateArgs, windowsShare } from '../link/modules/virtual/windows';

/**
 * Virtual computers, phase 3 (FL-16, spec FR-38, FR-39, T-34) — the two acts
 * that change a machine without rebuilding its Fleet registration:
 *
 *  - **resize** a STOPPED machine: a Container's caps change in place
 *    (`docker update`); a Windows VM's container is re-created stopped with
 *    the new size, keeping its disk volume, first-boot files and shared folder
 *    (the installer reads the size only when its container is made);
 *  - **rebuild** a Container from the catalogue's CURRENT image: the tag is
 *    pulled and re-pinned, the container re-created with the same caps and
 *    the SAME home volume (its enrolment, its files), and started — the guest
 *    reinstalls the runtime and starts without a new token.
 *
 * Both refuse a machine in the wrong state with the sentence a person reads;
 * the platform checked the same before queueing (`busy`).
 */

const DOCKER_STEP_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 20 * 60 * 1000;

async function stateOf(deps: VirtualHostDeps, childNodeId: string): Promise<'running' | 'stopped' | 'gone'> {
	const result = await deps.runner.run('docker', containerControlArgs('inspect', childNodeId), { timeoutMs: 15_000 });
	if (result.code !== 0) return 'gone';
	const status = result.stdout.trim();
	return status === 'running' || status === 'restarting' ? 'running' : 'stopped';
}

export async function resizeVirtual(
	deps: VirtualHostDeps,
	job: FleetJobView,
	childNodeId: string
): Promise<Record<string, unknown>> {
	const raw = (job.payload ?? {}) as Record<string, unknown>;
	const meta = await deps.state.readMeta(childNodeId);
	if (!meta) throw new VirtualHostError('this computer keeps no record of it');
	const cpus = isFleetVirtualCpus(raw.cpus) ? raw.cpus : meta.cpus;
	const memoryGiB = isFleetVirtualMemoryGiB(raw.memoryGiB) ? raw.memoryGiB : meta.memoryGiB;
	const state = await stateOf(deps, childNodeId);
	if (state === 'gone') {
		await report(deps, job, childNodeId, { state: 'gone' });
		throw new VirtualHostError('its container is gone on this computer');
	}
	if (state === 'running') throw new VirtualHostError('it is running; stop it first');

	if (meta.kind === 'container') {
		await docker(
			deps,
			containerUpdateArgs(childNodeId, cpus, memoryGiB),
			DOCKER_STEP_TIMEOUT_MS,
			'could not resize it'
		);
	} else {
		const image = resolveWindowsImage(deps.env);
		if (!image) throw new VirtualHostError('No Windows installer image is configured on this computer');
		const password = deps.passwords ? await deps.passwords.get(childNodeId) : null;
		if (!password) throw new VirtualHostError('this computer no longer keeps its password');
		deps.logger?.protect(password);
		const envFile = await deps.state.writePrivate(
			childNodeId,
			posix.join('run', 'vm.env'),
			`PASSWORD=${password}\n`
		);
		try {
			await docker(
				deps,
				containerControlArgs('remove', childNodeId),
				DOCKER_STEP_TIMEOUT_MS,
				'could not replace it'
			);
			const system = fleetVirtualSystem(meta.systemId);
			const share = windowsShare(deps.env);
			await docker(
				deps,
				windowsCreateArgs({
					childNodeId,
					name: meta.name,
					image: meta.image?.digest
						? runnableImageRef({ ref: meta.image.ref, digest: meta.image.digest })
						: image.ref,
					edition: system?.windowsEdition ?? '11',
					cpus,
					memoryGiB,
					diskGiB: meta.diskGiB ?? 64,
					envFile,
					oemDir: deps.state.oemDir(childNodeId),
					sharedDir: deps.state.sharedDir(childNodeId),
					shareTarget: share.dir
				}),
				DOCKER_STEP_TIMEOUT_MS,
				'could not re-create it with the new size'
			);
		} finally {
			await deps.state.removeFile(envFile).catch(() => undefined);
			deps.logger?.unprotect(password);
		}
	}
	await deps.state.writeMeta({ ...meta, cpus, memoryGiB });
	await report(deps, job, childNodeId, { cpus, memoryGiB, state: 'stopped', error: null });
	return { childNodeId, cpus, memoryGiB };
}

export async function rebuildContainer(
	deps: VirtualHostDeps,
	job: FleetJobView,
	childNodeId: string
): Promise<Record<string, unknown>> {
	const meta = await deps.state.readMeta(childNodeId);
	if (!meta) throw new VirtualHostError('this computer keeps no record of it');
	if (meta.kind !== 'container') throw new VirtualHostError('only a Container is rebuilt from an image');
	const system = fleetVirtualSystem(meta.systemId);
	if (!system) throw new VirtualHostError('its system is no longer in the catalogue');

	// The catalogue's CURRENT image: an override as named, else the tag pulled afresh and re-pinned.
	const lock = await deps.state.readLock();
	const named = resolveVirtualImage(system.id, { env: deps.env });
	if (!named) throw new VirtualHostError(`${system.label} is not in this computer's catalogue`);
	await report(deps, job, childNodeId, { phase: 'pulling-image', error: null });
	await docker(deps, imagePullArgs(named.ref), PULL_TIMEOUT_MS, 'could not pull the image');
	let digest = named.digest;
	if (!digest) {
		const stdout = await docker(
			deps,
			imageDigestArgs(named.ref),
			DOCKER_STEP_TIMEOUT_MS,
			'could not read the image digest'
		);
		digest = splitImageDigest(stdout.trim()).digest;
		if (digest && named.source === 'catalogue') {
			await deps.state.writeLock({ ...lock, [system.id]: { ref: named.ref, digest } });
		}
	}
	const runnable = runnableImageRef({ ref: named.ref, digest });
	await report(deps, job, childNodeId, { image: { ref: named.ref, digest } });

	const apiUrl = deps.apiUrl;
	const runtimeSpec = deps.env.EVER_WORKS_NODE_VIRTUAL_RUNTIME_SPEC?.trim() || `ever-works-node@${deps.nodeVersion}`;
	await deps.state.prepare(
		childNodeId,
		containerBootstrapScript({ family: system.family, runtimeSpec, nodeMajor: deps.nodeMajor, apiUrl })
	);
	// The old container goes; its home volume stays (FR-39).
	await docker(deps, containerControlArgs('remove', childNodeId), DOCKER_STEP_TIMEOUT_MS, 'could not replace it');
	await report(deps, job, childNodeId, { phase: 'starting' });
	await docker(
		deps,
		containerRunArgs({
			childNodeId,
			name: meta.name,
			image: runnable,
			cpus: meta.cpus,
			memoryGiB: meta.memoryGiB,
			runDir: deps.state.runDir(childNodeId)
		}),
		DOCKER_STEP_TIMEOUT_MS,
		'could not start the rebuilt container'
	);
	await deps.state.writeMeta({ ...meta, image: { ref: named.ref, digest } });
	await report(deps, job, childNodeId, { phase: 'online', state: 'running', error: null });
	return { childNodeId, image: runnable };
}
