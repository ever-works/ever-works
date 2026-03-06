import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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

			// Wait for debounce (50ms) + file read + processing
			await sleep(300);

			// Check that _meta/categories.json was created
			const { readFile: rf } = await import('node:fs/promises');
			const catContent = await rf(join(workspacePath, '_meta', 'categories.json'), 'utf-8');
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
				await sleep(200);

				await writeFile(
					join(workspacePath, 'item-b.json'),
					JSON.stringify({ name: 'B', category: 'Cat' }),
					'utf-8'
				);
				await sleep(200);

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

				// Write a new file — should trigger onNewItem
				await writeFile(
					join(workspacePath, 'new-item.json'),
					JSON.stringify({ name: 'New', category: 'Test' }),
					'utf-8'
				);
				await sleep(200);

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
				await sleep(200);

				// Write again to the same file
				await writeFile(
					join(workspacePath, 'item.json'),
					JSON.stringify({ name: 'V2', category: 'Cat' }),
					'utf-8'
				);
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
