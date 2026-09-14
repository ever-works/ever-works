import { describe, expect, it } from 'vitest';

import { containsSecret, redactSecrets, scanForSecrets } from '../secret-patterns.js';

/**
 * The scanner moved here from the agent package so the node app can run the
 * identical definition. These cases are the agent-package spec's own, ported
 * one-for-one, plus the patterns that spec never exercised — so a pattern or
 * a length floor lost in the move fails HERE, not in production.
 */
describe('secret-patterns — every pattern survives the move', () => {
	const cases: Array<[string, string, string]> = [
		['OpenAI-style sk- key', 'use sk-abc123xyz9876543 to call', 'generic'],
		['Bearer header', 'Authorization: Bearer abcdefghijklmno', 'generic'],
		['AWS access key id', 'AKIAABCDEFGHIJ123456', 'aws_access_key'],
		['GitHub PAT classic', `ghp_${'x'.repeat(36)}`, 'github_pat_classic'],
		['GitHub OAuth', `gho_${'x'.repeat(36)}`, 'github_oauth'],
		['GitHub App token', `ghs_${'x'.repeat(36)}`, 'github_app_token'],
		['GitHub fine-grained PAT', `github_pat_${'A'.repeat(30)}`, 'github_fine_grained_pat'],
		['GitLab PAT', 'glpat-abcdefghijklmnopqrst', 'gitlab_pat'],
		['Slack bot token', 'xoxb-1234567890-abcdef', 'slack_token'],
		['Generic PAT', 'pat_abcdefghijklmnopqrstuvwxyz0123456789', 'generic_pat'],
		['PEM private key', '-----BEGIN RSA PRIVATE KEY-----', 'pem_private_key'],
		['Google API key', `AIza${'b'.repeat(35)}`, 'google_api_key'],
		['Stripe secret key', `sk_live_${'c'.repeat(16)}`, 'stripe_secret_key'],
		['npm token', `npm_${'d'.repeat(36)}`, 'npm_token'],
		['HuggingFace token', `hf_${'e'.repeat(30)}`, 'huggingface_token'],
		['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'jwt'],
		['Twilio API key sid', `SK${'a'.repeat(32)}`, 'twilio_api_key']
	];

	it.each(cases)('detects %s', (_label, body, pattern) => {
		const hits = scanForSecrets(body);
		expect(hits.some((hit) => hit.pattern === pattern)).toBe(true);
	});

	it('keeps the length floors — a prefix alone is prose, not a secret', () => {
		expect(scanForSecrets('Please paste your token here.')).toEqual([]);
		expect(scanForSecrets('npm_config_cache and npm_lifecycle_event')).toEqual([]);
		expect(scanForSecrets('see the key-takeaways doc')).toEqual([]);
		expect(scanForSecrets(`ghp_${'x'.repeat(35)}`)).toEqual([]);
	});

	it('returns the matched index and a display-truncated sample', () => {
		const hits = scanForSecrets('prefix sk-aaaaaaaaaaaaaa suffix');
		expect(hits[0].index).toBe(7);
		expect(scanForSecrets(`ghp_${'x'.repeat(50)}`)[0].matched).toMatch(/…/);
	});

	it('containsSecret is the boolean view of the scan', () => {
		expect(containsSecret('AKIAABCDEFGHIJ123456')).toBe(true);
		expect(containsSecret('## My Agent\nNo secrets here.')).toBe(false);
		expect(containsSecret('')).toBe(false);
	});
});

describe('redactSecrets', () => {
	it('replaces matched spans and counts them', () => {
		const { cleaned, redactions } = redactSecrets('use sk-abc123xyz98765 and AKIAABCDEFGHIJ123456');
		expect(redactions).toBe(2);
		expect(cleaned).not.toContain('AKIA');
		expect(cleaned).toContain('[redacted secret]');
	});

	it('is a no-op on clean prose and on legitimate Unicode', () => {
		expect(redactSecrets('clean prose')).toEqual({ cleaned: 'clean prose', redactions: 0 });
		const family = 'Team \u{1F468}‍\u{1F469}‍\u{1F467} shipped ＡＢＣ today.';
		expect(redactSecrets(family)).toEqual({ cleaned: family, redactions: 0 });
	});

	it('redacts a whole PEM private-key block — the key material and footer, not just the header', () => {
		const payload = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun';
		const block = [
			'-----BEGIN RSA PRIVATE KEY-----',
			payload,
			'Vl9GQUtFX0tFWV9NQVRFUklBTF9GT1JfVEVTVFNfT05MWQ==',
			'-----END RSA PRIVATE KEY-----'
		].join('\n');
		const { cleaned, redactions } = redactSecrets(`config:\n${block}\ntrailing prose`);
		expect(redactions).toBe(1);
		expect(cleaned).toBe('config:\n[redacted secret]\ntrailing prose');
		expect(cleaned).not.toContain(payload);
		expect(cleaned).not.toContain('END RSA PRIVATE KEY');
	});

	it('redacts every block separately and handles an escaped-newline key and an unmatched header', () => {
		const pkcs8 = '-----BEGIN PRIVATE KEY-----\\nQUJDREVGR0g=\\n-----END PRIVATE KEY-----';
		const openssh = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----';
		const { cleaned, redactions } = redactSecrets(`a ${pkcs8} b ${openssh} c`);
		expect(redactions).toBe(2);
		expect(cleaned).toBe('a [redacted secret] b [redacted secret] c');

		const truncated = redactSecrets('-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE');
		expect(truncated.redactions).toBe(1);
		expect(truncated.cleaned).not.toContain('BEGIN EC PRIVATE KEY');
	});

	it('pairs a block with the footer of its own key type only', () => {
		const rsa = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----';
		const body = `-----BEGIN EC PRIVATE KEY-----\nBBBB\n${rsa}`;
		const hits = scanForSecrets(body).filter((hit) => hit.pattern === 'pem_private_key');
		// The EC header has no EC footer, so it is flagged on its own; the RSA
		// block is still flagged (and redacted) whole.
		expect(hits).toHaveLength(2);
		const { cleaned } = redactSecrets(body);
		expect(cleaned).not.toContain('PRIVATE KEY-----');
	});

	it('defeats a zero-width split token without keeping the invisible joiner', () => {
		const token = 'sk-​abcdefghij1234567890';
		expect(containsSecret(token)).toBe(true);
		const { cleaned, redactions } = redactSecrets(`prefix ${token} suffix`);
		expect(redactions).toBeGreaterThan(0);
		expect(cleaned).not.toContain('abcdefghij1234567890');
		expect(cleaned).not.toContain('​');
	});
});
