import { describe, it, expect } from 'vitest';
import {
	K8sPluginError,
	buildSecretPattern,
	scrubError,
	scrubString,
} from '../errors';

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
});

describe('scrubError', () => {
	it('preserves K8sPluginError code and message (after scrubbing)', () => {
		const err = new K8sPluginError('UNAUTHORIZED', 'token: leaked-thing');
		const out = scrubError(err);
		expect(out.code).toBe('UNAUTHORIZED');
		expect(out.message).not.toContain('leaked-thing');
	});

	it('infers CLUSTER_UNREACHABLE from common network errors', () => {
		expect(scrubError(new Error('ENOTFOUND kind.example.com')).code).toBe(
			'CLUSTER_UNREACHABLE',
		);
		expect(scrubError(new Error('connect ECONNREFUSED 127.0.0.1:6443')).code).toBe(
			'CLUSTER_UNREACHABLE',
		);
		expect(scrubError(new Error('x509: certificate has expired')).code).toBe(
			'CLUSTER_UNREACHABLE',
		);
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
