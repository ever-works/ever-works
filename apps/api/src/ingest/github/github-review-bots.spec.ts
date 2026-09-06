import {
    classifyReviewer,
    formatInlineFinding,
    isReviewBotNoise,
    normalizeReviewerLogin,
    parseReviewBotSeverity,
    stripReviewBotMarkup,
} from './github-review-bots';

/**
 * Trusted review bots (self-build fleet, finding R16) — the pure policy.
 *
 * Every fixture below is the literal shape captured from this
 * repository's own PR history with `gh api` (CodeRabbit on #2344, Codex
 * on #1219, Greptile on #1709, Copilot on #261), not a guess at what the
 * bots might post.
 */
describe('github-review-bots', () => {
    const POLICY = {
        trusted: new Set(['coderabbitai[bot]', 'copilot']),
        self: new Set(['ever-works[bot]']),
    };

    describe('classifyReviewer', () => {
        it('treats a non-bot account as human, whatever its login', () => {
            expect(classifyReviewer({ login: 'octocat', type: 'User' }, POLICY)).toBe('human');
            expect(classifyReviewer({ login: 'coderabbitai[bot]', type: 'User' }, POLICY)).toBe(
                'human',
            );
            expect(classifyReviewer(undefined, POLICY)).toBe('human');
        });

        it('recognises an allow-listed bot case-insensitively', () => {
            expect(classifyReviewer({ login: 'coderabbitai[bot]', type: 'Bot' }, POLICY)).toBe(
                'trusted-bot',
            );
            expect(classifyReviewer({ login: 'Copilot', type: 'Bot' }, POLICY)).toBe('trusted-bot');
            expect(classifyReviewer({ login: 'copilot', type: 'Bot' }, POLICY)).toBe('trusted-bot');
        });

        it('drops a bot that is not on the list', () => {
            expect(classifyReviewer({ login: 'github-actions[bot]', type: 'Bot' }, POLICY)).toBe(
                'untrusted-bot',
            );
            expect(classifyReviewer({ login: 'dependabot[bot]', type: 'Bot' }, POLICY)).toBe(
                'untrusted-bot',
            );
            expect(classifyReviewer({ type: 'Bot' }, POLICY)).toBe('untrusted-bot');
        });

        it('⭐ self wins over trusted — listing the platform identity changes nothing', () => {
            // THE security property. The loop must never treat its own
            // output as reviewer feedback, no matter what the operator
            // types into the allow-list.
            const policy = {
                trusted: new Set(['ever-works[bot]', 'coderabbitai[bot]']),
                self: new Set(['ever-works[bot]']),
            };
            expect(classifyReviewer({ login: 'ever-works[bot]', type: 'Bot' }, policy)).toBe(
                'self',
            );
            expect(classifyReviewer({ login: 'Ever-Works[bot]', type: 'Bot' }, policy)).toBe(
                'self',
            );
        });
    });

    describe('normalizeReviewerLogin', () => {
        it('lower-cases, trims and strips a pasted @', () => {
            expect(normalizeReviewerLogin('  @CodeRabbitAI[bot] ')).toBe('coderabbitai[bot]');
            expect(normalizeReviewerLogin(undefined)).toBe('');
        });
    });

    describe('parseReviewBotSeverity', () => {
        it('reads the CodeRabbit severity cell on the first line', () => {
            expect(
                parseReviewBotSeverity(
                    '_🗄️ Data Integrity & Integration_ | _🟠 Major_ | _🏗️ Heavy lift_\n\n<details>…</details>',
                ),
            ).toBe('major');
            expect(
                parseReviewBotSeverity(
                    '_📐 Maintainability & Code Quality_ | _🟡 Minor_ | _⚡ Quick win_',
                ),
            ).toBe('minor');
            expect(parseReviewBotSeverity('_🔒 Security_ | _🔴 Critical_ | _🏗️ Heavy lift_')).toBe(
                'critical',
            );
        });

        it('maps the Codex P-badge: P1 → critical, P2 → major, P3 → minor', () => {
            expect(
                parseReviewBotSeverity(
                    '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Cast metadata before using JSON operator**\n\nOn the Postgres schema…',
                ),
            ).toBe('critical');
            expect(
                parseReviewBotSeverity(
                    '**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Title**',
                ),
            ).toBe('major');
            expect(parseReviewBotSeverity('![P3 Badge](https://img.shields.io/badge/P3)')).toBe(
                'minor',
            );
        });

        it('maps the Greptile badge image', () => {
            expect(
                parseReviewBotSeverity(
                    '<a href="#"><img alt="P2" src="https://greptile-static-assets.s3.amazonaws.com/badges/p2.svg?v=9" align="top"></a> The `import type` statement appears after the export block.',
                ),
            ).toBe('major');
            expect(parseReviewBotSeverity('<img alt="P1" src="x.svg">')).toBe('critical');
        });

        it('returns null for Copilot prose and for a human-shaped body', () => {
            expect(
                parseReviewBotSeverity(
                    'The retry loop never backs off, so a flaky provider is hammered.',
                ),
            ).toBeNull();
            expect(parseReviewBotSeverity('')).toBeNull();
            expect(parseReviewBotSeverity(undefined)).toBeNull();
        });

        it('only looks at the head of the body — a marker buried in a log is not a verdict', () => {
            const buried = `${'x'.repeat(700)}\n_🟠 Major_`;
            expect(parseReviewBotSeverity(buried)).toBeNull();
        });
    });

    describe('isReviewBotNoise', () => {
        it('flags the CodeRabbit rate-limit notice (both markers)', () => {
            expect(
                isReviewBotNoise(
                    '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> [!WARNING]\n> ## Review limit reached\n>\n> **Next included review available in 34 minutes.**',
                ),
            ).toBe(true);
            expect(isReviewBotNoise('> ## Review limit reached')).toBe(true);
        });

        it('flags Greptile status chatter and the Codex usage cap', () => {
            expect(
                isReviewBotNoise('<!-- greptile-status -->\nToo many files changed for review.'),
            ).toBe(true);
            expect(isReviewBotNoise('Too many files changed for review')).toBe(true);
            expect(
                isReviewBotNoise('You have reached your Codex usage limits for code reviews.'),
            ).toBe(true);
        });

        it('flags a CodeRabbit review that has nothing actionable and nothing else', () => {
            expect(
                isReviewBotNoise(
                    '**Actionable comments posted: 0**\n\n<details>\n<summary>🧹 Nitpick comments (1)</summary>\n\nblah\n\n</details>',
                ),
            ).toBe(true);
        });

        it('keeps real findings and summaries', () => {
            expect(isReviewBotNoise('**Actionable comments posted: 3**')).toBe(false);
            expect(
                isReviewBotNoise(
                    '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\n## Summary by CodeRabbit\n\n- Adds severity to rejections.',
                ),
            ).toBe(false);
            expect(isReviewBotNoise('<h3>Greptile Summary</h3>\n\nThis PR adds…')).toBe(false);
            expect(isReviewBotNoise('')).toBe(false);
        });
    });

    describe('stripReviewBotMarkup', () => {
        it('drops HTML comments and nested <details> blocks, keeping the finding', () => {
            const body = [
                '_🗄️ Data Integrity & Integration_ | _🟠 Major_ | _🏗️ Heavy lift_',
                '',
                '<details>',
                '<summary>🔎 Supported by static analysis</summary>',
                '',
                '🤖 get_repo_knowledge executed:',
                '',
                '<details>',
                '<summary>inner</summary>',
                'Length of output: 33708',
                '</details>',
                '',
                '</details>',
                '',
                '<!-- fingerprinting:phantom:triton:puma -->',
                '',
                'The migration drops the column without a guard.',
            ].join('\n');
            const stripped = stripReviewBotMarkup(body);
            expect(stripped).toBe(
                '_🗄️ Data Integrity & Integration_ | _🟠 Major_ | _🏗️ Heavy lift_\n\nThe migration drops the column without a guard.',
            );
            expect(stripped).not.toContain('Length of output');
            expect(stripped).not.toContain('fingerprinting');
        });

        it('unwraps the Codex badge and the Greptile anchor', () => {
            expect(
                stripReviewBotMarkup(
                    '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Cast metadata**\n\nBody.',
                ),
            ).toBe('**  Cast metadata**\n\nBody.');
            expect(
                stripReviewBotMarkup(
                    '<a href="#"><img alt="P2" src="https://greptile-static-assets.s3.amazonaws.com/badges/p2.svg?v=9" align="top"></a> The import is mid-file.',
                ),
            ).toBe('The import is mid-file.');
        });

        it('leaves generics in code samples alone — only presentation tags are stripped', () => {
            expect(stripReviewBotMarkup('Return `Promise<void>` here, not `Array<string>`.')).toBe(
                'Return `Promise<void>` here, not `Array<string>`.',
            );
        });

        it('tolerates an empty or missing body', () => {
            expect(stripReviewBotMarkup('')).toBe('');
            expect(stripReviewBotMarkup(undefined)).toBe('');
        });
    });

    describe('formatInlineFinding', () => {
        it('prefixes path:line so the resumed run can open the file', () => {
            expect(
                formatInlineFinding(
                    { path: 'apps/web/eslint.config.mjs', line: 144, original_line: 60 },
                    'Use the scoped rule.',
                ),
            ).toBe('apps/web/eslint.config.mjs:144 — Use the scoped rule.');
        });

        it('falls back to original_line, then to the bare path', () => {
            expect(
                formatInlineFinding({ path: 'src/a.ts', line: null, original_line: 53 }, 'x'),
            ).toBe('src/a.ts:53 — x');
            expect(formatInlineFinding({ path: 'src/a.ts' }, 'x')).toBe('src/a.ts — x');
        });

        it('returns the text alone with no path, and nothing for an empty finding', () => {
            expect(formatInlineFinding({}, 'x')).toBe('x');
            expect(formatInlineFinding({ path: 'src/a.ts', line: 1 }, '   ')).toBe('');
        });
    });
});
