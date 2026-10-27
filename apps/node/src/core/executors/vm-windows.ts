import { posix } from 'node:path';
import {
	fleetVirtualContainerName,
	FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB,
	type FleetJobView,
	type FleetVirtualSystem,
	type FleetVmCreatePayload
} from '@ever-works/contracts';
import { runnableImageRef, splitImageDigest } from '../link/modules/virtual/catalogue';
import { containerControlArgs, imageDigestArgs, imagePullArgs } from '../link/modules/virtual/docker-args';
import { docker, report, VirtualHostError, waitFor, type VirtualHostDeps } from '../link/modules/virtual/host';
import {
	generateWindowsPassword,
	parseViewerPort,
	resolveWindowsImage,
	storageVolumeName,
	viewerPortArgs,
	windowsFirstBootScript,
	windowsInstallBat,
	windowsRunArgs,
	windowsShare,
	WINDOWS_BOOTED_MARKER,
	WINDOWS_ENROLLED_MARKER,
	WINDOWS_READY_MARKER,
	WINDOWS_TOKEN_FILE
} from '../link/modules/virtual/windows';

/**
 * Virtual computers, phase 2 (FL-16, plan §6.6, T-29) — the Windows path of
 * `vm-create`:
 *
 *   prechecks            Linux x86-64, `/dev/kvm` usable, ≥ 30 GB free where Docker keeps
 *                        its volumes, an installer image configured — each refusing with its
 *                        own sentence BEFORE anything is pulled (FR-18, U3, U7)
 *   pulling-image        the operator's installer image (pinned to its digest here on first use)
 *   downloading-windows  the container starts; the installer fetches Microsoft's media
 *   installing           Windows installs itself (15–30 minutes; the viewer is open on the
 *                        host's loopback for "Watch the install", FR-23)
 *   first-boot           the first-boot step reported it started (`booted.txt`)
 *   installing-runtime   … installing Node.js and `ever-works-node`
 *   enrolling            it wrote `ready.txt`: the token is minted NOW (R-35, FR-24) and put
 *                        in the shared folder (0600 on the host), removed once it enrolled
 *   online               `enrolled.txt`; its own heartbeat turns the row green
 *
 * The password is generated here (24 characters), stored only in this host's
 * keychain (or the owner-only file fallback), and handed to the installer
 * through a 0600 `--env-file` removed as soon as the container exists — never
 * an argv, a job, a log or the platform (FR-20).
 */

const PULL_TIMEOUT_MS = 60 * 60 * 1000;
const DOCKER_STEP_TIMEOUT_MS = 120_000;
/** Windows installs over 15–30 minutes; nothing gives up before two hours (plan §15). */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** U10: a guest that never enrols reads `not-enrolled` after 20 minutes; the host waits that long too. */
const WINDOWS_ENROLL_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 5_000;
/** After this long without the first-boot marker the phase reads "installing" rather than "downloading". */
const DOWNLOAD_PHASE_MS = 5 * 60 * 1000;

/** Free MiB on the filesystem holding Docker's data (where the VM's disk volume lives), or null when unknown. */
export async function dockerFreeDiskMiB(deps: Pick<VirtualHostDeps, 'runner'>): Promise<number | null> {
	const info = await deps.runner.run('docker', ['info', '--format', '{{.DockerRootDir}}'], { timeoutMs: 15_000 });
	const root = info.code === 0 ? info.stdout.trim() : '';
	const target = root.startsWith('/') ? root : '/var/lib/docker';
	const df = await deps.runner.run('df', ['-Pk', target], { timeoutMs: 15_000 });
	if (df.code !== 0) return null;
	const line = df.stdout.trim().split(/\r?\n/)[1] ?? '';
	const available = Number(line.trim().split(/\s+/)[3]);
	return Number.isFinite(available) ? Math.floor(available / 1024) : null;
}

