import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { syncTaxonomyFromFile } from './taxonomy-sync.js';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

/**
 * Watch the workspace root for new/changed `.json` files and keep
 * `_meta/` taxonomy files in sync.
 *
 * Non-recursive: items are flat `.json` files in the workspace root.
 * Events are debounced per file (50 ms) to absorb duplicate `fs.watch` notifications.
 */
export function startTaxonomyWatcher(workspacePath: string, logger: Logger): { stop: () => void } {
	let watcher: FSWatcher | null = null;

	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const readFn = (p: string) => readFile(p, 'utf-8');
	const writeFn = (p: string, c: string) => writeFile(p, c, 'utf-8');

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
					handleFileChange(workspacePath, filename, readFn, writeFn, logger);
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
