import { describe, expect, it } from 'vitest';

import {
	classifyFleetChangedPaths,
	composeFleetTaskCommitMessage,
	containsCiSkipDirective,
	fleetCommitTypeFromTitle,
	neutralizeCiSkipDirectives,
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

// works-security finding 1 (node 0.2.7): a Task title is the fleet commit
// subject, and GitHub starts no `push` / `pull_request` workflow for a head
// commit whose message carries a skip directive — the merge gate would then
// read the third-party checks (or none) as the PR's whole CI.
describe('CI-skip directives never reach a fleet commit', () => {
	const GITHUB_DIRECTIVES = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'];

	it.each(GITHUB_DIRECTIVES)('neutralises %s in the title, any case and spacing', (directive) => {
		// Each directive has exactly one space, one `[` (first) and one `]`
		// (last); anchored patterns say so, and replace every occurrence there is.
		const spaced = directive.replace(/ /g, '   ').replace(/^\[/, '[ ').replace(/\]$/, ' ]').toUpperCase();
		for (const variant of [directive, spaced]) {
			const message = composeFleetTaskCommitMessage({ title: `Fix login redirect ${variant}`, slug: 'T-1' });
			expect(containsCiSkipDirective(message)).toBe(false);
			expect(message).not.toMatch(/\[[^\]]*(?:skip|no\s*ci)[^\]]*\]/i);
			// The words survive; only the syntax is broken.
			expect(message.split('\n')[0]).toContain('(');
		}
	});

	it('neutralises a directive in a conventional title and in the slug', () => {
		const message = composeFleetTaskCommitMessage({
			title: 'docs(api): [skip ci] lease protocol',
			slug: 'T-2 [ci skip]'
		});
		expect(message).toBe('docs(api): (skip ci) lease protocol\n\nTask: T-2 (ci skip)');
		expect(containsCiSkipDirective(message)).toBe(false);
	});

	it("neutralises the other CIs' forms and the skip-checks trailer", () => {
		expect(
			neutralizeCiSkipDirectives('a [skip travis] b [skip azurepipelines] c [skipci] d [ci-skip] e [NO_CI]')
		).toBe('a (skip travis) b (skip azurepipelines) c (skipci) d (ci-skip) e (NO_CI)');
		expect(neutralizeCiSkipDirectives('x ***NO_CI*** y')).toBe('x NO_CI y');
		expect(neutralizeCiSkipDirectives('feat: x\n\n\nskip-checks: true')).toBe('feat: x\n\n\nskip-checks true');
		expect(neutralizeCiSkipDirectives('feat: x\n\nSkip-Checks:TRUE')).toBe('feat: x\n\nskip-checks TRUE');
	});

	it('leaves ordinary brackets alone and is idempotent', () => {
		const plain = 'fix: handle [object Object] in [WIP] list [1/2]\n\nTask: T-3';
		expect(neutralizeCiSkipDirectives(plain)).toBe(plain);
		expect(containsCiSkipDirective(plain)).toBe(false);
		const input = 'feat: x [skip ci] [ci skip]';
		const once = neutralizeCiSkipDirectives(input);
		expect(neutralizeCiSkipDirectives(once)).toBe(once);
		expect(once.length).toBe(input.length);
	});

	it('is applied by retypeFleetCommitMessage — the last step before the node commits', () => {
		const message = 'feat: add the runbook [skip ci]\n\nTask: T-13\n\nEver-Works-Agent: [no ci] (a1)';
		// Re-typed …
		expect(retypeFleetCommitMessage(message, ['docs/runbook.md'])).toBe(
			'docs: add the runbook (skip ci)\n\nTask: T-13\n\nEver-Works-Agent: (no ci) (a1)'
		);
		// … or not: the neutralisation happens either way.
		expect(retypeFleetCommitMessage(message, ['src/a.ts', 'docs/a.md'])).toBe(
			'feat: add the runbook (skip ci)\n\nTask: T-13\n\nEver-Works-Agent: (no ci) (a1)'
		);
		expect(retypeFleetCommitMessage('Update stuff [actions skip]', [])).toBe('Update stuff (actions skip)');
	});

	it('scans hostile input in linear time', () => {
		const hostile = `${'['.repeat(20_000)}${' skip'.repeat(5_000)}${']'.repeat(20_000)}`;
		const started = Date.now();
		neutralizeCiSkipDirectives(hostile);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