/** The FR-18 prechecks, in order; resolves the image to run, or throws the first shortfall. */
export async function windowsPrechecks(deps: VirtualHostDeps, hostName: string) {
	if (deps.platform !== 'linux' || deps.arch !== 'x64') {
		throw new VirtualHostError(`Windows VMs need a Linux x86-64 host; ${hostName} is not one`);
	}
	if (!deps.kvm?.()) {
		throw new VirtualHostError(`Windows VMs need /dev/kvm on a Linux x86-64 host; it is not usable on ${hostName}`);
	}
	const image = resolveWindowsImage(deps.env);
	if (!image) {
		throw new VirtualHostError(
			`No Windows installer image is configured on ${hostName}; set EVER_WORKS_NODE_VIRTUAL_WINDOWS_IMAGE there`
		);
	}
	const free = await dockerFreeDiskMiB(deps);
	if (free !== null && free < FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB * 1024) {
		throw new VirtualHostError(
			`Windows needs about ${FLEET_VIRTUAL_WINDOWS_MIN_FREE_DISK_GIB} GB free on ${hostName}; ${Math.floor(free / 1024)} GB is free`
		);
	}
	if (!deps.passwords) throw new VirtualHostError('this host cannot keep a generated password');
	return image;
}

/** Remove a failed / destroyed VM: the container, its disk volume, its password, its folder. */
export async function cleanUpWindows(deps: VirtualHostDeps, childNodeId: string): Promise<void> {
	await deps.runner
		.run('docker', containerControlArgs('remove', childNodeId), { timeoutMs: DOCKER_STEP_TIMEOUT_MS })
		.catch(() => undefined);
	await deps.runner
		.run('docker', ['volume', 'rm', '-f', storageVolumeName(childNodeId)], { timeoutMs: DOCKER_STEP_TIMEOUT_MS })
		.catch(() => undefined);
	await deps.passwords?.delete(childNodeId).catch(() => undefined);
	await deps.state.removeChild(childNodeId).catch(() => undefined);
}

/**
 * The Windows token hand-over (R-35, FR-24): mint the token now, write it to
 * the shared folder (0600), wait for `enrolled.txt`, and remove the file
 * whatever happened. Shared by the create and `retry-enrollment`.
 */
export async function handOverWindowsToken(
	deps: VirtualHostDeps,
	job: FleetJobView,
	childNodeId: string,
	signal?: AbortSignal
): Promise<void> {
	const shared = deps.state.sharedDir(childNodeId);
	const minted = await deps.client().mintVirtualEnrollToken(childNodeId, job.id, job.leaseGeneration);
	const token = minted?.token;
	if (typeof token !== 'string' || token.length < 16)
		throw new VirtualHostError('the platform did not hand over a token');
	deps.logger?.protect(token);
	const tokenPath = await deps.state.writePrivate(
		childNodeId,
		posix.join('shared', WINDOWS_TOKEN_FILE),
		`${token}\n`
	);
	try {
		await report(deps, job, childNodeId, { phase: 'enrolling' });
		await waitFor(deps, () => deps.state.exists(posix.join(shared, WINDOWS_ENROLLED_MARKER)), {
			timeoutMs: WINDOWS_ENROLL_TIMEOUT_MS,
			everyMs: POLL_MS,
			signal,
			what: 'enrolment'
		});
	} finally {
		await deps.state.removeFile(tokenPath).catch(() => undefined);
		deps.logger?.unprotect(token);
	}
}

