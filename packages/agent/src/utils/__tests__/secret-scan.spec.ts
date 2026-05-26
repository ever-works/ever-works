import { assertNoSecrets, containsSecret, redactSecrets, scanForSecrets } from '../secret-scan';

describe('secret-scan', () => {
    describe('scanForSecrets — pattern coverage', () => {
        const cases: Array<[string, string, string]> = [
            ['OpenAI-style sk- key', 'use sk-abc123xyz9876543 to call', 'generic'],
            ['Bearer header', 'Authorization: Bearer abcdefghijklmno', 'generic'],
            ['AWS access key id', 'AKIAABCDEFGHIJ123456', 'aws_access_key'],
            [
                'GitHub PAT classic',
                'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                'github_pat_classic',
            ],
            ['GitHub OAuth', 'gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'github_oauth'],
            ['GitLab PAT', 'glpat-abcdefghijklmnopqrst', 'gitlab_pat'],
            ['Slack bot token', 'xoxb-1234567890-abcdef', 'slack_token'],
            ['Generic PAT', 'pat_abcdefghijklmnopqrstuvwxyz0123456789', 'generic_pat'],
        ];

        for (const [label, body, pattern] of cases) {
            it(`detects ${label}`, () => {
                const hits = scanForSecrets(body);
                expect(hits.length).toBeGreaterThan(0);
                expect(hits.some((h) => h.pattern === pattern)).toBe(true);
            });
        }

        it('does NOT flag prose containing the word "token" with no value', () => {
            expect(scanForSecrets('Please paste your token here.')).toEqual([]);
        });

        it('returns matched index for surfacing in UI error', () => {
            const hits = scanForSecrets('prefix sk-aaaaaaaaaaaaaa suffix');
            expect(hits[0].index).toBe(7);
        });

        it('returns multiple matches across patterns', () => {
            const body = 'sk-abc123xyz98765 and also AKIAABCDEFGHIJ123456';
            const hits = scanForSecrets(body);
            expect(hits.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('containsSecret', () => {
        it('boolean truthy on any hit', () => {
            expect(containsSecret('AKIAABCDEFGHIJ123456')).toBe(true);
        });
        it('boolean false on clean body', () => {
            expect(containsSecret('## My Agent\nNo secrets here.')).toBe(false);
        });
        it('handles empty body', () => {
            expect(containsSecret('')).toBe(false);
        });
    });

    describe('assertNoSecrets', () => {
        it('throws on secret with pattern + sample in message', () => {
            expect(() => assertNoSecrets('use AKIAABCDEFGHIJ123456 here')).toThrow(
                /aws_access_key/,
            );
        });

        it('no-op on clean body', () => {
            expect(() => assertNoSecrets('## A clean note.')).not.toThrow();
        });

        it('includes fieldHint in error message', () => {
            expect(() =>
                assertNoSecrets('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'SOUL.md'),
            ).toThrow(/SOUL\.md/);
        });

        it('truncates long matches in error for safe display', () => {
            const longSecret = 'ghp_' + 'x'.repeat(50);
            let msg = '';
            try {
                assertNoSecrets(longSecret);
            } catch (e) {
                msg = (e as Error).message;
            }
            // Truncated form uses ellipsis between prefix and tail.
            expect(msg).toMatch(/…/);
        });
    });

    describe('redactSecrets', () => {
        it('replaces matched spans with [redacted secret] and counts', () => {
            const { cleaned, redactions } = redactSecrets(
                'use sk-abc123xyz98765 and AKIAABCDEFGHIJ123456',
            );
            expect(redactions).toBe(2);
            expect(cleaned).toContain('[redacted secret]');
            expect(cleaned).not.toContain('AKIA');
        });

        it('no-op + count 0 on clean body', () => {
            const { cleaned, redactions } = redactSecrets('clean prose');
            expect(redactions).toBe(0);
            expect(cleaned).toBe('clean prose');
        });
    });
});
