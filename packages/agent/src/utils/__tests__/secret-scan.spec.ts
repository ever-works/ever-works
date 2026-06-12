import { BadRequestException } from '@nestjs/common';
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

        it('throws BadRequestException (HTTP 400), not a plain Error', () => {
            // Security (EW-716 follow-up): a plain Error is unmapped by Nest
            // and surfaced as a 500 to every caller endpoint (task-chat,
            // agent-file, skills, agent import) — mislabeling a user-input
            // rejection as a server fault. The exception must carry 400.
            try {
                assertNoSecrets('use AKIAABCDEFGHIJ123456 here');
                throw new Error('expected assertNoSecrets to throw');
            } catch (e) {
                expect(e).toBeInstanceOf(BadRequestException);
                expect((e as BadRequestException).getStatus()).toBe(400);
            }
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

    // EW-716 #17: defeat encoding / zero-width / homoglyph evasion via NFKC
    // normalization on the DETECTION copy, while keeping redaction output
    // content-preserving for legitimate (non-evasive) Unicode.
    describe('encoding/zero-width/homoglyph evasion (NFKC normalization)', () => {
        const ZWSP = '​';
        const evasiveToken = `sk-${ZWSP}abcdefghij1234567890`;

        it('detects a zero-width-split token that evaded the raw-regex scan', () => {
            // The raw body (with the zero-width char) does NOT match directly —
            // proving the normalize guard is load-bearing.
            const rawMatch = /\b(sk-|key-|token-|Bearer\s+)[A-Za-z0-9_-]{10,}\b/.test(evasiveToken);
            expect(rawMatch).toBe(false);

            const hits = scanForSecrets(evasiveToken);
            expect(hits.length).toBeGreaterThan(0);
            expect(containsSecret(evasiveToken)).toBe(true);
        });

        it('detects a soft-hyphen-split token (U+00AD)', () => {
            const SHY = '­';
            const body = `please use ghp_${SHY}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab now`;
            expect(containsSecret(body)).toBe(true);
        });

        it('redacts a zero-width-split token but preserves surrounding content', () => {
            const { cleaned, redactions } = redactSecrets(`prefix ${evasiveToken} suffix`);
            expect(redactions).toBeGreaterThan(0);
            expect(cleaned).toContain('[redacted secret]');
            expect(cleaned).not.toContain('abcdefghij1234567890');
            expect(cleaned).not.toContain(ZWSP);
            expect(cleaned).toContain('prefix ');
            expect(cleaned).toContain(' suffix');
        });

        it('leaves legitimate prose byte-for-byte unchanged (no false positive)', () => {
            const prose = 'Write tokens to disk. See the key-takeaways doc and sketch-board notes.';
            expect(scanForSecrets(prose)).toHaveLength(0);
            const { cleaned, redactions } = redactSecrets(prose);
            expect(redactions).toBe(0);
            expect(cleaned).toBe(prose);
        });

        it('does NOT corrupt legitimate Unicode content (emoji ZWJ, full-width) when there is no secret', () => {
            // redactSecrets runs on generated CONTENT — it must round-trip valid
            // ZWJ emoji sequences and full-width CJK unchanged, never NFKC-fold them.
            const family = 'Team \u{1F468}‍\u{1F469}‍\u{1F467} shipped ＡＢＣ today.';
            const { cleaned, redactions } = redactSecrets(family);
            expect(redactions).toBe(0);
            expect(cleaned).toBe(family);
        });
    });
});
