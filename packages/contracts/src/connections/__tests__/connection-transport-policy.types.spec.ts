import { describe, expect, it } from 'vitest';

import {
	REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING,
	REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING_LABEL,
	assessCredentialTransport,
	organizationRequiresHttpsForCredentials,
	sanitizeOrganizationConnectionPolicy
} from '../connection-transport-policy.types.js';

const HTTP = 'http://mcp.example.com/mcp';
const HTTPS = 'https://mcp.example.com/mcp';

describe('credential transport', () => {
	describe('assessCredentialTransport', () => {
		it('literal header values over plain http keep working, flagged insecure', () => {
			expect(assessCredentialTransport({ url: HTTP, headers: { Authorization: 'Bearer literal' } })).toEqual({
				verdict: 'insecure'
			});
		});

		it('a credential reference over plain http is refused', () => {
			expect(
				assessCredentialTransport({ url: HTTP, headers: { Authorization: 'Bearer {{cred.docs_token}}' } })
			).toEqual({ verdict: 'refused', reason: 'credential_references' });
			// One reference among literal headers is still a reference.
			expect(
				assessCredentialTransport({
					url: HTTP,
					headers: { 'X-Api-Key': 'literal', Authorization: '{{ cred.k1 }}' }
				})
			).toEqual({ verdict: 'refused', reason: 'credential_references' });
		});

		it('with the organization setting on, literal credentials over plain http are refused too', () => {
			expect(
				assessCredentialTransport({
					url: HTTP,
					headers: { Authorization: 'Bearer literal' },
					requireHttpsForCredentials: true
				})
			).toEqual({ verdict: 'refused', reason: 'organization_policy' });
		});

		it('https is secure in every case', () => {
			for (const requireHttpsForCredentials of [false, true]) {
				expect(
					assessCredentialTransport({
						url: HTTPS,
						headers: { Authorization: 'Bearer {{cred.k1}}', 'X-Api-Key': 'literal' },
						requireHttpsForCredentials
					})
				).toEqual({ verdict: 'secure' });
			}
		});

		it('plain http without credential headers is unchanged in every case', () => {
			for (const requireHttpsForCredentials of [false, true]) {
				const headerCases: Array<Record<string, string> | null | undefined> = [
					null,
					undefined,
					{},
					{ Authorization: '' }
				];
				for (const headers of headerCases) {
					expect(assessCredentialTransport({ url: HTTP, headers, requireHttpsForCredentials })).toEqual({
						verdict: 'secure'
					});
				}
			}
		});

		it('stdio rows never dial a network address', () => {
			expect(
				assessCredentialTransport({
					url: 'stdio:pkg/server',
					transport: 'stdio',
					headers: { A: '{{cred.k1}}' },
					requireHttpsForCredentials: true
				})
			).toEqual({ verdict: 'secure' });
		});

		it('an unparseable url is not https', () => {
			expect(assessCredentialTransport({ url: 'not a url', headers: { A: 'literal' } })).toEqual({
				verdict: 'insecure'
			});
		});
	});

	describe('organization setting', () => {
		it('is off unless explicitly turned on', () => {
			expect(organizationRequiresHttpsForCredentials(null)).toBe(false);
			expect(organizationRequiresHttpsForCredentials({})).toBe(false);
			expect(organizationRequiresHttpsForCredentials({ requireHttpsForCredentials: 'true' })).toBe(false);
			expect(organizationRequiresHttpsForCredentials({ requireHttpsForCredentials: false })).toBe(false);
			expect(organizationRequiresHttpsForCredentials({ requireHttpsForCredentials: true })).toBe(true);
		});

		it('sanitizes to known boolean keys only', () => {
			expect(sanitizeOrganizationConnectionPolicy({ requireHttpsForCredentials: true, extra: 1 })).toEqual({
				requireHttpsForCredentials: true
			});
			expect(sanitizeOrganizationConnectionPolicy({ requireHttpsForCredentials: 1 })).toBeNull();
			expect(sanitizeOrganizationConnectionPolicy([])).toBeNull();
			expect(sanitizeOrganizationConnectionPolicy('x')).toBeNull();
		});

		it('names the setting', () => {
			expect(REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING).toBe('requireHttpsForCredentials');
			expect(REQUIRE_HTTPS_FOR_CREDENTIALS_SETTING_LABEL).toBe('Require https for connection credentials');
		});
	});
});
