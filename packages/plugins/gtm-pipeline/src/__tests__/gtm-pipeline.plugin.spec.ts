import { describe, expect, it, vi } from 'vitest';
import type { PluginContext, WorkReference } from '@ever-works/plugin';
import { GtmPipelinePlugin } from '../gtm-pipeline.plugin.js';
import { GtmPipelineContext, type GtmContextSnapshot } from '../context.js';
import { GTM_STAGE_IDS } from '../types.js';

const WORK: WorkReference = { id: 'work-1', name: 'Campaign', slug: 'campaign' };

function loadedPlugin(): Promise<GtmPipelinePlugin> {
	const plugin = new GtmPipelinePlugin();
	const context = {
		logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
	} as unknown as PluginContext;
	return plugin.onLoad(context).then(() => plugin);
}

describe('GtmPipelinePlugin — stage sequencing', () => {
	it('declares the 8 go-to-market stages in the canonical order', () => {
		const plugin = new GtmPipelinePlugin();
		const ids = plugin.getStepDefinitions().map((stage) => stage.id);
		expect(ids).toEqual([...GTM_STAGE_IDS]);
		expect(ids).toEqual(['research', 'qualify', 'draft', 'review', 'act', 'follow-up', 'enrich', 'measure']);
	});

	it('every stage requires only keys provided by earlier stages (auditable handoffs)', () => {
		const plugin = new GtmPipelinePlugin();
		const provided = new Set<string>();
		for (const stage of plugin.getStepDefinitions()) {
			for (const key of stage.requires ?? []) {
				expect(provided.has(key), `stage "${stage.id}" requires "${key}" before it is provided`).toBe(true);
			}
			for (const key of stage.provides ?? []) {
				provided.add(key);
			}
		}
	});

	it('every stage dependency references a stage declared earlier', () => {
		const plugin = new GtmPipelinePlugin();
		const seen = new Set<string>();
		for (const stage of plugin.getStepDefinitions()) {
			for (const dep of stage.dependencies ?? []) {
				expect(seen.has(dep.stepId), `stage "${stage.id}" depends on later/unknown "${dep.stepId}"`).toBe(true);
			}
			seen.add(stage.id);
		}
	});

	it('declares the review human gate between draft and act', () => {
		const plugin = new GtmPipelinePlugin();
		const ids = plugin.getStepDefinitions().map((stage) => stage.id);
		expect(ids.indexOf('review')).toBeGreaterThan(ids.indexOf('draft'));
		expect(ids.indexOf('review')).toBeLessThan(ids.indexOf('act'));
		const review = plugin.getStepDefinition('review');
		expect(review?.requires).toEqual(['drafts']);
		expect(review?.provides).toEqual(['approved_drafts']);
	});
});

describe('GtmPipelinePlugin — step IO contracts', () => {
	it('validates known and unknown stage ids', () => {
		const plugin = new GtmPipelinePlugin();
		for (const id of GTM_STAGE_IDS) {
			expect(plugin.isValidStepId(id)).toBe(true);
		}
		expect(plugin.isValidStepId('publish')).toBe(false);
		expect(plugin.isValidStepId('')).toBe(false);
	});

	it('registers an executor for every declared stage on load', async () => {
		const plugin = await loadedPlugin();
		const health = await plugin.healthCheck();
		expect(health.status).toBe('healthy');
		expect(health.message).toContain('8');
	});

	it('executeStep throws for an unregistered stage', async () => {
		const plugin = new GtmPipelinePlugin(); // not loaded — no executors
		const ctx = new GtmPipelineContext(WORK, {});
		await expect(plugin.executeStep('research', ctx, {} as never)).rejects.toThrow(
			'No executor registered for stage "research"'
		);
	});

	it('direct execute() is refused — the engine orchestrates stages', async () => {
		const plugin = new GtmPipelinePlugin();
		await expect(plugin.execute(WORK, {}, { items: [], categories: [], tags: [] })).rejects.toThrow(
			/should not be called directly/
		);
	});

	it('canSkipStep is provides-driven', () => {
		const plugin = new GtmPipelinePlugin();
		const ctx = new GtmPipelineContext(WORK, {});
		expect(plugin.canSkipStep('qualify', ctx)).toBe(false);
		ctx.scoredContacts = [{ name: 'Ada', score: 80, scoreReasons: [], riskScore: 0, riskReasons: [] }];
		expect(plugin.canSkipStep('qualify', ctx)).toBe(true);
	});
});

describe('GtmPipelinePlugin — context lifecycle', () => {
	it('snapshot round-trips the full stage data set', () => {
		const plugin = new GtmPipelinePlugin();
		const ctx = plugin.createContext(
			WORK,
			{ prompt: 'launch' },
			{ items: [], categories: [], tags: [] }
		) as GtmPipelineContext;
		ctx.contacts = [{ name: 'Ada', email: 'ada@example.com' }];
		ctx.drafts = [{ ref: 'draft-1', contactName: 'Ada', channel: 'email', subject: 'Hi', body: 'Hello' }];
		ctx.pendingReview = true;
		ctx.shouldStop = true;
		ctx.warnings.push('Review: awaiting human approval');

		const snapshot = plugin.contextToSnapshot(ctx) as GtmContextSnapshot;
		const restored = plugin.contextFromSnapshot(snapshot) as GtmPipelineContext;
		expect(restored.contacts).toEqual(ctx.contacts);
		expect(restored.drafts).toEqual(ctx.drafts);
		expect(restored.pendingReview).toBe(true);
		expect(restored.shouldStop).toBe(true);
		expect(restored.warnings).toContain('Review: awaiting human approval');
	});

	it('checkpoints paused at the review gate stay viable; empty stopped runs do not', () => {
		const plugin = new GtmPipelinePlugin();
		const pending = new GtmPipelineContext(WORK, {});
		pending.pendingReview = true;
		pending.shouldStop = true;
		expect(plugin.isCheckpointViable(pending.toSnapshot(), ['research', 'qualify', 'draft', 'review'])).toBe(true);

		const stopped = new GtmPipelineContext(WORK, {});
		stopped.shouldStop = true;
		expect(plugin.isCheckpointViable(stopped.toSnapshot(), ['research'])).toBe(false);

		const emptyAfterData = new GtmPipelineContext(WORK, {});
		expect(plugin.isCheckpointViable(emptyAfterData.toSnapshot(), ['research'])).toBe(false);
		expect(plugin.isCheckpointViable(new GtmPipelineContext(WORK, {}).toSnapshot(), [])).toBe(true);
	});

	it('extractResult carries stage outputs under extra keyed by declared stage keys', () => {
		const plugin = new GtmPipelinePlugin();
		const ctx = new GtmPipelineContext(WORK, {});
		ctx.actionLog = [{ draftRef: 'draft-1', channel: 'email', status: 'prepared', reason: null, preparedAt: 1 }];
		ctx.pendingReview = false;
		const result = plugin.extractResult(ctx, { duration: 10, stepsCompleted: 8, totalSteps: 8 });
		expect(result.success).toBe(true);
		expect(result.outputs.items).toEqual([]);
		const extra = result.outputs.extra as Record<string, unknown>;
		expect(extra.action_log).toEqual(ctx.actionLog);
		expect(extra.pending_review).toBe(false);
	});
});
