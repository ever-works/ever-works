import { describe, it, expect } from 'vitest';
import { validateFormInput } from '../form-schema.js';

describe('validateFormInput', () => {
	it('is valid when repository access is disabled', () => {
		expect(validateFormInput({ pass_repo_access: false })).toEqual({ valid: true });
	});

	it('requires a repo_url when repository access is enabled', () => {
		const result = validateFormInput({ pass_repo_access: true });
		expect(result.valid).toBe(false);
		expect(result.errors?.[0]?.path).toBe('repo_url');
		expect(result.errors?.[0]?.message).toMatch(/required/i);
	});

	it('accepts a valid https://github.com repo URL (with token)', () => {
		const result = validateFormInput({
			pass_repo_access: true,
			repo_url: 'https://github.com/org/repo',
			repo_access_token: 'ghp_xxx'
		});
		expect(result).toEqual({ valid: true });
	});

	// SSRF guard: these all pass the non-empty check but must be rejected as repo_url.
	it.each([
		['internal host', 'http://internal-secrets-service/'],
		['non-https github', 'http://github.com/org/repo'],
		['file scheme', 'file:///etc/passwd'],
		['github.com subdomain lookalike', 'https://github.com.evil.com/org/repo'],
		['credential-host lookalike', 'https://github.com@evil.com/org/repo'],
		['arbitrary external host', 'https://evil.com/org/repo'],
		['not a URL at all', 'not-a-url']
	])('rejects %s as repo_url (%s)', (_label, repoUrl) => {
		const result = validateFormInput({
			pass_repo_access: true,
			repo_url: repoUrl,
			repo_access_token: 'ghp_xxx'
		});
		expect(result.valid).toBe(false);
		expect(result.errors?.[0]?.path).toBe('repo_url');
		expect(result.errors?.[0]?.message).toMatch(/https:\/\/github\.com/i);
	});

	it('still requires repo_access_token after a valid repo_url', () => {
		const result = validateFormInput({
			pass_repo_access: true,
			repo_url: 'https://github.com/org/repo'
		});
		expect(result.valid).toBe(false);
		expect(result.errors?.[0]?.path).toBe('repo_access_token');
	});
});
