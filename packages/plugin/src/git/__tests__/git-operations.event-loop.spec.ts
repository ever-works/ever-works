import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A clone or pull must not freeze the process it runs in.
 *
 * isomorphic-git indexes a packfile it already holds in memory, and every `await` in that loop
 * resolves at once — a microtask, which never lets the event loop reach a timer or a socket. On a
 * large repository that froze the API for as long as the indexing took: health probes went
 * unanswered, and a workspace backup reading every Work's data repository stopped heartbeating in
 * the middle of its Works domain and was failed as `stalled`.
 *
 * isomorphic-git awaits `onProgress` once per percent of the pack (and once per file it checks
 * out), so the fix is an `onProgress` that hands the event loop back. These tests pin both halves:
 * the yield really lets a timer run during microtask-only work (with a control proving the same
 * loop starves it without the yield), and every clone, pull and fetch is given it.
 */

const cloneMock = vi.fn();
const pullMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('isomorphic-git', () => ({
	default: {
		clone: (...args: unknown[]) => cloneMock(...args),
		pull: (...args: unknown[]) => pullMock(...args),
		fetch: (...args: unknown[]) => fetchMock(...args),
		setConfig: vi.fn().mockResolvedValue(undefined),
		getConfig: vi.fn().mockResolvedValue('https://github.com/acme/data.git'),
		init: vi.fn().mockResolvedValue(undefined),
		addRemote: vi.fn().mockResolvedValue(undefined),
		currentBranch: vi.fn().mockResolvedValue('main'),
		listBranches: vi.fn().mockResolvedValue(['main']),
		resolveRef: vi.fn().mockResolvedValue('0'.repeat(40))
	}
}));

const { GitOperations, yieldToEventLoop } = await import('../git-operations.js');

/** Burn the CPU for `ms` without yielding at all — one slice of inflate + SHA-1 work. */
function busy(ms: number): void {
	const until = Date.now() + ms;
	let spin = 0;
	while (Date.now() < until) spin += 1;
	void spin;
}

/**
 * What isomorphic-git's `GitPackIndex.fromPack` does with a pack it holds in memory: a long run of
 * CPU work whose only `await` per percent is `onProgress`, and whose other `await`s are microtasks.
 */
async function indexPack(
	onProgress: (() => Promise<void>) | undefined,
	totalMs: number,
	slices = 100
): Promise<void> {
	for (let percent = 0; percent < slices; percent += 1) {
		if (onProgress) await onProgress();
		busy(totalMs / slices);
		// The per-object awaits inside one percent: already-resolved promises.
		for (let object = 0; object < 50; object += 1) await Promise.resolve();
	}
}

/** Count how often a 5 ms timer — a stand-in for a heartbeat or a health probe — gets to run. */
async function timerTicksDuring(work: () => Promise<void>): Promise<number> {
	let ticks = 0;
	const timer = setInterval(() => {
		ticks += 1;
	}, 5);
	try {
		await work();
	} finally {
		clearInterval(timer);
	}
	return ticks;
}

let baseDir: string;

function makeOps(): InstanceType<typeof GitOperations> {
	return new GitOperations(
		() => ({ username: 'x-access-token', password: 'token' }),
		(owner, repo) => `https://github.com/${owner}/${repo}.git`,
		{ baseDir }
	);
}

beforeEach(() => {
	baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-event-loop-'));
	cloneMock.mockReset().mockResolvedValue(undefined);
	pullMock.mockReset().mockResolvedValue(undefined);
	fetchMock.mockReset().mockResolvedValue({ fetchHead: '1'.repeat(40) });
});

describe('yieldToEventLoop — the onProgress every network git operation is given', () => {
	it('CONTROL: microtask-only indexing starves a timer for its whole duration', async () => {
		// Without this control the next test could pass for a reason that has nothing to do
		// with the yield — this is the freeze the API pod and the backup heartbeat suffered.
		const ticks = await timerTicksDuring(() => indexPack(undefined, 400));
		expect(ticks).toBe(0);
	});

	it('lets a timer run throughout the same indexing when it is awaited as onProgress', async () => {
		const ticks = await timerTicksDuring(() => indexPack(yieldToEventLoop, 400));
		// 400 ms of work in 50 ms slices: the timer gets in between every slice.
		expect(ticks).toBeGreaterThanOrEqual(4);
	});

	it('returns at once while the current slice is still short, so per-file calls stay cheap', async () => {
		await yieldToEventLoop();
		let immediateRan = false;
		setImmediate(() => {
			immediateRan = true;
		});
		// Called again straight away: well inside the slice, so it must not wait for the
		// check phase — a pull calls it once per file it checks out.
		await yieldToEventLoop();
		expect(immediateRan).toBe(false);
	});
});

describe('GitOperations — every clone, pull and fetch hands the event loop back', () => {
	it('clones with it, and the clone no longer freezes the process', async () => {
		cloneMock.mockImplementation(async (args: { onProgress?: () => Promise<void> }) =>
			indexPack(args.onProgress, 300)
		);
		const ops = makeOps();

		const ticks = await timerTicksDuring(async () => {
			await ops.cloneOrPull({ owner: 'acme', repo: 'data', token: 'token', autoSwitchToMainBranch: false });
		});

		expect(cloneMock).toHaveBeenCalledWith(expect.objectContaining({ onProgress: yieldToEventLoop }));
		expect(ticks).toBeGreaterThanOrEqual(3);
	});

	it('pulls an existing checkout with it', async () => {
		const ops = makeOps();
		const dir = ops.getLocalDir('acme', 'data');
		fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

		await ops.cloneOrPull({ owner: 'acme', repo: 'data', token: 'token', autoSwitchToMainBranch: false });

		expect(cloneMock).not.toHaveBeenCalled();
		expect(pullMock).toHaveBeenCalledWith(expect.objectContaining({ onProgress: yieldToEventLoop }));
	});

	it('clones an isolated branch with it', async () => {
		const ops = makeOps();

		await ops.cloneBranch({ owner: 'acme', repo: 'data', branch: 'feature', token: 'token' });

		expect(cloneMock).toHaveBeenCalledWith(expect.objectContaining({ onProgress: yieldToEventLoop }));
	});

	it('fetches with it, both the plain fetch and a named branch', async () => {
		const ops = makeOps();
		const dir = ops.getLocalDir('acme', 'data');
		fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

		await ops.fetch(dir, 'token');
		await ops.fetchBranch({ dir, owner: 'acme', repo: 'upstream', branch: 'main', token: 'token' });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [args] of fetchMock.mock.calls) {
			expect(args).toEqual(expect.objectContaining({ onProgress: yieldToEventLoop }));
		}
	});
});
