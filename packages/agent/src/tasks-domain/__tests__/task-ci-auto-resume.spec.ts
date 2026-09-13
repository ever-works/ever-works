import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config';
import {
    DEFAULT_CI_AUTO_RESUME_ATTEMPTS,
    MAX_CI_AUTO_RESUME_ATTEMPTS,
    ciAutoResumeClaimKey,
    clampAutoResumeAttempts,
    classifyCheckResult,
    composeBudgetSpentNotice,
    composeCiFailureFeedback,
    computeCiFailureKey,
    decideCiHead,
    isPullRequestFinished,
    reviewAutoResumeClaimKey,
} from '../task-ci-auto-resume';

/**
 * CI feedback + autonomous fix loop (slice AC, EW-806) — the pure rules.
 *
 * These four functions decide, between them, whether a webhook delivery
 * is allowed to spend a model run. Each is unit-tested here so the
 * end-to-end suite can concentrate on the wiring rather than on
 * enumerating conclusions.
 */
describe('classifyCheckResult', () => {
    it('reds only the conclusions the board rollup treats as failures', () => {
        for (const conclusion of ['failure', 'timed_out', 'action_required', 'startup_failure']) {
            expect(classifyCheckResult({ status: 'completed', conclusion })).toBe('failing');
        }
    });

    it('does NOT red a cancelled, neutral, skipped or stale check', () => {
        for (const conclusion of ['cancelled', 'neutral', 'skipped', 'stale']) {
            expect(classifyCheckResult({ status: 'completed', conclusion })).toBe('inconclusive');
        }
    });

    it('treats an unfinished check as pending whatever its conclusion field says', () => {
        expect(classifyCheckResult({ status: 'in_progress', conclusion: 'failure' })).toBe(
            'pending',
        );
        expect(classifyCheckResult({ status: 'queued', conclusion: null })).toBe('pending');
        expect(classifyCheckResult({})).toBe('pending');
    });

    it('never launders a completed-with-no-conclusion result into a pass', () => {
        expect(classifyCheckResult({ status: 'completed', conclusion: null })).toBe('inconclusive');
        expect(classifyCheckResult({ status: 'completed', conclusion: 'success' })).toBe('passing');
    });

    it('is case-insensitive on both fields', () => {
        expect(classifyCheckResult({ status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('failing');
    });
});

describe('the retry budget', () => {
    const original = process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS;
    afterEach(() => {
        if (original === undefined) delete process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS;
        else process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = original;
    });

    it('defaults to two attempts per Task, for its whole life', () => {
        delete process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS;
        expect(config.agents.getCiAutoResumeMaxAttempts()).toBe(DEFAULT_CI_AUTO_RESUME_ATTEMPTS);
        expect(DEFAULT_CI_AUTO_RESUME_ATTEMPTS).toBe(2);
    });

    it('accepts 0 as "switch the loop off", and clamps above the ceiling', () => {
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '0';
        expect(config.agents.getCiAutoResumeMaxAttempts()).toBe(0);
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '999';
        expect(config.agents.getCiAutoResumeMaxAttempts()).toBe(MAX_CI_AUTO_RESUME_ATTEMPTS);
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '-4';
        expect(config.agents.getCiAutoResumeMaxAttempts()).toBe(0);
    });

    it('falls back to the default on a typo rather than silently disabling the loop', () => {
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = 'two';
        expect(config.agents.getCiAutoResumeMaxAttempts()).toBe(DEFAULT_CI_AUTO_RESUME_ATTEMPTS);
        expect(clampAutoResumeAttempts(Number.NaN)).toBe(DEFAULT_CI_AUTO_RESUME_ATTEMPTS);
        expect(clampAutoResumeAttempts(undefined)).toBe(DEFAULT_CI_AUTO_RESUME_ATTEMPTS);
    });

    it('truncates a fraction into the range instead of rounding up', () => {
        expect(clampAutoResumeAttempts(3.9)).toBe(3);
    });
});

describe('claim keys', () => {
    it('keys a CI attempt on the HEAD COMMIT, not on the failing job', () => {
        expect(ciAutoResumeClaimKey('abc123')).toBe('ci:abc123');
        // Twelve red jobs on one push are one thing to fix, so they must
        // all produce the SAME key.
        expect(ciAutoResumeClaimKey('abc123')).toBe(ciAutoResumeClaimKey('abc123'));
        expect(ciAutoResumeClaimKey('def456')).not.toBe(ciAutoResumeClaimKey('abc123'));
    });

    it('keys a review attempt on the rejection row', () => {
        expect(reviewAutoResumeClaimKey('rej-1')).toBe('review:rej-1');
        expect(reviewAutoResumeClaimKey('rej-1')).not.toBe(ciAutoResumeClaimKey('rej-1'));
    });
});

/**
 * The policy file is the ONE place every money-spending rule of this
 * slice lives — the claim keys, the failure fingerprint, the budget
 * clamp, the head-staleness rule. It shipped with a RAW NUL byte (0x00)
 * written as a literal control character inside the fingerprint template
 * literal instead of a unicode escape, which makes git classify the
 * file as binary: `git diff` prints "Binary files … differ" instead of
 * the content, `grep` answers "Binary file … matches" and prints nothing,
 * and the code that decides how much a red pull request is allowed to
 * cost becomes unreviewable in the GitHub diff. Nothing else in the file
 * would have gone red.
 */
describe('the policy file itself', () => {
    it('contains no raw control characters, so git treats it as text', () => {
        const source = readFileSync(join(__dirname, '..', 'task-ci-auto-resume.ts'));
        const offenders: Array<{ offset: number; byte: string }> = [];
        for (let index = 0; index < source.length; index += 1) {
            const byte = source[index];
            const isAllowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
            if (byte < 0x20 && !isAllowedWhitespace) {
                offenders.push({ offset: index, byte: `0x${byte.toString(16)}` });
            }
        }
        expect(offenders).toEqual([]);
    });

    it('still fingerprints with a NUL separator — the escape is byte-identical', () => {
        // The separator marks where the joined NAMES end and the output
        // begins, so a name that swallows the head of an output cannot
        // hash the same as the pair it came from. Switching the literal
        // control character to an escape must not change that, or any
        // failure fingerprint already in the ledger stops matching.
        expect(computeCiFailureKey({ checkNames: ['lint'], output: 'x' })).not.toBe(
            computeCiFailureKey({ checkNames: ['lintx'], output: '' }),
        );
        expect(computeCiFailureKey({ checkNames: ['lint'], output: 'boom' })).toBe(
            createHash('sha256')
                .update(['lint', 'boom'].join(String.fromCharCode(0)))
                .digest('hex')
                .slice(0, 32),
        );
    });
});

describe('computeCiFailureKey', () => {
    it('is stable for the same failure and independent of job order or case', () => {
        expect(computeCiFailureKey({ checkNames: ['Lint', 'Unit'], output: 'boom' })).toBe(
            computeCiFailureKey({ checkNames: ['unit', 'lint'], output: 'boom' }),
        );
    });

    it('collapses whitespace, so a reflowed summary is still the same failure', () => {
        expect(computeCiFailureKey({ checkNames: ['lint'], output: 'a  b\n c' })).toBe(
            computeCiFailureKey({ checkNames: ['lint'], output: 'a b c' }),
        );
    });

    it('differs when the reported output differs — a NEW failure buys a new attempt', () => {
        expect(computeCiFailureKey({ checkNames: ['lint'], output: 'file A' })).not.toBe(
            computeCiFailureKey({ checkNames: ['lint'], output: 'file B' }),
        );
    });

    it('fits the varchar(64) column', () => {
        expect(computeCiFailureKey({ checkNames: ['lint'], output: 'x' })).toHaveLength(32);
    });
});

describe('decideCiHead', () => {
    const seenAt = new Date('2026-09-06T10:00:00Z');

    it('adopts the first head it ever sees', () => {
        expect(decideCiHead(null, { headSha: 'aaa', reportedAt: seenAt })).toBe('first-seen');
        expect(decideCiHead({ ciHeadSha: null }, { headSha: 'aaa', reportedAt: seenAt })).toBe(
            'first-seen',
        );
    });

    it('calls the same commit current', () => {
        expect(
            decideCiHead(
                { ciHeadSha: 'aaa', ciHeadSeenAt: seenAt },
                { headSha: 'aaa', reportedAt: seenAt },
            ),
        ).toBe('current');
    });

    describe('when the delivery carries the pull request head (the ordinary case)', () => {
        it('advances to the commit the provider says the pull request is at', () => {
            expect(
                decideCiHead(
                    { ciHeadSha: 'aaa', ciHeadSeenAt: seenAt },
                    { headSha: 'bbb', prHeadSha: 'bbb', reportedAt: seenAt },
                ),
            ).toBe('advanced');
        });

        /**
         * THE regression. A push's jobs finish at wildly different times,
         * so an old commit's slow job routinely completes AFTER the next
         * push has already reported its first check — and ordering by
         * timestamp then classified the dead commit as a new head, wrote
         * it back over `tasks.ciHeadSha`, and spent one of the Task's two
         * lifetime attempts fixing code nobody has any more. The pull
         * request's own head pointer settles it with no clock involved.
         */
        it('refuses a superseded commit whose slow job finished LATER than the new head was seen', () => {
            expect(
                decideCiHead(
                    // Commit B landed at 10:01 and was recorded then…
                    { ciHeadSha: 'bbb', ciHeadSeenAt: new Date('2026-09-06T10:01:00Z') },
                    {
                        // …and commit A's e2e shard, started before the
                        // push, only completed at 10:25.
                        headSha: 'aaa',
                        prHeadSha: 'bbb',
                        reportedAt: new Date('2026-09-06T10:25:00Z'),
                    },
                ),
            ).toBe('stale');
        });

        it('refuses a manual re-run of an old commit, however fresh its timestamp', () => {
            expect(
                decideCiHead(
                    { ciHeadSha: 'bbb', ciHeadSeenAt: seenAt },
                    {
                        headSha: 'aaa',
                        prHeadSha: 'bbb',
                        reportedAt: new Date('2026-09-09T00:00:00Z'),
                    },
                ),
            ).toBe('stale');
        });
    });

    describe('when there is no pull request head to check (forks, push-triggered runs)', () => {
        it('falls back to the provider clock', () => {
            expect(
                decideCiHead(
                    { ciHeadSha: 'aaa', ciHeadSeenAt: seenAt },
                    { headSha: 'bbb', reportedAt: new Date('2026-09-06T11:00:00Z') },
                ),
            ).toBe('advanced');
        });

        it('refuses a commit reported no later than the recorded one', () => {
            for (const reportedAt of [
                new Date('2026-09-06T09:00:00Z'),
                new Date('2026-09-06T10:00:00Z'),
            ]) {
                expect(
                    decideCiHead(
                        { ciHeadSha: 'aaa', ciHeadSeenAt: seenAt },
                        { headSha: 'bbb', reportedAt },
                    ),
                ).toBe('stale');
            }
        });

        /**
         * `isoOrNow` substitutes `now` for a missing or unparseable
         * provider timestamp so the ingest envelope is never rejected.
         * Handing that substitute to the head decision made every undated
         * delivery the newest thing in the comparison, i.e. ALWAYS
         * `advanced` — a permanent fail-open. The evaluator is given
         * `null` instead, and `null` is not evidence.
         */
        it('refuses a delivery that reported no usable time at all', () => {
            for (const reportedAt of [null, undefined, new Date('nonsense')]) {
                expect(
                    decideCiHead({ ciHeadSha: 'aaa', ciHeadSeenAt: seenAt }, {
                        headSha: 'bbb',
                        reportedAt,
                    } as never),
                ).toBe('stale');
            }
        });

        it('lets the newer sighting win when the recorded pair is half-written', () => {
            // Only reachable from a hand-edited row: this loop always
            // writes the sha and the time together. Refusing forever would
            // wedge the Task, so the new sighting is adopted.
            expect(
                decideCiHead(
                    { ciHeadSha: 'aaa', ciHeadSeenAt: null },
                    { headSha: 'bbb', reportedAt: seenAt },
                ),
            ).toBe('advanced');
        });
    });
});

describe('isPullRequestFinished', () => {
    it('is true for a merged or closed pull request, and for a landed branch', () => {
        expect(isPullRequestFinished({ prState: 'merged' })).toBe(true);
        expect(isPullRequestFinished({ prState: 'closed' })).toBe(true);
        expect(isPullRequestFinished({ branchState: 'merged' })).toBe(true);
        expect(isPullRequestFinished({ branchState: 'discarded' })).toBe(true);
    });

    it('is FALSE for a draft or open pull request — a red draft is exactly the case', () => {
        expect(isPullRequestFinished({ prState: 'draft' })).toBe(false);
        expect(isPullRequestFinished({ prState: 'open', branchState: 'pr-open' })).toBe(false);
        expect(isPullRequestFinished({})).toBe(false);
    });
});

describe('the text the model and the human read', () => {
    it('names the commit, the check and the limit of what the webhook knows', () => {
        const message = composeCiFailureFeedback({
            repoFullName: 'octo/site',
            headSha: 'abc123',
            checkName: 'lint-and-test',
            conclusion: 'failure',
            prNumber: 42,
            url: 'https://github.com/octo/site/runs/1',
            outputTitle: '1 failing test',
            outputSummary: 'login.spec.ts › renders',
        });
        expect(message).toContain('Continuous integration is RED for octo/site at commit abc123.');
        expect(message).toContain('Failing check: lint-and-test (failure).');
        expect(message).toContain('Pull request: #42.');
        expect(message).toContain('login.spec.ts');
        // Honest about its blind spot — a delivery carries the first red
        // result for a commit, not the full list.
        expect(message).toContain('not a full list');
        // …and closes the obvious wrong fix.
        expect(message).toContain('Do not disable, skip or weaken a check');
    });

    it('caps the stored feedback so one CI dump cannot blow the prompt', () => {
        const message = composeCiFailureFeedback({
            repoFullName: 'octo/site',
            headSha: 'abc123',
            checkName: 'lint',
            conclusion: 'failure',
            outputSummary: 'x'.repeat(50_000),
        });
        expect(message.length).toBeLessThanOrEqual(4000);
    });

    it('says which of the two stopping conditions ended the loop', () => {
        const spent = composeBudgetSpentNotice({
            taskTitle: 'Add the login button',
            reason: 'budget-spent',
            attemptsUsed: 2,
            maxAttempts: 2,
            repoFullName: 'octo/site',
            prNumber: 42,
            headSha: 'abc123',
        });
        expect(spent.title).toContain('Add the login button');
        expect(spent.body).toContain('2 of 2 attempts used');
        expect(spent.body).toContain('octo/site#42');

        const repeat = composeBudgetSpentNotice({
            taskTitle: 'Add the login button',
            reason: 'repeat-failure',
            attemptsUsed: 1,
            maxAttempts: 2,
        });
        expect(repeat.body).toContain('came back unchanged');
        // Both reasons promise a hard stop, and the evaluator now keeps
        // that promise (the notice marker IS the stop flag). The count is
        // stated either way so the owner can see how much of the budget
        // was actually spent.
        expect(repeat.body).toContain('1 of 2 attempts used');
        expect(repeat.body).toContain('Nothing further will be retried automatically');
        expect(spent.body).toContain('Nothing further will be retried automatically');
    });
});
