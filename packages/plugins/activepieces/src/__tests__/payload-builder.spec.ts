import { describe, it, expect } from 'vitest';
import { buildFlowPayload } from '../utils/payload-builder.js';
import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';

function createWork(overrides?: Partial<WorkReference>): WorkReference {
	return {
		id: 'dir-1',
		name: 'My Work',
		slug: 'my-work',
		description: 'A work of tools',
		user: { id: 'user-1' },
		...overrides
	};
}

function createRequest(overrides?: Partial<GenerationRequest>): GenerationRequest {
	return {
		prompt: 'Generate items',
		generationMethod: 'create-update',
		config: {},
		...overrides
	};
}

function createExisting(overrides?: Partial<ExistingItems>): ExistingItems {
	return {
		items: [],
		categories: [],
		tags: [],
		...overrides
	};
}

describe('buildFlowPayload', () => {
	it('should produce minimal payload with only metadata', () => {
		const payload = buildFlowPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: {}
		});

		expect(payload.metadata).toMatchObject({
			workId: 'dir-1',
			workName: 'My Work',
			workSlug: 'my-work',
			workDescription: 'A work of tools',
			prompt: 'Generate items',
			generationMethod: 'create-update'
		});
		expect(payload.metadata.targetItems).toBeGreaterThan(0);
		expect(payload.existingSummary).toBeUndefined();
		expect(payload.dataSource).toBeUndefined();
	});

	it('should respect target_items override', () => {
		const payload = buildFlowPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: { target_items: 25 }
		});
		expect(payload.metadata.targetItems).toBe(25);
	});

	it('should include existing summary when items exist and pass flag is true', () => {
		const payload = buildFlowPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting({
				items: [{ name: 'Existing 1', source_url: 'https://a.com' }] as never,
				categories: [{ name: 'Cat A' }] as never,
				tags: [{ name: 'Tag A' }] as never
			}),
			config: { pass_existing_items: true }
		});

		expect(payload.existingSummary).toBeDefined();
		expect(payload.existingSummary!.totalItems).toBe(1);
		expect(payload.existingSummary!.categories).toEqual(['Cat A']);
		expect(payload.existingSummary!.tags).toEqual(['Tag A']);
		expect(payload.existingSummary!.sampleItems[0]).toMatchObject({ name: 'Existing 1' });
	});

	it('should omit existing summary when pass_existing_items is false', () => {
		const payload = buildFlowPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting({
				items: [{ name: 'Existing 1' }] as never
			}),
			config: { pass_existing_items: false }
		});
		expect(payload.existingSummary).toBeUndefined();
	});

	it('should include github-repo data source when configured', () => {
		const payload = buildFlowPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: {
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo',
				repo_access_token: 'ghp_xxx',
				repo_branch: 'main'
			}
		});

		expect(payload.dataSource).toEqual({
			type: 'github-repo',
			repoUrl: 'https://github.com/org/repo',
			accessToken: 'ghp_xxx',
			branch: 'main',
			path: 'items/'
		});
	});

	it('should pass through flowParams', () => {
		const payload = buildFlowPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: { flow_params: { topic: 'ai', region: 'us' } }
		});

		expect(payload.flowParams).toEqual({ topic: 'ai', region: 'us' });
	});
});
