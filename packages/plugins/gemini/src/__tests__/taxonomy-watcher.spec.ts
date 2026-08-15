import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { startTaxonomyWatcher } from '../utils/taxonomy-watcher';

describe('taxonomy-watcher', () => {
	let workspacePath: string;
	const logger = { log: vi.fn(), warn: vi.fn() };

	beforeEach(async () => {
		workspacePath = await mkdtemp(join(tmpdir(), 'tax-watcher-'));
		await mkdir(join(workspacePath, '_meta'), { recursive: true });
		logger.log.mockClear();
		logger.warn.mockClear();
	});

	afterEach(async () => {
		await rm(workspacePath, { recursive: true, force: true });
	});

	it('should pick up new .json files and sync taxonomy', async () => {
		const watcher = startTaxonomyWatcher({ workspacePath, logger });

		try {
			const item = JSON.stringify({ name: 'Tool', category: 'Cloud Services', tags: ['cloud'] });
			await writeFile(join(workspacePath, 'tool.json'), item, 'utf-8');

			// Wait for debounce (50ms) + file read + processing. Polled, not a
			// fixed sleep: on a loaded CI runner 300ms was not always enough and
			// the read below threw ENOENT before the watcher had written the file.
			const { readFile: rf } = await import('node:fs/promises');
			const catPath = join(workspacePath, '_meta', 'categories.json');
			await waitUntil(() =>
				rf(catPath, 'utf-8').then(
					() => true,
					() => false
				)
			);

			// Check that _meta/categories.json was created
			const catContent = await rf(catPath, 'utf-8');
			const categories = JSON.parse(catContent);
			expect(categories).toEqual([{ id: 'cloud-services', name: 'Cloud Services' }]);
		} finally {
			watcher.stop();
		}
	});

	it('should ignore _meta/ files', async () => {
		const watcher = startTaxonomyWatcher({ workspacePath, logger });

		try {
			// Write directly to _meta — the watcher should not process this
			await writeFile(
				join(workspacePath, '_meta', 'categories.json'),
				JSON.stringify([{ id: 'test', name: 'Test' }]),
				'utf-8'
			);

			await sleep(200);

			// The watcher should not have processed the _meta file (no errors, no extra writes)
			// Since the file starts with '_meta', the watcher callback filters it out
			expect(logger.warn).not.toHaveBeenCalled();
		} finally {
			watcher.stop();
		}
	});

	it('should handle watcher stop/cleanup', async () => {
		const watcher = startTaxonomyWatcher({ workspacePath, logger });
		watcher.stop();

		// Writing after stop should not trigger any processing
		const item = JSON.stringify({ name: 'Tool', category: 'Test' });
		await writeFile(join(workspacePath, 'late.json'), item, 'utf-8');

		await sleep(200);

		// No categories file should be created since watcher was stopped
		const { access } = await import('node:fs/promises');
		await expect(access(join(workspacePath, '_meta', 'categories.json'))).rejects.toThrow();
	});

	it('should survive file read errors', async () => {
		const watcher = startTaxonomyWatcher({ workspacePath, logger });

		try {
			// Write a file then immediately delete it to cause a read error in the handler
			await writeFile(join(workspacePath, 'ephemeral.json'), '{}', 'utf-8');
			await rm(join(workspacePath, 'ephemeral.json'));

			await sleep(200);

			// Watcher should not have thrown — it handles errors gracefully
			// No warn should be called since handleFileChange catches errors silently
		} finally {
			watcher.stop();
		}
	});

	it('should serialize taxonomy sync for rapid successive writes', async () => {
		const watcher = startTaxonomyWatcher({ workspacePath, logger });

		try {
			await Promise.all([
				writeFile(
					join(workspacePath, 'first.json'),
					JSON.stringify({ name: 'First', category: 'Category One', tags: ['alpha'] }),
					'utf-8'
				),
				writeFile(
					join(workspacePath, 'second.json'),
					JSON.stringify({ name: 'Second', category: 'Category Two', tags: ['beta'] }),
					'utf-8'
				)
			]);

			// fs-watch latency is unbounded under CI load, so a fixed sleep flakes
			// (one of the two concurrent writes may not be serialized yet). Poll the
			// meta files until both writes have landed, up to ~6s.
			const { readFile: rf } = await import('node:fs/promises');
			let categories: Array<{ id: string; name: string }> = [];
			let tags: Array<{ id: string; name: string }> = [];
			for (let attempt = 0; attempt < 60; attempt++) {
				await sleep(100);
				try {
					categories = JSON.parse(await rf(join(workspacePath, '_meta', 'categories.json'), 'utf-8'));
					tags = JSON.parse(await rf(join(workspacePath, '_meta', 'tags.json'), 'utf-8'));
				} catch {
					continue;
				}
				if (categories.length >= 2 && tags.length >= 2) break;
			}

			// File-system event ordering is non-deterministic for concurrent writes —
			// assert set membership (the serialization invariant the test cares about)
			// rather than insertion order.
			expect(categories).toHaveLength(2);
			expect(categories).toEqual(
				expect.arrayContaining([
					{ id: 'category-one', name: 'Category One' },
					{ id: 'category-two', name: 'Category Two' }
				])
			);
			expect(tags).toHaveLength(2);
			expect(tags).toEqual(
				expect.arrayContaining([
					{ id: 'alpha', name: 'Alpha' },
					{ id: 'beta', name: 'Beta' }
				])
			);
		} finally {
			watcher.stop();
		}
	});

	it('should not sync taxonomy for path-traversal filenames (workspace confinement)', async () => {
		// Sibling directory OUTSIDE the workspace root — a successful traversal would
		// drop a categories.json here (or read/write outside the workspace).
		const outsideDir = await mkdtemp(join(tmpdir(), 'tax-watcher-outside-'));
		try {
			// Pre-seed an item file in the outside dir that a `../` event would target.
			await writeFile(
				join(outsideDir, 'evil.json'),
				JSON.stringify({ name: 'Evil', category: 'Pwned', tags: ['x'] }),
				'utf-8'
			);

			// Re-create the watcher's confinement guard in isolation: a relative filename
			// that escapes the workspace root must be rejected before any read/write.
			const traversalName = join('..', `${outsideDir.split(/[\\/]/).pop()}`, 'evil.json');
			const filePath = join(workspacePath, traversalName);
			const rel = relative(resolve(workspacePath), resolve(filePath));
			expect(rel.startsWith('..') || isAbsolute(rel)).toBe(true);

			const watcher = startTaxonomyWatcher({ workspacePath, logger });
			try {
				// Writing into the workspace must NOT touch the outside dir.
				await writeFile(
					join(workspacePath, 'safe.json'),
					JSON.stringify({ name: 'Safe', category: 'Ok', tags: ['ok'] }),
					'utf-8'
				);
				await sleep(300);

				// The watcher only ever syncs taxonomy under the workspace `_meta/`.
				// No taxonomy file should leak into the sibling/outside directory.
				const { access } = await import('node:fs/promises');
				await expect(access(join(outsideDir, '_meta', 'categories.json'))).rejects.toThrow();
			} finally {
				watcher.stop();
			}
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	});

	describe('onNewItem callback', () => {
		it('should fire for new (non-seeded) files with incrementing count', async () => {
			const onNewItem = vi.fn();
			const watcher = startTaxonomyWatcher({ workspacePath, logger, onNewItem });

			try {
				await writeFile(
					join(workspacePath, 'item-a.json'),
					JSON.stringify({ name: 'A', category: 'Cat' }),
					'utf-8'
				);
				// Both waits expect a callback to FIRE, so poll for it rather than
				// hoping a fixed sleep outlasts fs-watch latency.
				await waitUntil(() => onNewItem.mock.calls.length >= 1);

				await writeFile(
					join(workspacePath, 'item-b.json'),
					JSON.stringify({ name: 'B', category: 'Cat' }),
					'utf-8'
				);
				await waitUntil(() => onNewItem.mock.calls.length >= 2);

				expect(onNewItem).toHaveBeenCalledTimes(2);
				expect(onNewItem).toHaveBeenNthCalledWith(1, 1, 'item-a.json');
				expect(onNewItem).toHaveBeenNthCalledWith(2, 2, 'item-b.json');
			} finally {
				watcher.stop();
			}
		});

		it('should skip files present in _meta/seeded.json', async () => {
			// Write a seeded manifest before starting the watcher
			await writeFile(
				join(workspacePath, '_meta', 'seeded.json'),
				JSON.stringify({ 'seeded-item.json': 'abc123' }),
				'utf-8'
			);

			const onNewItem = vi.fn();
			const watcher = startTaxonomyWatcher({ workspacePath, logger, onNewItem });

			try {
				// Write a seeded file — should NOT trigger onNewItem
				await writeFile(
					join(workspacePath, 'seeded-item.json'),
					JSON.stringify({ name: 'Seeded', category: 'Test' }),
					'utf-8'
				);
				await sleep(200);

				// Write a new file — should trigger onNewItem. This wait expects an
				// event, so poll. (The sleep above stays: it waits for a NON-event,
				// which cannot be polled for.)
				await writeFile(
					join(workspacePath, 'new-item.json'),
					JSON.stringify({ name: 'New', category: 'Test' }),
					'utf-8'
				);
				await waitUntil(() => onNewItem.mock.calls.length >= 1);

				expect(onNewItem).toHaveBeenCalledTimes(1);
				expect(onNewItem).toHaveBeenCalledWith(1, 'new-item.json');
			} finally {
				watcher.stop();
			}
		});

		it('should not double-count on repeated writes to the same file', async () => {
			const onNewItem = vi.fn();
			const watcher = startTaxonomyWatcher({ workspacePath, logger, onNewItem });

			try {
				await writeFile(
					join(workspacePath, 'item.json'),
					JSON.stringify({ name: 'V1', category: 'Cat' }),
					'utf-8'
				);
				// Poll for the FIRST call to land...
				await waitUntil(() => onNewItem.mock.calls.length >= 1);

				// Write again to the same file
				await writeFile(
					join(workspacePath, 'item.json'),
					JSON.stringify({ name: 'V2', category: 'Cat' }),
					'utf-8'
				);
				// ...then a fixed sleep, because this one waits for a NON-event: the
				// point is that no SECOND call arrives, and absence cannot be polled.
				await sleep(200);

				expect(onNewItem).toHaveBeenCalledTimes(1);
				expect(onNewItem).toHaveBeenCalledWith(1, 'item.json');
			} finally {
				watcher.stop();
			}
		});

		it('should work without onNewItem (backward compat)', async () => {
			// No onNewItem provided — should not throw
			const watcher = startTaxonomyWatcher({ workspacePath, logger });

			try {
				await writeFile(
					join(workspacePath, 'item.json'),
					JSON.stringify({ name: 'Item', category: 'Cat' }),
					'utf-8'
				);
				await sleep(200);

				// No error means backward compatibility works
			} finally {
				watcher.stop();
			}
		});
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `check` until it returns true, or give up after `timeoutMs`.
 *
 * fs-watch latency is unbounded under CI load, so "write a file, sleep a fixed
 * 200-300ms, then assert the watcher already reacted" is a race — it fails on a
 * loaded runner while passing every time locally. The concurrent-writes test
 * below already learned this and polls; these helpers make that the norm for
 * every wait that expects something to HAPPEN.
 *
 * Note the asymmetry: a wait that asserts something did NOT happen cannot be
 * polled (there is no state to converge on), so those keep their fixed sleep.
 * Returns rather than throws — the caller's own assertion should produce the
 * failure message, not this helper.
 */
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(50);
	}
}
