import {
    classifyReviewAuthor,
    classifyReviewBotComment,
    classifyReviewer,
    formatInlineFinding,
    isReviewBotNoise,
    normalizeReviewerLogin,
    parseReviewBotSeverity,
    stripReviewBotMarkup,
    type ReviewBotCommentVerdict,
} from './github-review-bots';
import {
    reviewBotCommentFixture,
    reviewBotCommentFixtures,
} from './__fixtures__/review-bot-comments.helper-spec';

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

    /**
     * Who may steer a fleet run. The repository is public: any GitHub
     * account can "Request changes" or comment on a fleet-made pull
     * request, and a recorded rejection resumes the agent on the owner's
     * PC with that text as instructions. A human counts only as an OWNER,
     * MEMBER or COLLABORATOR.
     */
    describe('classifyReviewAuthor', () => {
        const person = { login: 'someone', type: 'User' };

        it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('%s is a human who steers', (association) => {
            expect(
                classifyReviewAuthor({ user: person, author_association: association }, POLICY),
            ).toBe('human');
        });

        it.each([
            'CONTRIBUTOR',
            'FIRST_TIME_CONTRIBUTOR',
            'FIRST_TIMER',
            'MANNEQUIN',
            'NONE',
            'ADMIN', // not a GitHub value — an unknown association is an outsider
            '',
        ])('%s is an outsider', (association) => {
            expect(
                classifyReviewAuthor({ user: person, author_association: association }, POLICY),
            ).toBe('outside-human');
        });

        it('fails closed when GitHub sends no association at all', () => {
            expect(classifyReviewAuthor({ user: person }, POLICY)).toBe('outside-human');
            expect(classifyReviewAuthor({ user: person, author_association: null }, POLICY)).toBe(
                'outside-human',
            );
            // A review with no user and no association (a trimmed replay).
            expect(classifyReviewAuthor({}, POLICY)).toBe('outside-human');
            expect(classifyReviewAuthor(undefined, POLICY)).toBe('outside-human');
        });

        it('compares the association without regard to case or padding', () => {
            expect(
                classifyReviewAuthor(
                    { user: person, author_association: ' collaborator ' },
                    POLICY,
                ),
            ).toBe('human');
        });

        it('leaves every bot class exactly as classifyReviewer decides — association never upgrades or downgrades a bot', () => {
            expect(
                classifyReviewAuthor(
                    {
                        user: { login: 'coderabbitai[bot]', type: 'Bot' },
                        author_association: 'NONE',
                    },
                    POLICY,
                ),
            ).toBe('trusted-bot');
            // ⭐ the platform identity stays `self`, even as an OWNER.
            expect(
                classifyReviewAuthor(
                    {
                        user: { login: 'ever-works[bot]', type: 'Bot' },
                        author_association: 'OWNER',
                    },
                    POLICY,
                ),
            ).toBe('self');
            expect(
                classifyReviewAuthor(
                    {
                        user: { login: 'dependabot[bot]', type: 'Bot' },
                        author_association: 'MEMBER',
                    },
                    POLICY,
                ),
            ).toBe('untrusted-bot');
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

    /**
     * Prod, 2026-10-09 12:42Z: the first fleet-made PR
     * (ever-works/ever-works#2575) received CodeRabbit's automatic
     * "Currently processing new changes in this PR" placeholder, the
     * bridge recorded it as a REJECTION, and the fix loop resumed the agent
     * on a fleet PC — which found nothing to do. Every case below is a body
     * one of the trusted bots actually posted on this repository.
     */
    describe('classifyReviewBotComment', () => {
        const label = (verdict: ReviewBotCommentVerdict): string =>
            verdict.kind === 'findings' ? 'findings' : `ignore:${verdict.reason}`;
        const created = (body: string | null | undefined) =>
            label(classifyReviewBotComment({ action: 'created', body }));

        describe('the captured corpus', () => {
            it.each(reviewBotCommentFixtures().map((fixture) => [fixture.name, fixture] as const))(
                '%s',
                (_name, fixture) => {
                    expect(created(fixture.body)).toBe(fixture.expected);
                },
            );

            it('covers every reason a NEW comment can be ignored, and real findings on both events', () => {
                // A corpus that silently lost its placeholder sample would
                // keep every case above green while proving nothing.
                const expected = new Set(reviewBotCommentFixtures().map((f) => f.expected));
                for (const reason of [
                    'ignore:in-progress',
                    'ignore:nothing-actionable',
                    'ignore:rate-limited',
                    'ignore:command-ack',
                    'ignore:summary',
                    'ignore:status',
                    'findings',
                ]) {
                    expect(expected).toContain(reason);
                }
                const findingEvents = new Set(
                    reviewBotCommentFixtures()
                        .filter((f) => f.expected === 'findings')
                        .map((f) => f.event),
                );
                expect(findingEvents).toEqual(
                    new Set(['issue_comment', 'pull_request_review_comment']),
                );
            });
        });

        it('⭐ ignores the exact placeholder production recorded on #2575', () => {
            const placeholder = reviewBotCommentFixture(
                'coderabbit-summary-in-progress-placeholder',
            ).body;
            expect(placeholder).toContain('Currently processing new changes in this PR');
            expect(classifyReviewBotComment({ action: 'created', body: placeholder })).toEqual({
                kind: 'ignore',
                reason: 'in-progress',
            });
            // The bug: the old status filter let it through, and the
            // stripped text was non-empty — so it became a rejection row.
            expect(isReviewBotNoise(placeholder)).toBe(false);
            expect(stripReviewBotMarkup(placeholder).length).toBeGreaterThan(0);
        });

        it('recognises the placeholder by its marker alone, and by its sentence alone', () => {
            expect(
                created(
                    '<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->\n\n> [!NOTE]\n> Reviewing.',
                ),
            ).toBe('ignore:in-progress');
            expect(
                created(
                    '> [!NOTE]\n> Currently processing new changes in this PR. This may take a few minutes, please wait...',
                ),
            ).toBe('ignore:in-progress');
        });

        it('treats the CodeRabbit summary comment as chatter whatever it says — findings never live there', () => {
            const summary =
                '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->';
            expect(created(`${summary}\n\n## Walkthrough\n\nAdds severity.`)).toBe(
                'ignore:summary',
            );
            expect(
                created(
                    `${summary}\n\nNo actionable comments were generated in the recent review. 🎉`,
                ),
            ).toBe('ignore:nothing-actionable');
            expect(
                created(
                    `${summary}\n<!-- This is an auto-generated comment: skip review by coderabbit.ai -->\n\n> ## Review skipped`,
                ),
            ).toBe('ignore:status');
            expect(
                created(
                    `${summary}\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n\n> ## Review limit reached`,
                ),
            ).toBe('ignore:rate-limited');
        });

        it('only an ack WITHOUT an analysis is a command acknowledgement', () => {
            const ack =
                '<details>\n<summary>⚠️ Action not completed</summary>\n\nReview rate limited.\n\n</details>';
            expect(created(`<!-- This is an auto-generated reply by CodeRabbit -->\n${ack}`)).toBe(
                'ignore:command-ack',
            );
            expect(
                created(
                    `<details>\n<summary>🧩 Analysis chain</summary>\n\nscript\n\n</details>\n\nThe retry loop still never backs off.\n\n${ack}`,
                ),
            ).toBe('findings');
        });

        it('a Greptile summary is a finding only when it carries a P-badge', () => {
            const head = '<!-- greptile_summary -->\n\n<h2>Confidence Score: 3/5</h2>\n\n';
            expect(created(`${head}This PR is safe to merge.`)).toBe('ignore:summary');
            expect(
                created(
                    `${head}<h2>Findings</h2>\n\n1. <img alt="P1" src="p1.svg" align="top">&nbsp;**Older platforms reject enrollment**`,
                ),
            ).toBe('findings');
            // The Retrigger button is an <img> too — not a badge.
            expect(created(`${head}<img alt="Retrigger" src="Retrigger.svg" align="right">`)).toBe(
                'ignore:summary',
            );
        });

        it('a TREX run is a finding unless it found nothing or could not run', () => {
            const head = '<!-- greptile_trex_summary -->\n\n<h2>TREX</h2>\n\n';
            expect(created(`${head}Tested 1 flow, found no issues.`)).toBe('ignore:summary');
            expect(created(`${head}No flows tested, and faced 2 obstacles.`)).toBe(
                'ignore:summary',
            );
            expect(created(`${head}Tested 2 flows, found 1 issue.\n\n- **Fail** — Login`)).toBe(
                'findings',
            );
        });

        it('never guesses from prose — an inline finding that MENTIONS these words is still a finding', () => {
            for (const body of [
                'The walkthrough in docs/fleet.md still says affinity has no UI.',
                'This retry ignores the rate limit header, so a 429 is retried at once.',
                'Review in progress states are never cleared when the job is cancelled.',
                'The summary row drops the actionable comments count.',
                '_🔒 Security & Privacy_ | _🟠 Major_ | _⚡ Quick win_\n\n**No actionable comments were generated** is printed even on failure.',
            ]) {
                expect(created(body)).toBe('findings');
            }
        });

        it('a finding that QUOTES the placeholder or plan-limit sentence mid-line is still a finding', () => {
            // A review of this very classifier would do exactly this. The
            // two verbatim sentences only count where CodeRabbit prints
            // them: at the start of a (block-quoted) line.
            expect(
                created(
                    '_🟠 Major_\n\nThe regex for `Currently processing new changes in this PR` is unanchored, so a quote of it is dropped.',
                ),
            ).toBe('findings');
            expect(
                created(
                    'The notice text "Your [plan](x) includes PR reviews subject to [rate limits](y)" is matched anywhere in a body.',
                ),
            ).toBe('findings');
            // …and the same for every structural marker: they count only
            // where the bots print them, at the start of a line.
            for (const quoted of [
                '`<!-- This is an auto-generated comment: summarize by coderabbit.ai -->`',
                '`<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->`',
                '`<!-- greptile_summary -->`',
                '`<!-- greptile_trex_summary -->` with found no issues',
                '`<summary>✅ Action performed</summary>`',
            ]) {
                expect(
                    created(
                        `_🟠 Major_\n\nThe classifier keys on ${quoted}, so a quote of it must not drop this finding.`,
                    ),
                ).toBe('findings');
            }
        });

        it('a finding that shows a marker on its OWN line inside a fenced code sample is still a finding', () => {
            // CodeRabbit (round 2): line-anchoring alone still matched a
            // marker standing alone on a line of a ``` sample.
            for (const sample of [
                '```html\n<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->\n```',
                '```\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n```',
                '> ```md\n> <!-- greptile_summary -->\n> ```',
                '~~~\n<summary>Action performed</summary>\n~~~',
                '````\nYour [plan](x) includes PR reviews subject to [rate limits](y)\n````',
                // An unclosed fence runs to the end of the body.
                '```\nCurrently processing new changes in this PR.',
            ]) {
                expect(
                    created(
                        `_🟡 Minor_\n\nThe classifier drops a finding that contains:\n\n${sample}\n\nExclude code samples from marker matching.`,
                    ),
                ).toBe('findings');
            }
            // A fence closes only on the SAME character (CodeRabbit, round
            // 3): a mixed ```~~~ line inside a backtick sample, or ~~~```
            // inside a tilde one, must not end the block early and expose
            // the quoted marker that follows it.
            for (const sample of [
                '```\n```~~~\n<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n```',
                '~~~\n~~~```\n<!-- greptile_summary -->\n~~~',
                '```\n~~~\n<!-- This is an auto-generated comment: review in progress by coderabbit.ai -->\n```',
            ]) {
                expect(created(`_🟡 Minor_\n\nQuoted:\n\n${sample}\n\nStill a finding.`)).toBe(
                    'findings',
                );
            }
            // …while a finding that is NOTHING but a code sample is still
            // not "empty": the fence is removed for marker matching only.
            expect(created('```ts\nconst retries = Infinity;\n```')).toBe('findings');
        });

        it('stays fast on pathological bodies — this runs on the webhook path, in the event loop', () => {
            // GitHub caps a comment at 65 536 characters. The old
            // `^\s*>?\s*#{1,6}…` rate-limit pattern needed ~58 s for 4 000
            // blank characters (and minutes for more); a regression here
            // blows Jest's timeout long before it would be noticed in prod.
            const CAP = 65_536;
            const bodies = [
                '\n'.repeat(CAP),
                ' \n'.repeat(CAP / 2),
                '> \n'.repeat(Math.floor(CAP / 3)),
                '```\n~~~\n'.repeat(Math.floor(CAP / 8)),
                `<!-- greptile_summary -->\n${'<img '.repeat(Math.floor(CAP / 5) - 6)}`,
            ];
            const started = Date.now();
            for (const body of bodies) {
                expect(['findings', 'ignore:empty', 'ignore:summary']).toContain(created(body));
                expect(isReviewBotNoise(body)).toBe(false);
            }
            // Generous: the whole set takes well under a second today.
            expect(Date.now() - started).toBeLessThan(10_000);
        });

        it('keeps every real inline finding shape as a finding', () => {
            for (const body of [
                reviewBotCommentFixture('coderabbit-inline-major-finding').body,
                reviewBotCommentFixture('greptile-inline-p2-finding').body,
                '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Cast metadata before using JSON operator**\n\nOn the Postgres schema…',
                'The retry loop never backs off, so a flaky provider is hammered.',
            ]) {
                expect(created(body)).toBe('findings');
            }
        });

        it('⭐ an edit is never a new finding — whatever the body now says', () => {
            for (const action of ['edited', 'deleted', 'EDITED', '', undefined, null]) {
                for (const fixture of reviewBotCommentFixtures()) {
                    expect(classifyReviewBotComment({ action, body: fixture.body })).toEqual({
                        kind: 'ignore',
                        reason: 'not-created',
                    });
                }
            }
            // …while `created` is matched without regard to case or padding.
            expect(created(reviewBotCommentFixture('coderabbit-inline-major-finding').body)).toBe(
                'findings',
            );
            expect(
                label(
                    classifyReviewBotComment({
                        action: ' Created ',
                        body: 'The retry loop never backs off.',
                    }),
                ),
            ).toBe('findings');
        });

        it('falls back to the existing status filter, and to "nothing left once stripped"', () => {
            expect(created('**Actionable comments posted: 0**')).toBe('ignore:nothing-actionable');
            expect(created('<!-- greptile-status -->\nToo many files changed for review.')).toBe(
                'ignore:status',
            );
            expect(created('You have reached your Codex usage limits for code reviews.')).toBe(
                'ignore:rate-limited',
            );
            expect(created('<!-- x -->\n<details>\n<summary>y</summary>\nz\n</details>')).toBe(
                'ignore:empty',
            );
            expect(created('')).toBe('ignore:empty');
            expect(created(undefined)).toBe('ignore:empty');
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
