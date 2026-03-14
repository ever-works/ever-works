import { describe, it, expect } from 'vitest';
import { buildWorkflowPayload } from '../utils/payload-builder.js';
import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';

function createOptions(overrides?: {
	directory?: Partial<DirectoryReference>;
	request?: Partial<GenerationRequest>;
	existing?: Partial<ExistingItems>;
	config?: Record<string, unknown>;
}) {
	return {
		directory: {
			id: 'dir-1',
			name: 'My Directory',
			slug: 'my-directory',
			description: 'A test directory',
			user: { id: 'user-1' },
			...overrides?.directory
		} as DirectoryReference,
		request: {
			prompt: 'Find AI tools',
			generationMethod: 'create-update',
			...overrides?.request
		} as GenerationRequest,
		existing: {
			items: [],
			categories: [],
			tags: [],
			...overrides?.existing
		} as ExistingItems,
		config: {
			target_items: 50,
			...overrides?.config
		}
	};
}

describe('buildWorkflowPayload', () => {
	it('should build metadata from directory and request', () => {
		const payload = buildWorkflowPayload(createOptions());

		expect(payload.metadata).toEqual({
			directoryId: 'dir-1',
			directoryName: 'My Directory',
			directorySlug: 'my-directory',
			directoryDescription: 'A test directory',
			prompt: 'Find AI tools',
			generationMethod: 'create-update',
			targetItems: 50
		});
	});

	it('should include existing items summary when enabled', () => {
		const payload = buildWorkflowPayload(
			createOptions({
				existing: {
					items: [
						{ name: 'Item 1', source_url: 'https://example.com/1' },
						{ name: 'Item 2', source_url: 'https://example.com/2' }
					] as never[],
					categories: [{ name: 'Cat1' }] as never[],
					tags: [{ name: 'Tag1' }] as never[]
				},
				config: { target_items: 50, pass_existing_items: true }
			})
		);

		expect(payload.existingSummary).toBeDefined();
		expect(payload.existingSummary!.totalItems).toBe(2);
		expect(payload.existingSummary!.categories).toEqual(['Cat1']);
		expect(payload.existingSummary!.tags).toEqual(['Tag1']);
		expect(payload.existingSummary!.sampleItems).toHaveLength(2);
	});

	it('should not include existing items summary when disabled', () => {
		const payload = buildWorkflowPayload(
			createOptions({
				existing: {
					items: [{ name: 'Item 1' }] as never[],
					categories: [],
					tags: []
				},
				config: { target_items: 50, pass_existing_items: false }
			})
		);

		expect(payload.existingSummary).toBeUndefined();
	});

	it('should not include existing items summary when no items exist', () => {
		const payload = buildWorkflowPayload(createOptions());
		expect(payload.existingSummary).toBeUndefined();
	});

	it('should include GitHub repo reference when configured', () => {
		const payload = buildWorkflowPayload(
			createOptions({
				config: {
					target_items: 50,
					pass_repo_access: true,
					repo_url: 'https://github.com/org/repo',
					repo_access_token: 'ghp_test123',
					repo_branch: 'main'
				}
			})
		);

		expect(payload.dataSource).toEqual({
			type: 'github-repo',
			repoUrl: 'https://github.com/org/repo',
			accessToken: 'ghp_test123',
			branch: 'main',
			path: 'items/'
		});
	});

	it('should not include dataSource when repo access is disabled', () => {
		const payload = buildWorkflowPayload(createOptions());
		expect(payload.dataSource).toBeUndefined();
	});

	it('should use default branch when not specified', () => {
		const payload = buildWorkflowPayload(
			createOptions({
				config: {
					target_items: 50,
					pass_repo_access: true,
					repo_url: 'https://github.com/org/repo',
					repo_access_token: 'token'
				}
			})
		);

		expect(payload.dataSource?.branch).toBe('data');
	});

	it('should include custom workflow params', () => {
		const payload = buildWorkflowPayload(
			createOptions({
				config: {
					target_items: 50,
					workflow_params: { sources: ['producthunt', 'g2'], lang: 'en' }
				}
			})
		);

		expect(payload.workflowParams).toEqual({ sources: ['producthunt', 'g2'], lang: 'en' });
	});

	it('should limit sample items to 20', () => {
		const items = Array.from({ length: 30 }, (_, i) => ({
			name: `Item ${i + 1}`,
			source_url: `https://example.com/${i + 1}`
		})) as never[];

		const payload = buildWorkflowPayload(
			createOptions({ existing: { items, categories: [], tags: [] } })
		);

		expect(payload.existingSummary!.sampleItems).toHaveLength(20);
		expect(payload.existingSummary!.totalItems).toBe(30);
	});

	it('should default target items to 50', () => {
		const payload = buildWorkflowPayload(createOptions({ config: {} }));
		expect(payload.metadata.targetItems).toBe(50);
	});
});
