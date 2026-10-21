import { isFleetLoopbackBind, type FleetListeningPort } from '@ever-works/contracts';

/**
 * Servers and ports (FL-10, spec S5, S7, FR-5, FR-6) — rows that are not a
 * listener right now:
 *
 *  - **waiting** — a port the person typed into "Open a port…": shown as
 *    `⏳ :4000 waiting for a server…` until something listens on it, when it
 *    becomes an ordinary row (it is then simply in the list);
 *  - **stopped** — a port that was on the previous list and is gone now:
 *    shown once as "stopped", dropped on the list after that.
 *
 * The node keeps the previous list per process (one Ports tab or many, the
 * machine is the same), so "stopped" is about the machine, not a viewer.
 */

/** Waiting rows for watched ports nothing listens on, in the order asked. */
export function waitingRows(watch: readonly number[], present: ReadonlySet<number>): FleetListeningPort[] {
	return watch
		.filter((port) => !present.has(port))
		.map((port) => ({ port, proto: 'tcp' as const, bind: '127.0.0.1', localOnly: true, kind: 'waiting' as const }));
}

/** Remembers the last list's ports to mark the ones that disappeared. */
export class StoppedPortTracker {
	private previous = new Map<number, FleetListeningPort>();

	/**
	 * Given the current listener rows, answer the rows of ports that were
	 * listening last time and are gone now (each marked `stopped`), and
	 * remember the current rows for next time. A row already reported as
	 * stopped is not reported again.
	 */
	stoppedSince(current: readonly FleetListeningPort[]): FleetListeningPort[] {
		const now = new Map<number, FleetListeningPort>();
		for (const row of current) if (row.kind !== 'waiting') now.set(row.port, row);
		const gone: FleetListeningPort[] = [];
		for (const [port, row] of this.previous) {
			if (!now.has(port) && !row.stopped && row.kind !== 'noise') {
				gone.push({ ...row, stopped: true, localOnly: row.localOnly || isFleetLoopbackBind(row.bind) });
			}
		}
		this.previous = now;
		return gone;
	}

	reset(): void {
		this.previous.clear();
	}
}
