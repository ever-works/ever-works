/**
 * EW-642 D7 follow-up — pgvector re-embed hook unit tests.
 *
 * Covers `PgVectorPlugin.handleEmbeddingSettingsChange`: the public
 * method the host calls when `embeddingModel` or `embeddingDimensions`
 * flips in the plugin's settings. The plugin walks every affected
 * Work via the injected `PgVectorAffectedWorksPort`, fans a
 * `kb-reembed-work` Trigger.dev dispatch out per Work via the injected
 * `PgVectorReembedDispatcher`, and surfaces partial-sweep failures by
 * propagating the underlying error.
 *
 * Receiver-side idempotency lives on the slice-2
 * `KnowledgeBaseReembedService` + `kb-reembed-work` Trigger.dev task,
 * which watermark every chunk-coordinate row by `embedding_model` so
 * re-dispatching a Work that already completed is a no-op.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	PgVectorPlugin,
	type PgVectorReembedDispatcher,
	type PgVectorAffectedWorksPort,
	type PgVectorReembedHook
} from '../pgvector.plugin.js';

function createDispatcher(): PgVectorReembedDispatcher {
	return {
		dispatchKbReembedWork: vi.fn(async (payload) => `run-${payload.workId}-${payload.newModel}`)
	};
}

function createAffectedWorks(workIds: ReadonlyArray<string>): PgVectorAffectedWorksPort {
	return {
		listAffectedWorkIds: vi.fn(async () => workIds)
	};
}

describe('PgVectorPlugin.handleEmbeddingSettingsChange (D7 reembed hook)', () => {
	let plugin: PgVectorPlugin;

	beforeEach(() => {
		plugin = new PgVectorPlugin();
	});

	it('is a no-op when neither embeddingModel nor embeddingDimensions change', async () => {
		const dispatcher = createDispatcher();
		const affectedWorks = createAffectedWorks(['w-1', 'w-2']);
		plugin.setReembedHook({ dispatcher, affectedWorks });

		const result = await plugin.handleEmbeddingSettingsChange({
			previousModel: 'text-embedding-3-small',
			previousDims: 1536,
			newModel: 'text-embedding-3-small',
			newDims: 1536
		});

		expect(result).toEqual([]);
		expect(dispatcher.dispatchKbReembedWork).not.toHaveBeenCalled();
		// Doesn't even need to ask the port — early-return short-circuits
		// before any I/O happens. Avoids a stray DB query on every save.
		expect(affectedWorks.listAffectedWorkIds).not.toHaveBeenCalled();
	});

	it('fans a dispatch out per affected Work when embeddingModel changes', async () => {
		const dispatcher = createDispatcher();
		const affectedWorks = createAffectedWorks(['w-1', 'w-2', 'w-3']);
		plugin.setReembedHook({ dispatcher, affectedWorks });

		const result = await plugin.handleEmbeddingSettingsChange({
			previousModel: 'text-embedding-3-small',
			previousDims: 1536,
			newModel: 'text-embedding-3-large',
			newDims: 1536
		});

		expect(result).toEqual([
			{ workId: 'w-1', runId: 'run-w-1-text-embedding-3-large' },
			{ workId: 'w-2', runId: 'run-w-2-text-embedding-3-large' },
			{ workId: 'w-3', runId: 'run-w-3-text-embedding-3-large' }
		]);
		expect(dispatcher.dispatchKbReembedWork).toHaveBeenCalledTimes(3);
		expect(dispatcher.dispatchKbReembedWork).toHaveBeenNthCalledWith(1, {
			workId: 'w-1',
			previousModel: 'text-embedding-3-small',
			newModel: 'text-embedding-3-large',
			newDims: 1536
		});
	});

	it('fans a dispatch out per affected Work when embeddingDimensions changes', async () => {
		const dispatcher = createDispatcher();
		const affectedWorks = createAffectedWorks(['w-only']);
		plugin.setReembedHook({ dispatcher, affectedWorks });

		const result = await plugin.handleEmbeddingSettingsChange({
			previousModel: 'text-embedding-3-small',
			previousDims: 1536,
			newModel: 'text-embedding-3-small',
			newDims: 3072
		});

		expect(result).toEqual([{ workId: 'w-only', runId: 'run-w-only-text-embedding-3-small' }]);
		expect(dispatcher.dispatchKbReembedWork).toHaveBeenCalledTimes(1);
		expect(dispatcher.dispatchKbReembedWork).toHaveBeenCalledWith({
			workId: 'w-only',
			previousModel: 'text-embedding-3-small',
			newModel: 'text-embedding-3-small',
			newDims: 3072
		});
	});

	it('returns an empty list when there are no affected Works (settings change is a no-op against an unused plugin)', async () => {
		const dispatcher = createDispatcher();
		const affectedWorks = createAffectedWorks([]);
		plugin.setReembedHook({ dispatcher, affectedWorks });

		const result = await plugin.handleEmbeddingSettingsChange({
			previousModel: 'text-embedding-3-small',
			previousDims: 1536,
			newModel: 'text-embedding-3-large',
			newDims: 1536
		});

		expect(result).toEqual([]);
		expect(dispatcher.dispatchKbReembedWork).not.toHaveBeenCalled();
		expect(affectedWorks.listAffectedWorkIds).toHaveBeenCalledTimes(1);
	});

	it('throws when the hook has not been wired in — silent drops would leave Works on stale models', async () => {
		await expect(
			plugin.handleEmbeddingSettingsChange({
				previousModel: 'text-embedding-3-small',
				previousDims: 1536,
				newModel: 'text-embedding-3-large',
				newDims: 1536
			})
		).rejects.toThrow(/re-embed hook not wired in/i);
	});

	it('propagates a partial-sweep failure with context — names the failed Work and the count of already-dispatched runs', async () => {
		const dispatcher: PgVectorReembedDispatcher = {
			dispatchKbReembedWork: vi.fn(async (payload) => {
				if (payload.workId === 'w-2') {
					throw new Error('trigger.dev queue full');
				}
				return `run-${payload.workId}`;
			})
		};
		const affectedWorks = createAffectedWorks(['w-1', 'w-2', 'w-3']);
		plugin.setReembedHook({ dispatcher, affectedWorks });

		await expect(
			plugin.handleEmbeddingSettingsChange({
				previousModel: 'text-embedding-3-small',
				previousDims: 1536,
				newModel: 'text-embedding-3-large',
				newDims: 1536
			})
		).rejects.toThrow(/dispatch failed for work=w-2 after 1 prior successful dispatch.*trigger.dev queue full/);

		// w-3 is never attempted — the throw stops the loop. That's fine
		// because the receiver task is idempotent on `embedding_model`,
		// so the host can safely retry the entire settings-change handler
		// (already-dispatched runs no-op inside the task).
		expect(dispatcher.dispatchKbReembedWork).toHaveBeenCalledTimes(2);
	});

	it('accepts the hook via the constructor option (parity with setReembedHook)', async () => {
		const dispatcher = createDispatcher();
		const affectedWorks = createAffectedWorks(['w-1']);
		const hook: PgVectorReembedHook = { dispatcher, affectedWorks };
		const constructed = new PgVectorPlugin({ reembedHook: hook });

		const result = await constructed.handleEmbeddingSettingsChange({
			previousModel: 'text-embedding-3-small',
			previousDims: 1536,
			newModel: 'text-embedding-3-large',
			newDims: 1536
		});

		expect(result).toHaveLength(1);
		expect(dispatcher.dispatchKbReembedWork).toHaveBeenCalledTimes(1);
	});

	it('setReembedHook(undefined) unbinds the hook and subsequent change calls throw', async () => {
		plugin.setReembedHook({
			dispatcher: createDispatcher(),
			affectedWorks: createAffectedWorks(['w-1'])
		});
		plugin.setReembedHook(undefined);

		await expect(
			plugin.handleEmbeddingSettingsChange({
				previousModel: 'text-embedding-3-small',
				previousDims: 1536,
				newModel: 'text-embedding-3-large',
				newDims: 1536
			})
		).rejects.toThrow(/re-embed hook not wired in/i);
	});
});
