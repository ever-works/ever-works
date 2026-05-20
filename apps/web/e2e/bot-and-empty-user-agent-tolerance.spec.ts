import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Anonymous requests with bot or absent User-Agent must not 5xx. Some
 * platforms intentionally 403 known scrapers; that's fine — but they
 * must never crash. We also check that the response doesn't echo the
 * UA back unsanitised into HTML (XSS-via-UA).
 */

const USER_AGENTS: Array<{ label: string; ua: string }> = [
    { label: 'empty UA', ua: '' },
    {
        label: 'Googlebot',
        ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    },
    {
        label: 'Bingbot',
        ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    },
    { label: 'DuckDuckBot', ua: 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)' },
    {
        label: 'GPTBot',
        ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.0; +https://openai.com/gptbot',
    },
    { label: 'ClaudeBot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
    {
        label: 'PerplexityBot',
        ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://www.perplexity.ai/perplexitybot)',
    },
    { label: 'curl', ua: 'curl/8.4.0' },
    { label: 'wget', ua: 'Wget/1.21.4' },
    { label: 'XSS-shaped UA', ua: '<script>alert(1)</script>' },
    { label: 'extremely long UA', ua: 'Mozilla/5.0 ' + 'A'.repeat(2000) },
];

const PUBLIC_PATHS = ['/api/health', '/.well-known/agent.json'];

test.describe('Public endpoints: bot / empty / hostile UA tolerance', () => {
    for (const path of PUBLIC_PATHS) {
        for (const { label, ua } of USER_AGENTS) {
            test(`GET ${path} with UA "${label}"`, async ({ request }) => {
                const res = await request.get(`${API_BASE}${path}`, {
                    headers: ua ? { 'User-Agent': ua } : {},
                });
                expect(res.status(), `${path} UA=${label}`).toBeLessThan(500);
                // XSS-via-UA: server must not echo the UA into a response body untrustedly.
                if (label === 'XSS-shaped UA') {
                    const body = await res.text();
                    expect(body).not.toContain('<script>alert(1)</script>');
                }
            });
        }
    }
});