export async function buildWindowsVm(
	deps: VirtualHostDeps,
	job: FleetJobView,
	payload: FleetVmCreatePayload,
	system: FleetVirtualSystem,
	signal: AbortSignal,
	hostName: string
): Promise<Record<string, unknown>> {
	const child = payload.childNodeId;
	const configured = await windowsPrechecks(deps, hostName);
	const apiUrl = payload.apiUrl ?? deps.apiUrl;
	const runtimeSpec = deps.env.EVER_WORKS_NODE_VIRTUAL_RUNTIME_SPEC?.trim() || `ever-works-node@${deps.nodeVersion}`;
	const share = windowsShare(deps.env);
	const diskGiB = payload.diskGiB ?? 64;
	let envFile: string | null = null;
	try {
		await deps.runner.run('docker', containerControlArgs('remove', child), { timeoutMs: DOCKER_STEP_TIMEOUT_MS });

		await report(deps, job, child, { phase: 'pulling-image', state: 'creating', error: null, activated: false });
		const lock = await deps.state.readLock();
		const locked = lock[system.id];
		const image =
			!configured.digest && locked && locked.ref === configured.ref
				? { ...configured, digest: locked.digest }
				: configured;
		const runnable = runnableImageRef(image);
		await docker(deps, imagePullArgs(runnable), PULL_TIMEOUT_MS, 'could not pull the installer image');
		let digest = image.digest;
		if (!digest) {
			const stdout = await docker(
				deps,
				imageDigestArgs(image.ref),
				DOCKER_STEP_TIMEOUT_MS,
				'could not read the image digest'
			);
			digest = splitImageDigest(stdout.trim()).digest;
			if (digest) await deps.state.writeLock({ ...lock, [system.id]: { ref: image.ref, digest } });
		}
		await report(deps, job, child, { image: { ref: image.ref, digest } });

		// The password: generated here, kept only in this host's keychain (or the owner-only file).
		const password = generateWindowsPassword();
		deps.logger?.protect(password);
		await deps.passwords!.set(child, password);
		await deps.state.prepareWindows(child, {
			installBat: windowsInstallBat(),
			firstBoot: windowsFirstBootScript({ runtimeSpec, nodeMajor: deps.nodeMajor, apiUrl, shareUnc: share.unc })
		});
		await deps.state.writeMeta({
			childNodeId: child,
			name: payload.name,
			systemId: system.id,
			kind: 'vm',
			cpus: payload.cpus,
			memoryGiB: payload.memoryGiB,
			diskGiB,
			image: { ref: image.ref, digest },
			createdAt: new Date(deps.now()).toISOString()
		});
		envFile = await deps.state.writePrivate(child, posix.join('run', 'vm.env'), `PASSWORD=${password}\n`);
		if (signal.aborted) throw new VirtualHostError('the create was cancelled');

		await report(deps, job, child, { phase: 'downloading-windows' });
		await docker(
			deps,
			windowsRunArgs({
				childNodeId: child,
				name: payload.name,
				image: digest ? runnableImageRef({ ref: image.ref, digest }) : runnable,
				edition: system.windowsEdition ?? '11',
				cpus: payload.cpus,
				memoryGiB: payload.memoryGiB,
				diskGiB,
				envFile,
				oemDir: deps.state.oemDir(child),
				sharedDir: deps.state.sharedDir(child),
				shareTarget: share.dir
			}),
			DOCKER_STEP_TIMEOUT_MS,
			'could not start the installer'
		);
		// The container holds the password now; the file goes at once (FR-20).
		await deps.state.removeFile(envFile).catch(() => undefined);
		envFile = null;
		deps.logger?.unprotect(password);

		const portOut = await deps.runner.run('docker', viewerPortArgs(child), { timeoutMs: 15_000 });
		const viewerPort = portOut.code === 0 ? parseViewerPort(portOut.stdout) : null;
		if (viewerPort !== null) await report(deps, job, child, { viewerPort });

		const shared = deps.state.sharedDir(child);
		const started = deps.now();
		let phase: 'downloading-windows' | 'installing' | 'first-boot' = 'downloading-windows';
		await waitFor(
			deps,
			async () => {
				if (await deps.state.exists(posix.join(shared, WINDOWS_READY_MARKER))) return true;
				if (phase !== 'first-boot' && (await deps.state.exists(posix.join(shared, WINDOWS_BOOTED_MARKER)))) {
					phase = 'first-boot';
					await report(deps, job, child, { phase: 'first-boot' });
					await report(deps, job, child, { phase: 'installing-runtime' });
				} else if (phase === 'downloading-windows' && deps.now() - started > DOWNLOAD_PHASE_MS) {
					phase = 'installing';
					await report(deps, job, child, { phase: 'installing' });
				}
				const status = (
					await docker(deps, containerControlArgs('inspect', child), 15_000, 'could not read the installer')
				).trim();
				if (status === 'exited' || status === 'dead')
					throw new VirtualHostError('the installer stopped before Windows was ready');
				return false;
			},
			{ timeoutMs: INSTALL_TIMEOUT_MS, everyMs: POLL_MS, signal, what: 'installing Windows' }
		);

		await handOverWindowsToken(deps, job, child, signal);
		await report(deps, job, child, { phase: 'online', state: 'running', viewerPort: null });
		return { childNodeId: child, container: fleetVirtualContainerName(child), image: image.ref };
	} catch (error) {
		if (envFile) await deps.state.removeFile(envFile).catch(() => undefined);
		const message = error instanceof Error ? error.message : String(error);
		await cleanUpWindows(deps, child);
		await report(deps, job, child, {
			state: 'failed',
			error: message.split(/\r?\n/)[0].slice(0, 300),
			viewerPort: null
		});
		throw error instanceof VirtualHostError ? error : new VirtualHostError(message);
	}
}
