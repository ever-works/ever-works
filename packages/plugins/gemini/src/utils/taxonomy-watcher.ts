import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { syncTaxonomyFromFile } from './taxonomy-sync.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

export interface TaxonomyWatcherOptions {
	workspacePath: string;
	logger: Logger;
	/** Called when a new (non-seeded) item file is detected */
	onNewItem?: (newItemCount: number, filename: string) => void;
}

/**
 * Watch the workspace root for new/changed `.json` files and keep
 * `_meta/` taxonomy files in sync.
 *
 * Non-recursive: items are flat `.json` files in the workspace root.
 * Events are debounced per file (50 ms) to absorb duplicate `fs.watch` notifications.
 */
export function startTaxonomyWatcher(options: TaxonomyWatcherOptions): { stop: () => void } {
	const { workspacePath, logger, onNewItem } = options;

	let watcher: FSWatcher | null = null;

	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let syncQueue = Promise.resolve();

	const readFn = (p: string) => readFile(p, 'utf-8');
	const writeFn = (p: string, c: string) => writeFile(p, c, 'utf-8');

	// Load seeded filenames so we can distinguish new items from pre-existing ones
	let seededFiles = new Set<string>();
	try {
		const raw = readFileSync(join(workspacePath, '_meta', 'seeded.json'), 'utf-8');
		seededFiles = new Set(Object.keys(JSON.parse(raw)));
	} catch {
		// No seeded manifest — treat all files as new
	}

	const countedNewFiles = new Set<string>();

	try {
		watcher = watch(workspacePath, (eventType, filename) => {
			if (!filename || !filename.endsWith('.json')) return;
			if (filename.startsWith('_meta')) return;

			// Debounce per file
			const existing = debounceTimers.get(filename);
			if (existing) clearTimeout(existing);

			debounceTimers.set(
				filename,
				setTimeout(() => {
					debounceTimers.delete(filename);

					// Notify about new (non-seeded) items before async taxonomy sync
					if (onNewItem && !seededFiles.has(filename) && !countedNewFiles.has(filename)) {
						countedNewFiles.add(filename);
						onNewItem(countedNewFiles.size, filename);
					}

					syncQueue = syncQueue
						.catch(() => undefined)
						.then(() => handleFileChange(workspacePath, filename, readFn, writeFn, logger));
				}, 50)
			);
		});

		watcher.on('error', (err) => {
			logger.warn(`Taxonomy watcher error: ${err.message}`);
		});
	} catch (err) {
		logger.warn(`Failed to start taxonomy watcher: ${err instanceof Error ? err.message : String(err)}`);
	}

	return {
		stop() {
			for (const timer of debounceTimers.values()) {
				clearTimeout(timer);
			}
			debounceTimers.clear();
			watcher?.close();
			watcher = null;
		}
	};
}

async function handleFileChange(
	workspacePath: string,
	filename: string,
	readFn: (p: string) => Promise<string>,
	writeFn: (p: string, c: string) => Promise<void>,
	logger: Logger
): Promise<void> {
	const filePath = join(workspacePath, filename);
	try {
		const content = await readFn(filePath);
		await syncTaxonomyFromFile(readFn, writeFn, filePath, content);
	} catch {
		// File may have been deleted or is being written; silently skip
	}
}
