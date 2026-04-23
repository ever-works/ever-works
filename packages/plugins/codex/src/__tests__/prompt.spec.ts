import { describe, expect, it } from 'vitest';

import {
	buildSystemPrompt,
	buildSystemPromptVariables,
	buildUserPrompt,
	buildUserPromptVariables
} from '../prompt/system-prompt.js';

describe('codex prompts', () => {
	const baseOptions = {
		directory: {
			id: 'dir1',
			name: 'AI Tools',
			slug: 'ai-tools',
			description: 'A curated directory of AI tools'
		},
		request: {
			prompt: 'Generate tools for AI engineering teams',
			name: 'AI Engineering Tools',
			config: { target_items: 25 }
		},
		existing: {
			items: [
				{
					name: 'Cursor',
					description: 'Editor',
					source_url: 'https://cursor.com',
					category: 'Editors',
					tags: ['editor']
				}
			],
			categories: [],
			tags: []
		},
		workspacePath: '/tmp/codex-generator/user1/dir1'
	};

	it('builds system prompt variables with workspace and target context', () => {
		const vars = buildSystemPromptVariables(baseOptions);

		expect(vars.workspacePath).toBe('/tmp/codex-generator/user1/dir1');
		expect(vars.targetItems).toBe('25');
		expect(vars.directorySection).toContain('Directory name: AI Tools');
		expect(vars.directorySection).toContain('Requested topic: Generate tools for AI engineering teams');
		expect(vars.existingItemsSection).toContain('already contains 1 existing items');
	});

	it('builds a system prompt with schema and workspace rules', () => {
		const prompt = buildSystemPrompt(baseOptions);

		expect(prompt).toContain('Workspace path:');
		expect(prompt).toContain('/tmp/codex-generator/user1/dir1');
		expect(prompt).toContain('Item JSON Schema');
		expect(prompt).toContain('"source_url": "string (required)');
		expect(prompt).toContain('Aim to generate approximately **25** new items');
		expect(prompt).toContain('The task is complete only when valid item `.json` files exist');
	});

	it('builds user prompt variables and prompt text', () => {
		const vars = buildUserPromptVariables(baseOptions);
		const prompt = buildUserPrompt(baseOptions);

		expect(vars.userInstruction).toBe('Generate tools for AI engineering teams');
		expect(vars.directoryDescription).toBe('Directory description: A curated directory of AI tools');
		expect(vars.targetItems).toBe('25');
		expect(prompt).toContain('Generate tools for AI engineering teams');
		expect(prompt).toContain('Target: generate approximately 25 new items.');
		expect(prompt).toContain('Do not finish with zero output files.');
	});
});
