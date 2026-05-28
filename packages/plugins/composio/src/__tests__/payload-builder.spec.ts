import { describe, it, expect } from 'vitest';
import { buildToolPayload } from '../utils/payload-builder.js';
import type { WorkReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';

function createWork(overrides?: Partial<WorkReference>): WorkReference {
	return {
		id: 'dir-1',
		name: 'Best AI Tools',
		slug: 'best-ai-tools',
		description: 'Curated AI tools',
		user: { id: 'user-1' },
		...overrides
	};
}

function createRequest(overrides?: Partial<GenerationRequest>): GenerationRequest {
	return {
		prompt: 'Find AI tools',
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

describe('buildToolPayload', () => {
	it('produces the metadata envelope from work + request', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest({ config: { target_items: 10 } }),
			existing: createExisting(),
			config: { target_items: 10 }
		});

		expect(payload.metadata).toEqual({
			workId: 'dir-1',
			workName: 'Best AI Tools',
			workSlug: 'best-ai-tools',
			workDescription: 'Curated AI tools',
			prompt: 'Find AI tools',
			generationMethod: 'create-update',
			targetItems: 10
		});
	});

	it('defaults targetItems to DEFAULT_TARGET_ITEMS (50) when omitted', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: {}
		});

		expect(payload.metadata.targetItems).toBe(50);
	});

	it('includes existingSummary when there are existing items', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting({
				items: [{ name: 'ChatGPT', source_url: 'https://chat.openai.com' } as never],
				categories: [{ id: 'writing', name: 'Writing' } as never],
				tags: [{ id: 'free', name: 'free' } as never]
			}),
			config: { pass_existing_items: true }
		});

		expect(payload.existingSummary).toEqual({
			totalItems: 1,
			categories: ['Writing'],
			tags: ['free'],
			sampleItems: [{ name: 'ChatGPT', url: 'https://chat.openai.com' }]
		});
	});

	it('omits existingSummary when pass_existing_items=false', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting({ items: [{ name: 'X' } as never] }),
			config: { pass_existing_items: false }
		});

		expect(payload.existingSummary).toBeUndefined();
	});

	it('caps the sample items list at 20', () => {
		const items = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i}` })) as never[];
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting({ items }),
			config: {}
		});

		expect(payload.existingSummary!.sampleItems).toHaveLength(20);
		expect(payload.existingSummary!.totalItems).toBe(50);
	});

	it('includes dataSource when pass_repo_access + repo_url are set', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: {
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo',
				repo_access_token: 'ghp_x',
				repo_branch: 'main'
			}
		});

		expect(payload.dataSource).toEqual({
			type: 'github-repo',
			repoUrl: 'https://github.com/org/repo',
			accessToken: 'ghp_x',
			branch: 'main',
			path: 'items/'
		});
	});

	it('defaults dataSource branch to "data"', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: {
				pass_repo_access: true,
				repo_url: 'https://github.com/org/repo'
			}
		});

		expect(payload.dataSource!.branch).toBe('data');
	});

	it('spreads tool_params at the top level AND keeps them under toolParams', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: {
				tool_params: { to: 'alice@example.com', subject: 'Hi', body: 'Hello' }
			}
		});

		expect(payload.toolParams).toEqual({ to: 'alice@example.com', subject: 'Hi', body: 'Hello' });
		expect((payload as Record<string, unknown>).to).toBe('alice@example.com');
		expect((payload as Record<string, unknown>).subject).toBe('Hi');
		expect((payload as Record<string, unknown>).body).toBe('Hello');
	});

	it('allows tool_params to override envelope keys via spread order', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: { tool_params: { metadata: 'override' } }
		});

		expect((payload as Record<string, unknown>).metadata).toBe('override');
	});

	it('ignores non-object tool_params', () => {
		const payload = buildToolPayload({
			work: createWork(),
			request: createRequest(),
			existing: createExisting(),
			config: { tool_params: 'not-an-object' }
		});

		expect(payload.toolParams).toBeUndefined();
	});
});
