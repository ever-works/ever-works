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

/**
 * CodeQL js/polynomial-redos. The kubeconfig and PEM patterns were lazy `[\s\S]+?` scans, so on a
 * text with many openers and no closer every opener rescanned to the end of the text: quadratic.
 * `scrubString` runs over error messages that carry what the tenant's own cluster answered and
 * what its kubeconfig held, so the shapes below are input a tenant can send. They are now
 * scanned by hand, in linear time, with results identical to the regexes (checked against them
 * as an oracle below).
 */
describe('scrubString on hostile input', () => {
	it.each([
		['many kubeconfig openers with no `kind: Config`', 'apiVersion:v1'.repeat(50_000)],
		[
			'one kubeconfig blob followed by many `kind: Config`',
			`apiVersion:v1akind:Config${'akind:Config'.repeat(50_000)}`
		],
		['many PEM headers with no END line', '-----BEGIN ,-----'.repeat(50_000)]
	])('scrubs %s in linear time', (_label, hostile) => {
		const started = performance.now();
		scrubString(hostile);
		const elapsedMs = performance.now() - started;

		expect(elapsedMs).toBeLessThan(200);
	});

	/** The four patterns `scrubString` applied before the scanners — the oracle for the rewrite. */
	const REFERENCE_PATTERNS: readonly RegExp[] = [
		/apiVersion:\s*v1[\s\S]+?kind:\s*Config[\s\S]+?(?=$|\n\S)/g,
		/-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g,
		/Authorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
		/(\b(?:token|password|client-certificate-data|client-key-data|certificate-authority-data)\b\s*[:=]\s*)[^\s,;}"']+/gi
	];

	function referenceScrub(input: string): string {
		let out = input;
		for (const pattern of REFERENCE_PATTERNS) {
			out = out.replace(pattern, (_match: string, ...groups: unknown[]) => {
				const prefix = typeof groups[0] === 'string' ? groups[0] : '';
				return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
			});
		}
		return out;
	}

	it('redacts exactly what the regexes redacted, on real-shaped messages', () => {
		const messages = [
			'error context: apiVersion: v1\nkind: Config\nusers:\n  - name: a\n    user:\n      token: SECRET\nclusters: []',
			'before\napiVersion: v1\nkind: Config\ncontexts: []\nafter: tail',
			'apiVersion: v1\nkind: Config',
			'apiVersion: v1 kind: Config\n\n  indented\nnext line',
			'apiVersion:v1 no config here, kind: Pod',
			'... -----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE----- ...',
			'-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END -----\nBBB\n-----END RSA PRIVATE KEY----- tail',
			'-----BEGIN CERTIFICATE-----\nnever closed',
			'two: -----BEGIN A-----x-----END A----- and -----BEGIN B-----y-----END B-----',
			'failed: Authorization: Bearer ya29.fake-bearer-token',
			'detail: token: very-secret-12345, password=hunter2'
		];
		for (const message of messages) {
			expect(scrubString(message), JSON.stringify(message)).toBe(referenceScrub(message));
		}
	});

	it('redacts exactly what the regexes redacted, on generated messages', () => {
		const fragments = [
			'apiVersion:',
			'apiVersion: v1\n',
			' ',
			'\t',
			'\u00a0',
			'v1',
			'kind:',
			'kind: Config\n',
			'Config',
			'\n',
			'\n ',
			'x',
			'-',
			'-----',
			'-----BEGIN ',
			'-----END ',
			'-----BEGIN X-----',
			'-----END X-----',
			'CERT',
			'token: t0k',
			'Authorization: Bearer abc'
		];
		// A fixed-seed LCG: the same corpus on every run, so a failure is reproducible.
		let seed = 0x2501;
		const next = (bound: number): number => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return (seed >>> 8) % bound;
		};
		// Compare first, assert once: 20,000 `expect()` calls (each building a JSON message) cost far more
		// than the scrubbing itself, and on a CPU-throttled CI runner that overhead alone ran past the 10 s
		// test timeout (develop CI 2026-10-09). Same corpus, same coverage; a failure still names every
		// offending message (the first 20, with the total).
		const mismatches: { message: string; actual: string; expected: string }[] = [];
		let mismatchCount = 0;
		for (let run = 0; run < 20_000; run += 1) {
			let message = '';
			const length = 1 + next(14);
			for (let index = 0; index < length; index += 1) message += fragments[next(fragments.length)];
			const actual = scrubString(message);
			const expected = referenceScrub(message);
			if (actual !== expected) {
				mismatchCount += 1;
				if (mismatches.length < 20) mismatches.push({ message, actual, expected });
			}
		}
		expect({ mismatchCount, mismatches }).toEqual({ mismatchCount: 0, mismatches: [] });
	});
});
