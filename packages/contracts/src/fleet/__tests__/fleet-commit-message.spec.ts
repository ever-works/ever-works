import { describe, expect, it } from 'vitest';

import {
	classifyFleetChangedPaths,
	composeFleetTaskCommitMessage,
	fleetCommitTypeFromTitle,
	retypeFleetCommitMessage
} from '../fleet-commit-message.types.js';

describe('composeFleetTaskCommitMessage', () => {
	it('derives a conventional subject from the Task title and keeps the slug in the body', () => {
		expect(composeFleetTaskCommitMessage({ title: 'Add dark mode toggle to settings', slug: 'T-13' })).toBe(
			'feat: add dark mode toggle to settings\n\nTask: T-13'
		);
		expect(composeFleetTaskCommitMessage({ title: 'Fix login redirect losing the return URL.', slug: 'T-2' })).toBe(
			'fix: login redirect losing the return URL\n\nTask: T-2'
		);
		expect(composeFleetTaskCommitMessage({ title: 'Checkout crashes on empty cart', slug: 'T-4' })).toBe(
			'fix: checkout crashes on empty cart\n\nTask: T-4'
		);
		expect(composeFleetTaskCommitMessage({ title: 'Refactor the billing service', slug: 'T-5' })).toBe(
			'refactor: the billing service\n\nTask: T-5'
		);
	});

	it('keeps a title that already is a conventional commit, scope included', () => {
		expect(composeFleetTaskCommitMessage({ title: 'docs(api): describe the lease protocol', slug: 'T-7' })).toBe(
			'docs(api): describe the lease protocol\n\nTask: T-7'
		);
	});

	it('keeps acronyms, cuts long subjects at a word, and never invents a summary', () => {
		expect(composeFleetTaskCommitMessage({ title: 'API keys page', slug: 'T-8' }).split('\n')[0]).toBe(
			'feat: API keys page'
		);
		const long = composeFleetTaskCommitMessage({
			title: 'Implement the brand new onboarding wizard with workspace, repository and agent creation steps',
			slug: 'T-9'
		}).split('\n')[0];
		expect(Array.from(long).length).toBeLessThanOrEqual(72);
		expect(long.endsWith('…')).toBe(true);
		expect(composeFleetTaskCommitMessage({ title: '', slug: 'T-10' })).toBe(
			'feat: agent run output for T-10\n\nTask: T-10'
		);
		expect(composeFleetTaskCommitMessage({ title: 'Line one\r\nline two', slug: null })).toBe(
			'feat: line one line two'
		);
	});
});

describe('fleetCommitTypeFromTitle', () => {
	it.each([
		['Write docs for the fleet runbook', 'docs'],
		['Add tests for the lease sweeper', 'test'],
		['Optimize the board query', 'perf'],
		['Bump pnpm to 10', 'chore'],
		['New pricing page', 'feat'],
		[null, 'feat']
	])('%s → %s', (title, type) => {
		expect(fleetCommitTypeFromTitle(title)).toBe(type);
	});
});

describe('classifyFleetChangedPaths', () => {
	it('tells docs-only and tests-only changes from mixed ones', () => {
		expect(classifyFleetChangedPaths(['README.md', 'docs/features/fleet.md', 'apps/web/CHANGELOG'])).toBe('docs');
		expect(
			classifyFleetChangedPaths([
				'apps/api/src/fleet/__tests__/a.spec.ts',
				'packages/x/src/b.test.tsx',
				'e2e/c.ts'
			])
		).toBe('test');
		expect(classifyFleetChangedPaths(['README.md', 'apps/api/src/main.ts'])).toBe('mixed');
		expect(classifyFleetChangedPaths([])).toBe('none');
	});
});

describe('retypeFleetCommitMessage', () => {
	const message = 'feat: add the lease runbook\n\nTask: T-13\n\nEver-Works-Node: everdesk4 (n1)';

	it('re-types a docs-only change and keeps everything after the type byte-for-byte', () => {
		expect(retypeFleetCommitMessage(message, ['docs/runbook.md'])).toBe(
			'docs: add the lease runbook\n\nTask: T-13\n\nEver-Works-Node: everdesk4 (n1)'
		);
		expect(retypeFleetCommitMessage('feat(task): T-2 agent run output', ['a/__tests__/x.spec.ts'])).toBe(
			'test(task): T-2 agent run output'
		);
	});

	it('leaves mixed changes, non-conventional messages and matching types alone', () => {
		expect(retypeFleetCommitMessage(message, ['docs/a.md', 'src/a.ts'])).toBe(message);
		expect(retypeFleetCommitMessage('Update stuff', ['docs/a.md'])).toBe('Update stuff');
		expect(retypeFleetCommitMessage('docs: x', ['docs/a.md'])).toBe('docs: x');
		expect(retypeFleetCommitMessage(message, [])).toBe(message);
	});
});
