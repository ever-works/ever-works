import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserPrompt } from '../prompt/system-prompt';
import { ITEM_SCHEMA_TEXT } from '../prompt/item-schema';
import type { DirectoryReference, GenerationRequest, ExistingItems } from '@ever-works/plugin';

describe('system-prompt', () => {
	const baseDirectory: DirectoryReference = {
		id: 'dir1',
		name: 'AI Tools',
		slug: 'ai-tools',
		description: 'A curated directory of AI tools and services'
	};

	const baseRequest: GenerationRequest = {
		prompt: 'Generate a list of the best AI coding assistants',
		name: 'AI Coding Assistants'
	};

	const emptyExisting: ExistingItems = {
		items: [],
		categories: [],
		tags: []
	};

	const defaultWorkspacePath = '/tmp/claude-code-generator/user1/dir1';

	describe('buildSystemPrompt', () => {
		it('should include the role description', () => {
			const prompt = buildSystemPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('directory content generator');
		});

		it('should include workspace structure explanation', () => {
			const prompt = buildSystemPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('_meta/');
			expect(prompt).toContain('categories.json');
			expect(prompt).toContain('tags.json');
			expect(prompt).toContain('brands.json');
		});

		it('should include the item schema', () => {
			const prompt = buildSystemPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('name');
			expect(prompt).toContain('description');
			expect(prompt).toContain('source_url');
			expect(prompt).toContain('category');
		});

		it('should include rules about real items and web search', () => {
			const prompt = buildSystemPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('REAL items');
			expect(prompt).toContain('web search');
			expect(prompt).toContain('valid, canonical URL');
		});

		it('should NOT include dedup instructions when no existing items', () => {
			const prompt = buildSystemPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).not.toContain('Existing Items');
			expect(prompt).not.toContain('duplicates');
		});

		it('should include dedup instructions when existing items present', () => {
			const existingWithItems: ExistingItems = {
				items: [
					{
						name: 'Cursor',
						description: 'AI-powered code editor',
						source_url: 'https://cursor.sh',
						category: 'Code Editors',
						tags: ['ai', 'editor']
					}
				],
				categories: [{ id: '1', name: 'Code Editors' }],
				tags: [{ id: '1', name: 'ai' }]
			};

			const prompt = buildSystemPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: existingWithItems,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('Existing Items (1 items)');
			expect(prompt).toContain('duplicates');
			expect(prompt).toContain('NEW items');
		});

		it('should include directory context when description exists', () => {
			const prompt = buildSystemPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('Directory Context');
			expect(prompt).toContain('AI Tools');
			expect(prompt).toContain('curated directory of AI tools');
		});

		it('should omit directory context when no description', () => {
			const dirNoDesc: DirectoryReference = {
				id: 'dir1',
				name: 'AI Tools',
				slug: 'ai-tools'
			};

			const prompt = buildSystemPrompt({
				directory: dirNoDesc,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).not.toContain('Directory Context');
		});
	});

	describe('buildUserPrompt', () => {
		it('should use the request prompt when available', () => {
			const prompt = buildUserPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('Generate a list of the best AI coding assistants');
		});

		it('should fall back to request name when no prompt', () => {
			const request: GenerationRequest = { name: 'AI Tools' };

			const prompt = buildUserPrompt({
				directory: baseDirectory,
				request,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('Generate directory items for: AI Tools');
		});

		it('should fall back to directory name when no prompt or name', () => {
			const prompt = buildUserPrompt({
				directory: baseDirectory,
				request: {},
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('Generate directory items for: AI Tools');
		});

		it('should mention existing items count when present', () => {
			const existingWithItems: ExistingItems = {
				items: [
					{
						name: 'Cursor',
						description: 'AI-powered code editor',
						source_url: 'https://cursor.sh',
						category: 'Code Editors',
						tags: []
					},
					{
						name: 'Copilot',
						description: 'GitHub AI coding assistant',
						source_url: 'https://github.com/features/copilot',
						category: 'Code Assistants',
						tags: []
					}
				],
				categories: [],
				tags: []
			};

			const prompt = buildUserPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: existingWithItems,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('2 existing items');
		});

		it('should include research instruction', () => {
			const prompt = buildUserPrompt({
				directory: baseDirectory,
				request: baseRequest,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('Research the topic');
			expect(prompt).toContain('web search');
			expect(prompt).toContain('_meta/');
		});

		it('should include directory description if not in prompt', () => {
			const request: GenerationRequest = {
				prompt: 'Find AI tools'
			};

			const prompt = buildUserPrompt({
				directory: baseDirectory,
				request,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			expect(prompt).toContain('Directory description:');
			expect(prompt).toContain('curated directory of AI tools');
		});

		it('should not duplicate description if already in prompt', () => {
			const request: GenerationRequest = {
				prompt: 'A curated directory of AI tools and services - find the best ones'
			};

			const prompt = buildUserPrompt({
				directory: baseDirectory,
				request,
				existing: emptyExisting,
				workspacePath: defaultWorkspacePath
			});

			// Should not add description separately since it's already in the prompt
			expect(prompt).not.toContain('Directory description:');
		});
	});
});
