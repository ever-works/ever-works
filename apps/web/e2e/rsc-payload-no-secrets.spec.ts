import { test, expect } from '@playwright/test';

/**
 * RSC payload secret-leak — pass 19. React Server Components
 * serialize their state into HTML/RSC payloads that ship to the
 * client. A common accident: a server component reads
 * `process.env.DATABASE_URL` to pass it as a prop, and that prop is
 * serialized into the response. We grep the page HTML for known
 * env-var-name patterns to surface leakage.
 */

const FORBIDDEN_PATTERNS = [
    /postgres:\/\/[^"\s]+:[^"\s@]+@[^"\s]+/, // postgres connection string with password
    /mysql:\/\/[^"\s]+:[^"\s@]+@[^"\s]+/, // mysql connection string
    /redis:\/\/[^"\s]*:[^"\s@]+@[^"\s]+/, // redis connection with password
    /AKIA[0-9A-Z]{16}/, // AWS access key ID
    /AIza[0-9A-Za-z-_]{35}/, // Google API key
    /sk-[A-Za-z0-9]{32,}/, // OpenAI key prefix
    /ghp_[A-Za-z0-9]{36}/, // GitHub PAT
    /xox[abpr]-[A-Za-z0-9-]{10,}/, // Slack token
    /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/, // PEM private key
];

test.describe('RSC / page HTML — no secret-shaped strings in shipped bytes', () => {
    test('/en/login HTML does not contain known secret patterns', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const html = await page.content();
        const leaks: string[] = [];
        for (const re of FORBIDDEN_PATTERNS) {
            const m = re.exec(html);
            if (m) leaks.push(m[0].slice(0, 80));
        }
        expect(
            leaks,
            `secret-shaped strings leaked in /en/login HTML: ${leaks.join(', ')}`,
        ).toHaveLength(0);
    });

    test('/en (home) HTML does not contain known secret patterns', async ({ page, baseURL }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en`, {
            waitUntil: 'domcontentloaded',
        });
        const html = await page.content();
        const leaks: string[] = [];
        for (const re of FORBIDDEN_PATTERNS) {
            const m = re.exec(html);
            if (m) leaks.push(m[0].slice(0, 80));
        }
        expect(leaks, `secret-shaped strings leaked in /en HTML: ${leaks.join(', ')}`).toHaveLength(
            0,
        );
    });

    test('verbatim env-var names like DATABASE_URL never appear with values in HTML', async ({
        page,
        baseURL,
    }) => {
        await page.goto(`${baseURL || 'http://localhost:3000'}/en/login`, {
            waitUntil: 'domcontentloaded',
        });
        const html = await page.content();
        // A leak shape: `"DATABASE_URL":"postgres://..."` or
        // `DATABASE_URL=postgres://...`. We only fail when the env
        // name is paired with a credential-shaped value.
        const dangerousPairings = [
            /"DATABASE_URL"\s*:\s*"[^"]+:[^"@]+@/,
            /"JWT_SECRET"\s*:\s*"[A-Za-z0-9_-]{16,}"/,
            /"REDIS_URL"\s*:\s*"[^"]+:[^"@]+@/,
            /"SESSION_SECRET"\s*:\s*"[A-Za-z0-9_-]{16,}"/,
        ];
        for (const re of dangerousPairings) {
            const m = re.exec(html);
            expect(m, `env-var paired with credential in HTML: ${m?.[0]?.slice(0, 80)}`).toBeNull();
        }
    });
});
