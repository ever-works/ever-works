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
	const everyQueuedIsExcluded = (): boolean => queue.every((node) => (node.flags & EXCLUDE) !== 0);

	while (queue.length > 0 && !everyQueuedIsExcluded()) {
		const node = queue.shift() as Node;
		node.queued = false;

		if ((node.flags & EXCLUDE) !== 0) {
			if (node.counted) {
				// Clock skew: counted before the exclusion reached it. Undo it.
				node.counted = false;
				count -= 1;
			}
			for (const parentOid of node.parents) {
				const parent = await nodeOf(parentOid);
				if ((parent.flags & EXCLUDE) === 0) {
					parent.flags |= EXCLUDE;
					enqueue(parent);
				}
			}
			continue;
		}

		if (!node.counted) {
			node.counted = true;
			count += 1;
			if (count >= limit) {
				return { count: limit, capped: true };
			}
		}
		for (const parentOid of node.parents) {
			const parent = await nodeOf(parentOid);
			if ((parent.flags & INCLUDE) === 0 && (parent.flags & EXCLUDE) === 0) {
				parent.flags |= INCLUDE;
				enqueue(parent);
			}
		}
	}

	// Exclusions still queued can reach commits counted under skew; drain them so
	// the answer is exact rather than an over-count.
	while (queue.length > 0) {
		const node = queue.shift() as Node;
		node.queued = false;
		if ((node.flags & EXCLUDE) === 0) continue;
		if (node.counted) {
			node.counted = false;
			count -= 1;
		}
		for (const parentOid of node.parents) {
			const parent = nodes.get(parentOid);
			// Only commits the walk already knows can carry a count to undo; an
			// unread parent below the frontier was never counted.
			if (parent && (parent.flags & EXCLUDE) === 0) {
				parent.flags |= EXCLUDE;
				enqueue(parent);
			}
		}
	}

	return { count: Math.max(0, count), capped: false };
}
