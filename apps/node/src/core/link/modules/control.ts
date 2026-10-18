import type { FleetLinkDrain } from '@ever-works/contracts';
import type { NodeLinkControlState, NodeModule } from './registry';

/**
 * Fleet node link — the control module and the link's channel-0 state.
 *
 * The state every other module reads:
 *
 *  - **paused** — the platform threw the fleet kill switch (`link.pause`).
 *    New channels are refused and state-changing requests answer
 *    `kill_switch`; replies already in flight finish, and nothing is killed:
 *    a daemon session is paused with its process left running (CONTRACTS
 *    R-24). `link.resume` lifts it without a reconnect.
 *  - **drain** — the owner pressed "Drain all" (`link.drain { graceSec }`):
 *    the session module (FL-04) warns every owner session and ends it after
 *    the grace.
 *
 * The module itself contributes the `managed` tag: advertised exactly when
 * this process was started with `--manage` (CONTRACTS §1.2), never from a
 * guess.
 */

export const FLEET_MANAGED_CAPABILITY = 'managed';

type ControlSnapshot = { paused: boolean; drain: { graceSec: number; receivedAt: number } | null };

/** The mutable side of {@link NodeLinkControlState}, owned by the link client. */
export interface LinkControlStateHolder extends NodeLinkControlState {
	pause(): void;
	resume(): void;
	startDrain(message: FleetLinkDrain, receivedAt: number): void;
}

export function createLinkControlState(): LinkControlStateHolder {
	let paused = false;
	let drain: ControlSnapshot['drain'] = null;
	const listeners = new Set<(state: ControlSnapshot) => void>();
	const notify = () => {
		const snapshot: ControlSnapshot = { paused, drain };
		for (const listener of [...listeners]) {
			try {
				listener(snapshot);
			} catch {
				// a listener's failure is its own
			}
		}
	};
	return {
		get paused() {
			return paused;
		},
		get drain() {
			return drain;
		},
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		pause() {
			if (paused) return;
			paused = true;
			notify();
		},
		resume() {
			if (!paused) return;
			paused = false;
			notify();
		},
		startDrain(message, receivedAt) {
			drain = { graceSec: message.graceSec, receivedAt };
			notify();
		}
	};
}

export const controlModule: NodeModule = {
	id: 'control',
	tags: (environment) => (environment.consents.manage ? [FLEET_MANAGED_CAPABILITY] : [])
};
