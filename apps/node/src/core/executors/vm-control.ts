import {
	fleetVirtualStopGraceSec,
	isFleetVmControlAction,
	type FleetJobView,
	type FleetVmControlAction,
	type FleetVirtualKind
} from '@ever-works/contracts';
import { GUEST_ENROLLED_MARKER, GUEST_READY_MARKER } from '../link/modules/virtual/container-bootstrap';
import { containerControlArgs, homeVolumeRemoveArgs, isChildNodeId } from '../link/modules/virtual/docker-args';
import {
	docker,
	guestHasFile,
	handOverToken,
	report,
	VirtualHostError,
	type VirtualHostDeps
} from '../link/modules/virtual/host';

/**
 * Virtual computers (FL-16, plan §6.1, T-17) — the host's `vm-control`
 * executor: one act on one child, run by the management lane.
 *
 *  - `start`  — `docker start`; the child's own heartbeat turns its row online.
 *  - `stop`   — `docker stop -t 10` for a Container (spec FR-27: within 10 s);
 *               a Windows VM gets 120 s to shut down (phase 2).
 *  - `destroy` — `docker rm -f`, the child's home volume and EXACTLY its folder
 *               under the host's virtual data folder (spec S5: nothing else on
 *               the host is touched), then `gone` — the platform removes the
 *               registration and keeps the job history (FR-28).
 *  - `retry-enrollment` — the guest is built but never enrolled (U10, FR-24):
 *               a fresh token is handed over; nothing is rebuilt.
 *
 * Resize and rebuild arrive with phase 3 and are refused here until then.
 */

const DOCKER_STEP_TIMEOUT_MS = 120_000;

interface ControlPayload {
	childNodeId: string;
	action: FleetVmControlAction;
	kind: FleetVirtualKind;
}

export function parseVmControlPayload(job: FleetJobView): ControlPayload {
	const raw = (job.payload ?? {}) as Record<string, unknown>;
	if (!isChildNodeId(raw.childNodeId)) throw new VirtualHostError('the job names no virtual computer');
	if (!isFleetVmControlAction(raw.action)) throw new VirtualHostError('the job names no known act');
	return {
		childNodeId: raw.childNodeId,
		action: raw.action,
		kind: raw.kind === 'vm' ? 'vm' : 'container'
	};
}

/** The machine's state per `docker inspect`: `running`, `stopped`, or `gone` when there is no such container. */
export async function containerState(deps: VirtualHostDeps, childNodeId: string): Promise<'running' | 'stopped' | 'gone'> {
	const result = await deps.runner.run('docker', containerControlArgs('inspect', childNodeId), { timeoutMs: 15_000 });
	if (result.code !== 0) return 'gone';
	const status = result.stdout.trim();
	return status === 'running' || status === 'restarting' ? 'running' : 'stopped';
}

export function createVmControlExecutor(deps: VirtualHostDeps) {
	return async (job: FleetJobView, signal: AbortSignal): Promise<Record<string, unknown>> => {
		const { childNodeId: child, action, kind } = parseVmControlPayload(job);
		try {
			switch (action) {
				case 'start': {
					if ((await containerState(deps, child)) === 'gone') {
						await report(deps, job, child, { state: 'gone' });
						throw new VirtualHostError('its container is gone on this computer');
					}
					await docker(deps, containerControlArgs('start', child), DOCKER_STEP_TIMEOUT_MS, 'could not start it');
					await report(deps, job, child, { state: 'running', error: null });
					return { childNodeId: child, state: 'running' };
				}
				case 'stop': {
					const grace = fleetVirtualStopGraceSec(kind);
					if ((await containerState(deps, child)) === 'gone') {
						await report(deps, job, child, { state: 'gone' });
						return { childNodeId: child, state: 'gone' };
					}
					await docker(
						deps,
						containerControlArgs('stop', child, grace),
						(grace + 60) * 1000,
						'could not stop it'
					);
					await report(deps, job, child, { state: 'stopped', error: null });
					return { childNodeId: child, state: 'stopped' };
				}
				case 'destroy': {
					await docker(deps, containerControlArgs('remove', child), DOCKER_STEP_TIMEOUT_MS, 'could not remove it').catch(
						async (error: unknown) => {
							// "No such container" is the state we want; anything else is a real failure.
							if ((await containerState(deps, child)) !== 'gone') throw error;
						}
					);
					await deps.runner.run('docker', homeVolumeRemoveArgs(child), { timeoutMs: DOCKER_STEP_TIMEOUT_MS });
					await deps.state.removeChild(child);
					await report(deps, job, child, { state: 'gone' });
					return { childNodeId: child, state: 'gone' };
				}
				case 'retry-enrollment': {
					if ((await containerState(deps, child)) !== 'running') {
						throw new VirtualHostError('it is not running; start it first');
					}
					if (await guestHasFile(deps, child, GUEST_ENROLLED_MARKER)) {
						return { childNodeId: child, state: 'running', alreadyEnrolled: true };
					}
					if (!(await guestHasFile(deps, child, GUEST_READY_MARKER))) {
						throw new VirtualHostError('its node runtime is not installed yet');
					}
					await handOverToken(deps, job, child, GUEST_ENROLLED_MARKER, signal);
					await report(deps, job, child, { phase: 'online', state: 'running' });
					return { childNodeId: child, state: 'running' };
				}
				case 'resize':
				case 'rebuild':
					throw new VirtualHostError(`${action} is not available on this computer yet`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (action !== 'destroy') await report(deps, job, child, { error: message.split(/\r?\n/)[0].slice(0, 300) });
			throw error instanceof VirtualHostError ? error : new VirtualHostError(message);
		}
	};
}
