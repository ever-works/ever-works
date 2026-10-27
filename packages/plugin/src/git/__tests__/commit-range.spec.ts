import { describe, expect, it } from 'vitest';
import { countCommitRange, type CommitParents } from '../commit-range.js';

/**
 * APW-02 T48 (FR-63, ACC-02-27) — `countCommitRange` is `git rev-list exclude..include --count`
 * over a "read one commit" callback, capped. Each graph below is drawn newest first; the
 * timestamps follow the drawing unless a test says otherwise.
 */

type Graph = Record<string, { parents: string[]; t: number }>;

function reader(graph: Graph): { read: (oid: string) => Promise<CommitParents>; reads: string[] } {
	const reads: string[] = [];
	return {
		reads,
		read: async (oid: string) => {
			reads.push(oid);
			const node = graph[oid];
			if (!node) throw Object.assign(new Error(`missing ${oid}`), { code: 'NotFoundError' });
			return { parents: node.parents, timestamp: node.t };
		}
	};
}

/** A linear chain c<n> → … → c1 (c1 is the root). */
function chain(prefix: string, n: number, base?: { oid: string; t: number }): Graph {
	const graph: Graph = {};
	const start = base ? base.t : 0;
	for (let i = 1; i <= n; i++) {
		const parent = i === 1 ? (base ? [base.oid] : []) : [`${prefix}${i - 1}`];
		graph[`${prefix}${i}`] = { parents: parent, t: start + i };
	}
	return graph;
}

describe('countCommitRange', () => {
	it('counts an empty range as zero', async () => {
		const { read } = reader(chain('c', 3));
		await expect(countCommitRange(read, 'c3', 'c3', 100)).resolves.toEqual({ count: 0, capped: false });
	});

	it('counts the commits ahead of a linear ancestor — and nothing behind it', async () => {
		const { read } = reader(chain('c', 10));
		await expect(countCommitRange(read, 'c10', 'c4', 100)).resolves.toEqual({ count: 6, capped: false });
		await expect(countCommitRange(read, 'c4', 'c10', 100)).resolves.toEqual({ count: 0, capped: false });
	});

	it('measures both directions of a divergence from the merge base', async () => {
		// base: b1..b3; upstream adds u1..u5 on b3; the copy adds m1..m2 on b3.
		const graph: Graph = {
			...chain('b', 3),
			...chain('u', 5, { oid: 'b3', t: 3 }),
			...chain('m', 2, { oid: 'b3', t: 3 })
		};
		const { read } = reader(graph);
		// behind = copy..upstream, ahead = upstream..copy
		await expect(countCommitRange(read, 'u5', 'm2', 10_000)).resolves.toEqual({ count: 5, capped: false });
		await expect(countCommitRange(read, 'm2', 'u5', 10_000)).resolves.toEqual({ count: 2, capped: false });
	});

	it('stops at the merge-base frontier instead of walking the whole history', async () => {
		const graph: Graph = { ...chain('b', 500), ...chain('u', 3, { oid: 'b500', t: 500 }) };
		graph.m1 = { parents: ['b500'], t: 501 };
		const { read, reads } = reader(graph);
		await expect(countCommitRange(read, 'u3', 'm1', 10_000)).resolves.toEqual({ count: 3, capped: false });
		expect(reads.length).toBeLessThan(20);
	});

	it('does not count a merged side branch that forked before the merge base', async () => {
		// Upstream merged a long-lived branch s1..s2 (forked from b1) after the copy was made at b3.
		const graph: Graph = {
			...chain('b', 3),
			s1: { parents: ['b1'], t: 1.5 },
			s2: { parents: ['s1'], t: 4 },
			merge: { parents: ['b3', 's2'], t: 5 },
			m1: { parents: ['b3'], t: 6 }
		};
		const { read } = reader(graph);
		// upstream has merge, s2, s1 that the copy lacks; b1 is shared.
		await expect(countCommitRange(read, 'merge', 'm1', 100)).resolves.toEqual({ count: 3, capped: false });
	});

	it('repairs a count taken under clock skew', async () => {
		// x2 claims to be older than the copy tip although the copy tip descends from it.
		const graph: Graph = {
			x1: { parents: [], t: 1 },
			x2: { parents: ['x1'], t: 2 },
			copy: { parents: ['x2'], t: 1 },
			up: { parents: ['x2'], t: 10 }
		};
		const { read } = reader(graph);
		await expect(countCommitRange(read, 'up', 'copy', 100)).resolves.toEqual({ count: 1, capped: false });
	});

	it('does not report a cap reached only by a count that clock skew later undoes', async () => {
		// up(10) -> x2(2) -> x1(1), and copy(1) -> x2: the range up..copy is just `up`.
		// With a cap of 2 the walk counts `up` and then x2 before the exclusion from `copy`
		// reaches x2 — reaching the cap must not end the walk before that exclusion lands.
		const graph: Graph = {
			x1: { parents: [], t: 1 },
			x2: { parents: ['x1'], t: 2 },
			copy: { parents: ['x2'], t: 1 },
			up: { parents: ['x2'], t: 10 }
		};
		const { read } = reader(graph);
		await expect(countCommitRange(read, 'up', 'copy', 2)).resolves.toEqual({ count: 1, capped: false });
		await expect(countCommitRange(read, 'up', 'copy', 1)).resolves.toEqual({ count: 1, capped: true });
	});

	it('counts on past a repaired cap when more commits are really in the range', async () => {
		// up(10) -> a(9) -> x2(2) -> x1(1), copy(1) -> x2: the range is {up, a}.
		const graph: Graph = {
			x1: { parents: [], t: 1 },
			x2: { parents: ['x1'], t: 2 },
			a: { parents: ['x2'], t: 9 },
			copy: { parents: ['x2'], t: 1 },
			up: { parents: ['a'], t: 10 }
		};
		const { read } = reader(graph);
		await expect(countCommitRange(read, 'up', 'copy', 3)).resolves.toEqual({ count: 2, capped: false });
		await expect(countCommitRange(read, 'up', 'copy', 2)).resolves.toEqual({ count: 2, capped: true });
	});

	it('caps the count and says so — never a smaller number', async () => {
		const { read, reads } = reader(chain('c', 50));
		await expect(countCommitRange(read, 'c50', 'zzz-unrelated', 10)).rejects.toThrow('missing zzz-unrelated');
		const graph: Graph = { ...chain('c', 50), other: { parents: [], t: 0 } };
		const second = reader(graph);
		await expect(countCommitRange(second.read, 'c50', 'other', 10)).resolves.toEqual({ count: 10, capped: true });
		expect(second.reads.length).toBeLessThanOrEqual(13);
		expect(reads.length).toBeGreaterThan(0);
	});

	it('counts an unrelated history up to the cap only', async () => {
		const graph: Graph = { ...chain('a', 30), ...chain('z', 30) };
		const { read } = reader(graph);
		await expect(countCommitRange(read, 'a30', 'z30', 10_000)).resolves.toEqual({ count: 30, capped: false });
		await expect(countCommitRange(read, 'a30', 'z30', 30)).resolves.toEqual({ count: 30, capped: true });
	});

	it('treats a cap below one as capped when there is anything to count', async () => {
		const { read } = reader(chain('c', 3));
		await expect(countCommitRange(read, 'c3', 'c1', 0)).resolves.toEqual({ count: 0, capped: true });
	});
});
