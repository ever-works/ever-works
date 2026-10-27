import { describe, expect, it } from 'vitest';
import { hasCredentialedUrl } from './acceptance-checks';

/** The rule as it was written before (CodeQL js/polynomial-redos): kept here as the oracle. */
const FORMER_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/i;

const CORPUS = [
	'',
	'plain value',
	'https://example.com/path',
	'https://user:pass@example.com/',
	'https://user:@example.com/',
	'https://:pass@example.com/',
	'https://user@example.com/',
	'postgres://app:s3cr3t@db.internal:5432/app',
	'redis://:token@cache:6379',
	'git+ssh://git:key@host/repo.git',
	'1http://u:p@h',
	'+://u:p@h',
	'x://u:p@h',
	'see https://a:b@c and more',
	'https://a/b:c@d',
	'https://a b:c@d',
	'https://a:b c@d',
	'HTTPS://USER:PASS@HOST',
	'https://a:b:c@d',
	'https://a::@d',
	'mailto:user@example.com',
	'://u:p@h',
	'a://b://c:d@e',
	'ftp://anonymous:guest@ftp.example.org',
	'value with http://x:y@z inside and https://p:q@r too',
	'http://a:b/c@d',
	'http://a:b\t@d',
	'tcp://:@h',
	'ws://u:p@',
	'ws://u:p'
];

describe('hasCredentialedUrl', () => {
	it('answers exactly what the former regular expression answered', () => {
		for (const value of CORPUS) {
			expect(hasCredentialedUrl(value), JSON.stringify(value)).toBe(FORMER_PATTERN.test(value));
		}
	});

	it('agrees with the former rule on generated values', () => {
		const alphabet = ['a', 'Z', '1', '+', '.', '-', ':', '/', '@', ' ', 'x'];
		let seed = 42;
		const next = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed;
		};
		for (let n = 0; n < 5000; n += 1) {
			const length = next() % 24;
			let value = '';
			for (let i = 0; i < length; i += 1) {
				value += next() % 5 === 0 ? '://' : alphabet[next() % alphabet.length];
			}
			expect(hasCredentialedUrl(value), JSON.stringify(value)).toBe(FORMER_PATTERN.test(value));
		}
	});

	it('stays fast on the inputs that made the regular expression slow', () => {
		const adversarial = [
			'a'.repeat(200_000),
			`a${'a'.repeat(100_000)}://${':'.repeat(100_000)}`,
			'://'.repeat(70_000)
		];
		const started = Date.now();
		for (const value of adversarial) expect(hasCredentialedUrl(value)).toBe(false);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
