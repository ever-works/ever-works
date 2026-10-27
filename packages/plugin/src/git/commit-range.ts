/**
 * APW-02 T48 (FR-63, ACC-02-27) — count the commits of an `exclude..include` range.
 *
 * A private copy shares its upstream's history but not a fork network, so no
 * provider compare can say how far the two have drifted: the platform has to
 * count it in a working copy that holds both histories. This is that count,
 * written once as a pure function over a "read one commit" callback so it can be
 * proven against a hand-built graph without a repository on disk.
 *
 * ## The walk
 *
 * It is the classic two-colour walk `git rev-list exclude..include` performs:
 * both tips are queued, every commit reachable from `exclude` is painted
 * UNINTERESTING and every commit reachable only from `include` is counted. The
 * queue is ordered by committer time, newest first, so a commit is normally
 * reached from both sides before it is popped; the walk ends as soon as every
 * queued commit is uninteresting — i.e. at the merge base frontier, not at the
 * root of the history.
 *
 * Clock skew (a commit older than its parent) can make the walk count a commit
 * before it learns the commit is also reachable from `exclude`. That case is
 * repaired rather than tolerated: the commit is un-counted and re-queued so the
 * exclusion propagates down from it.
 *
 * ## The cap
 *
 * `max` bounds the count (APW-02's 10 000-commit ceiling): the walk stops the
 * moment it has counted `max` commits and answers `capped: true`. A range that
 * shares no history with `exclude` therefore costs at most `max` commit reads
 * on the counted side, never a walk of the whole repository.
 */

/** One commit as the walk needs it: its parents and its committer time (any monotonic unit). */
export interface CommitParents {
	readonly parents: readonly string[];
	readonly timestamp: number;
}

/** Reads one commit. A missing commit is the caller's error — it propagates. */
export type CommitParentsReader = (oid: string) => Promise<CommitParents>;

/** What {@link countCommitRange} counted. */
export interface CommitRangeCount {
	readonly count: number;
	readonly capped: boolean;
}

const INCLUDE = 1;
const EXCLUDE = 2;

interface Node {
	readonly oid: string;
	readonly timestamp: number;
	readonly parents: readonly string[];
	flags: number;
	queued: boolean;
	counted: boolean;
}

/**
 * Count the commits reachable from `include` and not from `exclude`, at most `max`.
 *
 * `include === exclude` is an empty range. `max` below 1 (or not finite) counts
 * nothing and reports `capped: true` only when there was something to count —
 * a cap of zero must never read as "no drift".
 */
export async function countCommitRange(
	read: CommitParentsReader,
	include: string,
	exclude: string,
	max: number
): Promise<CommitRangeCount> {
	const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
	if (!include || include === exclude) {
		return { count: 0, capped: false };
	}

	const nodes = new Map<string, Node>();
	// Newest first. A sorted array is plenty: the walk visits a few thousand
	// commits at most before the cap or the frontier stops it.
	const queue: Node[] = [];

	const enqueue = (node: Node): void => {
		if (node.queued) return;
		node.queued = true;
		let low = 0;
		let high = queue.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (queue[mid].timestamp >= node.timestamp) low = mid + 1;
			else high = mid;
		}
		queue.splice(low, 0, node);
	};

	const nodeOf = async (oid: string): Promise<Node> => {
		const existing = nodes.get(oid);
		if (existing) return existing;
		const commit = await read(oid);
		const node: Node = {
			oid,
			timestamp: Number.isFinite(commit?.timestamp) ? commit.timestamp : 0,
			parents: Array.isArray(commit?.parents) ? commit.parents.filter((p) => typeof p === 'string') : [],
			flags: 0,
			queued: false,
			counted: false
		};
		nodes.set(oid, node);
		return node;
	};

	const includeNode = await nodeOf(include);
	includeNode.flags |= INCLUDE;
	enqueue(includeNode);
	if (exclude) {
		const excludeNode = await nodeOf(exclude);
		excludeNode.flags |= EXCLUDE;
		enqueue(excludeNode);
	}

	let count = 0;
	// Commits reachable only from `include` that were reached once the count stood
	// at the cap: neither counted nor expanded, but kept, because an exclusion still
	// on its way can undo an earlier count (clock skew) and bring the total back
	// under the cap — and then these are the next commits to count.
	const held: Node[] = [];

	const uncount = (node: Node): void => {
		if (node.counted) {
			// Clock skew: counted before the exclusion reached it. Undo it.
			node.counted = false;
			count -= 1;
		}
	};
	const stillHeld = (): Node[] => held.filter((node) => (node.flags & EXCLUDE) === 0);

	const walk = async (): Promise<void> => {
		while (queue.length > 0) {
			const saturated = count >= limit;
			if (queue.every((node) => (node.flags & EXCLUDE) !== 0)) {
				// Only exclusions are left. Unsaturated, the range is complete. At the cap,
				// an exclusion can still repair a count only while it is not older than
				// every commit held back — the same frontier rule, applied to them.
				if (!saturated) return;
				const open = stillHeld();
				if (open.length === 0) return;
				const oldestHeld = Math.min(...open.map((node) => node.timestamp));
				if (queue[0].timestamp < oldestHeld) return;
			}

			const node = queue.shift() as Node;
			node.queued = false;

			if ((node.flags & EXCLUDE) !== 0) {
				uncount(node);
				for (const parentOid of node.parents) {
					const parent = await nodeOf(parentOid);
					if ((parent.flags & EXCLUDE) === 0) {
						parent.flags |= EXCLUDE;
						enqueue(parent);
					}
				}
				continue;
			}

			if (saturated) {
				// At the cap: hold it back, read nothing below it.
				held.push(node);
				continue;
			}

			if (!node.counted) {
				node.counted = true;
				count += 1;
			}
			for (const parentOid of node.parents) {
				const parent = await nodeOf(parentOid);
				if ((parent.flags & INCLUDE) === 0 && (parent.flags & EXCLUDE) === 0) {
					parent.flags |= INCLUDE;
					enqueue(parent);
				}
			}
		}
	};

	/**
	 * Exclusions still queued can reach commits counted under skew: propagate them
	 * through the commits already read (no new reads) so the answer is exact rather
	 * than an over-count. Answers the excluded commits whose parents were never read
	 * — the frontier a resumed walk must pick up again.
	 */
	const repairWithKnownCommits = (): Node[] => {
		const frontier: Node[] = [];
		while (queue.length > 0) {
			const node = queue.shift() as Node;
			node.queued = false;
			if ((node.flags & EXCLUDE) === 0) {
				held.push(node);
				continue;
			}
			uncount(node);
			let unread = false;
			for (const parentOid of node.parents) {
				const parent = nodes.get(parentOid);
				if (!parent) {
					unread = true;
					continue;
				}
				if ((parent.flags & EXCLUDE) === 0) {
					parent.flags |= EXCLUDE;
					enqueue(parent);
				}
			}
			if (unread) frontier.push(node);
		}
		return frontier;
	};

	for (;;) {
		await walk();
		const frontier = repairWithKnownCommits();
		const open = stillHeld();
		if (count < limit && open.length > 0) {
			// A repair brought the total back under the cap: the held commits are the
			// next to count, and the exclusion frontier walks on beside them.
			held.length = 0;
			for (const node of frontier) enqueue(node);
			for (const node of open) enqueue(node);
			continue;
		}
		if (count >= limit && (count > 0 || open.length > 0)) {
			return { count: limit, capped: true };
		}
		return { count: Math.max(0, count), capped: false };
	}
}
