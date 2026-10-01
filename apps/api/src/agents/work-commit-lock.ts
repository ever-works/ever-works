/**
 * One commit per Work at a time (APW-08 T2, plan §2.2).
 *
 * `commitToRepo` and `openPullRequest` both work in the **shared** working copy of a Work's data
 * repository (`cloneOrPull` keys the directory by owner/repo and its in-flight map by
 * plugin/owner/repo/branch/switch — `packages/agent/src/facades/git.facade.ts`), so two agent
 * commits for the same Work would interleave: the second `switchBranch` can move the checkout
 * under the first `push`, and the first commit then lands on the wrong branch, or not at all.
 *
 * This lock is deliberately **per Work** and not global: two Works share nothing but the process,
 * so serializing them would cost throughput and buy nothing. It is in-process only — the same
 * shape every other per-key queue in this app uses (`existing-website-link.service.ts`,
 * `activity-log.controller.ts`) — because a commit is driven by one API request, and the
 * cross-process hazard belongs to `checkoutKey` (APW08-G24, APW-02 P0), not here.
 *
 * The failure mode is a **refusal, not a queue**: a caller that waits longer than `waitMs`
 * rejects with {@link WORK_COMMIT_LOCK_TIMEOUT_MESSAGE} and writes nothing (plan §2.2's failure
 * table: "Commit lock wait exceeds 120 s → Tool returns the FR-6 error; nothing written").
 */

/** The FR-6 copy a caller sees when it could not take the lock in time. */
export const WORK_COMMIT_LOCK_TIMEOUT_MESSAGE = 'Another commit to this Work is in progress.';

/** The plan's budget for taking the lock (`plan.md` §2.2 failure table). */
export const WORK_COMMIT_LOCK_WAIT_MS = 120_000;

/**
 * The tail of each Work's chain. A promise that resolves when the Work's current holder is done,
 * so the next caller can start; it never rejects (see below), which is what keeps one failing
 * commit from poisoning every later one.
 */
const commitQueues = new Map<string, Promise<void>>();

/** Resolves `true` when the previous holder finished in time, `false` when the budget elapsed. */
async function waitForSlot(previous: Promise<void>, waitMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            previous.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), waitMs);
                // Never keep the process alive for a lock nobody is waiting on any more.
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * Runs `fn` with the Work's commit slot held, waiting for the previous holder for at most
 * `waitMs` first.
 *
 * - Calls for the **same** `workId` run one after another, in call order.
 * - Calls for **different** `workId`s never wait for each other.
 * - A `fn` that throws still releases the slot, so the next caller proceeds (the error reaches
 *   the caller that caused it, and nobody else).
 * - Waiting past `waitMs` rejects with {@link WORK_COMMIT_LOCK_TIMEOUT_MESSAGE} **without calling
 *   `fn`** — the caller must be able to tell "I did not commit" from "my commit failed".
 */
export async function withWorkCommitLock<T>(
    workId: string,
    fn: () => Promise<T>,
    waitMs: number = WORK_COMMIT_LOCK_WAIT_MS,
): Promise<T> {
    const previous = commitQueues.get(workId) ?? Promise.resolve();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.then(() => held);
    commitQueues.set(workId, tail);

    const acquired = await waitForSlot(previous, waitMs);

    if (!acquired) {
        // This caller never runs its `fn`; release the slot so the callers queued behind it are
        // not blocked by a refusal they had nothing to do with.
        release();
        if (commitQueues.get(workId) === tail) {
            commitQueues.delete(workId);
        }
        throw new Error(WORK_COMMIT_LOCK_TIMEOUT_MESSAGE);
    }

    try {
        return await fn();
    } finally {
        release();
        // Only the last caller of the chain may drop the entry: an earlier one deleting it would
        // let a later caller start from a fresh chain and run concurrently with the current
        // holder.
        if (commitQueues.get(workId) === tail) {
            commitQueues.delete(workId);
        }
    }
}

/** Test-only introspection: how many Works currently hold (or are queued for) a commit slot. */
export function workCommitLockDepth(): number {
    return commitQueues.size;
}
