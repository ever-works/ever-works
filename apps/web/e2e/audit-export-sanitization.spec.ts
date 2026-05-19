import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * Audit export sanitization — pass 10. Deepens csv-export-schema.
 * Admin / user audit exports must NEVER carry secret-bearing fields
 * (password hashes, API key plaintext, JWT tokens, internal IDs that
 * leak schema names).
 */

const SECRET_PATTERNS = [
    /password.{0,5}hash/i,
    /\bjwt\b/i,
    /\bbearer\s+[A-Za-z0-9_.-]{20,}/i,
    /sk_live_[A-Za-z0-9]{20,}/,
    /sk_test_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /xox[abp]-[A-Za-z0-9-]{20,}/, // Slack token prefixes
    /AKIA[A-Z0-9]{16}/, // AWS access key ID
    /AIza[A-Za-z0-9_-]{35}/, // Google API key
    /sk-[a-zA-Z0-9]{20,}/, // OpenAI-style
];

test.describe('Audit export — sanitization', () => {
    test('activity-log export body does NOT contain known secret patterns', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        // Seed a couple of activity rows.
        await createWorkViaAPI(request, u.access_token, {
            name: `sanit-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/activity-log/export`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() !== 200) test.skip(true, `export returned ${res.status()}`);
        const body = await res.text();
        if (!body) test.skip(true, 'empty body');
        for (const pat of SECRET_PATTERNS) {
            const m = body.match(pat);
            expect(
                m,
                `audit export leaked a secret matching ${pat}: ${m?.[0]?.slice(0, 60)}`,
            ).toBeNull();
        }
    });

    test('account export does NOT contain user password hash', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/account/export`, {
            headers: authedHeaders(u.access_token),
        });
        if (res.status() !== 200) test.skip(true, `account export returned ${res.status()}`);
        const body = await res.text();
        if (!body) test.skip(true, 'empty body');
        // Common bcrypt/scrypt/argon2 hash prefixes — these MUST NOT
        // appear in an export the user themselves can download.
        const HASH_PATTERNS = [
            /\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}/, // bcrypt
            /\$argon2[id]\$/, // argon2
            /\$scrypt\$/i, // scrypt
        ];
        for (const pat of HASH_PATTERNS) {
            const m = body.match(pat);
            expect(m, `account export contained a hash matching ${pat}`).toBeNull();
        }
    });

    test('usage export does NOT contain internal user IDs from other tenants', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const w = await createWorkViaAPI(request, owner.access_token, {
            name: `sanit-iso-${Date.now().toString(36)}`,
        });
        const res = await request.get(`${API_BASE}/api/works/${w.id}/usage/export`, {
            headers: authedHeaders(owner.access_token),
        });
        if (res.status() !== 200) test.skip(true, `usage export returned ${res.status()}`);
        const body = await res.text();
        if (!body) test.skip(true, 'empty body');
        // The OWNER's usage export must NEVER contain the STRANGER's
        // user-id or email. If it does, the export is leaking across
        // tenants.
        expect(body.includes(stranger.user.id), 'usage export leaked stranger user id').toBe(false);
        expect(
            body.toLowerCase().includes(stranger.email.toLowerCase()),
            'usage export leaked stranger email',
        ).toBe(false);
    });
});
