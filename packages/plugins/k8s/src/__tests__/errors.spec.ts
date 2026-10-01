import { describe, it, expect } from 'vitest';
import { K8sPluginError, buildSecretPattern, scrubError, scrubString } from '../errors';

describe('scrubString', () => {
	it('redacts an embedded kubeconfig blob', () => {
		const input = `error context: apiVersion: v1
kind: Config
users:
  - name: a
    user:
      token: SECRET
clusters: []`;
		const out = scrubString(input);
		expect(out).not.toContain('SECRET');
		expect(out).toContain('[REDACTED]');
	});

	it('redacts PEM blocks', () => {
		const input = '... -----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE----- ...';
		const out = scrubString(input);
		expect(out).not.toContain('ABCD');
		expect(out).toContain('[REDACTED]');
	});

	it('redacts Bearer tokens in Authorization headers', () => {
		const input = 'failed: Authorization: Bearer ya29.fake-bearer-token';
		const out = scrubString(input);
		expect(out).not.toContain('ya29.fake-bearer-token');
	});

	it('redacts token: / password: lines while keeping surrounding text', () => {
		const input = 'detail: token: very-secret-12345';
		const out = scrubString(input);
		expect(out).toContain('token:');
		expect(out).toContain('[REDACTED]');
		expect(out).not.toContain('very-secret-12345');
	});

	it('also accepts ad-hoc literal patterns for runtime secrets', () => {
		const literal = 'mYr3gistryPwD!';
		const pattern = buildSecretPattern(literal)!;
		const out = scrubString(`failed to push: 401 Unauthorized for ${literal}`, [pattern]);
		expect(out).not.toContain(literal);
	});

	/**
	 * A replacer's second argument is the first CAPTURE GROUP — unless the pattern
	 * has no group, in which case it is the match OFFSET. `buildSecretPattern`
	 * returns a group-less pattern (a runtime secret has no prefix worth keeping)
	 * and the `Authorization: Bearer …` pattern above is group-less too, so both
	 * spliced the offset into the output whenever the secret was not at index 0:
	 * `401 Unauthorized for 45[REDACTED]`.
	 *
	 * The existing assertions could not see it. `not.toContain(literal)` holds
	 * either way — the secret really is gone — so the corruption only shows when
	 * the redaction is asserted by EQUALITY, which is what these cases do.
	 */
	it('redacts a runtime secret mid-line without splicing the match offset in', () => {
		const literal = 'mYr3gistryPwD!';
		const pattern = buildSecretPattern(literal)!;

		expect(scrubString(`failed to push: 401 Unauthorized for ${literal}`, [pattern])).toBe(
			'failed to push: 401 Unauthorized for [REDACTED]'
		);
		// Why nobody noticed: at index 0 the offset is `0`, which is falsy, so the
		// bug was invisible in the common "the line IS the secret" case.
		expect(scrubString(`${literal} is wrong`, [pattern])).toBe('[REDACTED] is wrong');
	});

	it('redacts a Bearer token mid-line without splicing the match offset in', () => {
		expect(scrubString('failed: Authorization: Bearer ya29.fake-bearer-token')).toBe('failed: [REDACTED]');
	});

	it('keeps the prefix of a pattern that really does capture one', () => {
		expect(scrubString('detail: token: very-secret-12345')).toBe('detail: token: [REDACTED]');
	});

	it('leaves a string with no secret alone', () => {
		expect(scrubString('nothing to hide here', [buildSecretPattern('mYr3gistryPwD!')!])).toBe(
			'nothing to hide here'
		);
	});
});

describe('scrubError', () => {
	it('preserves K8sPluginError code and message (after scrubbing)', () => {
		const err = new K8sPluginError('UNAUTHORIZED', 'token: leaked-thing');
		const out = scrubError(err);
		expect(out.code).toBe('UNAUTHORIZED');
		expect(out.message).not.toContain('leaked-thing');
	});

	it('infers CLUSTER_UNREACHABLE from common network errors', () => {
		expect(scrubError(new Error('ENOTFOUND kind.example.com')).code).toBe('CLUSTER_UNREACHABLE');
		expect(scrubError(new Error('connect ECONNREFUSED 127.0.0.1:6443')).code).toBe('CLUSTER_UNREACHABLE');
		expect(scrubError(new Error('x509: certificate has expired')).code).toBe('CLUSTER_UNREACHABLE');
	});

	it('infers UNAUTHORIZED from 401/403/forbidden/unauthorized text', () => {
		expect(scrubError(new Error('HTTP 403 Forbidden')).code).toBe('UNAUTHORIZED');
		expect(scrubError(new Error('Unauthorized: bad token')).code).toBe('UNAUTHORIZED');
	});

	it('falls back to UNKNOWN when no pattern matches', () => {
		expect(scrubError(new Error('something weird happened')).code).toBe('UNKNOWN');
	});

	it('handles non-Error throwables', () => {
		expect(scrubError('boom').code).toBe('UNKNOWN');
		expect(scrubError(undefined).message).toBe('Unknown error');
	});
});

describe('buildSecretPattern', () => {
	it('returns null for short or empty secrets', () => {
		expect(buildSecretPattern(undefined)).toBeNull();
		expect(buildSecretPattern('')).toBeNull();
		expect(buildSecretPattern('abc')).toBeNull();
	});

	it('escapes regex metacharacters', () => {
		const p = buildSecretPattern('a.b*c?d')!;
		expect('a.b*c?d a-b-c-d a.b*c?d'.replace(p, 'X')).toBe('X a-b-c-d X');
	});
});
