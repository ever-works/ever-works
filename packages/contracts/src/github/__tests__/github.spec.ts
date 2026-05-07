import { describe, it, expect } from 'vitest';
import { parseGitHubRepositoryUrl, type ParsedGitHubRepository } from '../index.js';

describe('parseGitHubRepositoryUrl', () => {
	it('parses a canonical https://github.com/<owner>/<repo> URL', () => {
		const r = parseGitHubRepositoryUrl('https://github.com/ever-works/ever-works');
		expect(r).toEqual({
			owner: 'ever-works',
			repo: 'ever-works',
			canonicalUrl: 'https://github.com/ever-works/ever-works'
		} satisfies ParsedGitHubRepository);
	});

	it('lower-cases the owner and repo', () => {
		const r = parseGitHubRepositoryUrl('https://github.com/Ever-Works/Ever-Works');
		expect(r?.owner).toBe('ever-works');
		expect(r?.repo).toBe('ever-works');
		expect(r?.canonicalUrl).toBe('https://github.com/ever-works/ever-works');
	});

	it('strips a trailing .git suffix from the repo segment', () => {
		const r = parseGitHubRepositoryUrl('https://github.com/ever-works/ever-works.git');
		expect(r?.repo).toBe('ever-works');
		expect(r?.canonicalUrl).toBe('https://github.com/ever-works/ever-works');
	});

	it('ignores extra path segments past <owner>/<repo>', () => {
		const r = parseGitHubRepositoryUrl(
			'https://github.com/ever-works/ever-works/tree/main/packages/contracts'
		);
		expect(r?.owner).toBe('ever-works');
		expect(r?.repo).toBe('ever-works');
	});

	it('accepts http:// in addition to https://', () => {
		const r = parseGitHubRepositoryUrl('http://github.com/foo/bar');
		expect(r?.owner).toBe('foo');
		expect(r?.repo).toBe('bar');
	});

	it('accepts mixed-case hostname', () => {
		const r = parseGitHubRepositoryUrl('https://GitHub.com/foo/bar');
		expect(r?.owner).toBe('foo');
		expect(r?.repo).toBe('bar');
	});

	it('returns null for non-github hostnames', () => {
		expect(parseGitHubRepositoryUrl('https://gitlab.com/foo/bar')).toBeNull();
		expect(parseGitHubRepositoryUrl('https://example.com/foo/bar')).toBeNull();
	});

	it('returns null for ssh / git protocols (only http/https supported)', () => {
		expect(parseGitHubRepositoryUrl('git@github.com:foo/bar.git')).toBeNull();
		expect(parseGitHubRepositoryUrl('ssh://git@github.com/foo/bar')).toBeNull();
		expect(parseGitHubRepositoryUrl('git://github.com/foo/bar')).toBeNull();
	});

	it('returns null when the URL has fewer than 2 path segments', () => {
		expect(parseGitHubRepositoryUrl('https://github.com')).toBeNull();
		expect(parseGitHubRepositoryUrl('https://github.com/')).toBeNull();
		expect(parseGitHubRepositoryUrl('https://github.com/owner-only')).toBeNull();
	});

	it('returns null for an unparseable URL', () => {
		expect(parseGitHubRepositoryUrl('not a url')).toBeNull();
		expect(parseGitHubRepositoryUrl('')).toBeNull();
	});
});
