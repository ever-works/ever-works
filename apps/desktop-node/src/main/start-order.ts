import { untilHeartbeatAccepted, type NodeRuntime } from 'ever-works-node';

/**
 * Start a freshly connected runtime so that the worker leases only after a
 * heartbeat has been ACCEPTED (#2598 a).
 *
 * An accepted beat's answer carries what must be in force before the first
 * lease: the owner's saved limit ceiling (slice AS) and the version verdict
 * (slice AR). Starting the worker alongside the heartbeat let a desktop with
 * local concurrency 4 and a saved ceiling of 1 lease four jobs before the
 * ceiling arrived, and those jobs ran to completion: the lease API uses the
 * node's `max` as sent.
 *
 * `HeartbeatLoop.start()` resolves after the first attempt whether or not it
 * was accepted (a failed beat is reported through the loop's state and
 * retried with backoff). So when the first beat fails, the worker waits for
 * the first later beat that reaches `connected` (review on #2626).
 * `onAccepted`, which applies the ceiling, runs synchronously right after
 * that state change, and the continuation here is a microtask after it.
 *
 * `isCurrent` guards a disconnect while waiting: the worker of a runtime that
 * is no longer the connected one is never started. The disconnect stops the
 * loop, which reports `stopped`, so the wait ends instead of lingering.
 */
export async function startRuntimeInOrder(
	runtime: Pick<NodeRuntime, 'loop' | 'worker'>,
	isCurrent: () => boolean
): Promise<void> {
	await runtime.loop.start();
	// The shared core wait (also used by the CLI, #2628).
	const accepted = await untilHeartbeatAccepted(runtime.loop, isCurrent);
	if (!accepted || !isCurrent()) return;
	await runtime.worker?.start();
}
