jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    GitHubAppUserLinkRepository: class {},
}));
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
// The intake reaches tasks-domain for the evaluator and two pure
// helpers. Mocking the subpath keeps this unit suite off
// TasksDomainModule's import graph (facades → agent-plugins → …); the
// REAL evaluator is driven end to end by the sibling
// `*.autoresume.integration.spec.ts`.
// The intake reaches tasks-domain for the evaluator and two pure
// helpers. Mocking the subpath keeps this unit suite off
// TasksDomainModule's import graph (facades → agent-plugins → …); the
// REAL evaluator is driven end to end by the sibling
// `*.autoresume.integration.spec.ts`.
//
// The two HELPERS are the real ones, pulled straight from the pure policy
// leaf (its only import is `node:crypto`, so it drags nothing). They used
// to be hand-copied into this factory, which made the test named
// "classifies conclusions the way the board rollup does" assert the copy
// rather than production — and the copy had already drifted: it compared
// `status` without lower-casing, so `{status: 'COMPLETED', conclusion:
// 'FAILURE'}` was `pending` here and `failing` in the shipped classifier.
// A test that pins a copy of the code cannot fail when the code changes,
// which is the whole point of having it.
jest.mock('@ever-works/agent/tasks-domain', () => {
    const policy = jest.requireActual(
        '../../../../../packages/agent/src/tasks-domain/task-ci-auto-resume',
    );
    return {
        TaskCiAutoResumeService: class {},
        classifyCheckResult: policy.classifyCheckResult,
        computeCiFailureKey: policy.computeCiFailureKey,
    };
});

import {
    GITHUB_CHECK_EVENT_KIND,
    GITHUB_CHECK_EVENTS,
    GITHUB_REVIEW_EVENTS,
    GitHubCheckIntakeService,
    isReviewFeedbackDelivery,
    normalizeGitHubCheck,
} from './github-check-intake.service';

const HEAD = '9f3c1a2b9f3c1a2b9f3c1a2b9f3c1a2b9f3c1a2b';

function checkRunBody(
    overrides: Record<string, unknown> & { check_run?: Record<string, unknown> } = {},
) {
    // `check_run` is MERGED, everything else replaces — spreading the
    // overrides last would silently blank the nested payload and make
    // every "these ids differ" assertion pass for the wrong reason.
    const { check_run: runOverrides, ...rest } = overrides;
    return {
        action: 'completed',
        repository: { full_name: 'octo/site', owner: { login: 'octo' } },
        sender: { login: 'github-actions[bot]', type: 'Bot' },
        ...rest,
        check_run: {
            id: 4815162342,
            name: 'lint-and-test',
            status: 'completed',
            conclusion: 'failure' as string | null | undefined,
            head_sha: HEAD as string | undefined,
            html_url: 'https://github.com/octo/site/runs/4815162342',
            started_at: '2026-09-06T10:00:00Z',
            completed_at: '2026-09-06T10:05:00Z',
            app: { slug: 'github-actions' },
            output: {
                title: '1 failing test',
                summary: 'apps/web login.spec.ts › renders — expected true, received false',
            },
            check_suite: { id: 9, head_branch: 'task/t-42-9f3c1a2b', head_sha: HEAD } as {
                id: number;
                head_branch: string | null;
                head_sha: string;
            },
            pull_requests: [{ number: 42 }] as Array<{ number: number }>,
            ...runOverrides,
        },
    };
}

describe('normalizeGitHubCheck', () => {
    it('turns a failing check_run into a github.check envelope keyed on the head commit', () => {
        const normalized = normalizeGitHubCheck('check_run', checkRunBody() as never);
        expect(normalized?.envelope).toMatchObject({
            source: 'github',
            kind: GITHUB_CHECK_EVENT_KIND,
            sourceEventId: `check:octo/site@${HEAD}:run:4815162342:completed:failure`,
            occurredAt: '2026-09-06T10:05:00.000Z',
            actor: { name: 'github-actions[bot]' },
            subject: {
                type: 'check',
                externalId: `octo/site@${HEAD}`,
                title: 'lint-and-test: failure',
            },
            workHint: { kind: 'repo', externalId: 'octo/site' },
            sourceUrl: 'https://github.com/octo/site/runs/4815162342',
            payload: {
                granularity: 'check_run',
                repoFullName: 'octo/site',
                headSha: HEAD,
                headBranch: 'task/t-42-9f3c1a2b',
                status: 'completed',
                conclusion: 'failure',
                verdict: 'failing',
                name: 'lint-and-test',
                pullRequests: [42],
                outputTitle: '1 failing test',
            },
        });
        expect(normalized?.signal).toMatchObject({
            owner: 'octo',
            repo: 'site',
            headSha: HEAD,
            headBranch: 'task/t-42-9f3c1a2b',
            prNumbers: [42],
            verdict: 'failing',
            granularity: 'check_run',
            checkName: 'lint-and-test',
            conclusion: 'failure',
        });
        expect(normalized?.signal.failureKey).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    });

    /**
     * The dedupe contract, stated as three facts about one id. This is
     * the whole of the spine's protection against a redelivered check
     * result being counted twice, and against a genuine re-run being
     * swallowed as one.
     */
    describe('sourceEventId', () => {
        const idOf = (body: unknown) =>
            normalizeGitHubCheck('check_run', body as never)?.envelope.sourceEventId;

        it('is IDENTICAL for a byte-identical redelivery', () => {
            expect(idOf(checkRunBody())).toBe(idOf(checkRunBody()));
        });

        it('DIFFERS when the same job moves from queued to completed', () => {
            expect(
                idOf(checkRunBody({ check_run: { status: 'queued', conclusion: null } })),
            ).not.toBe(idOf(checkRunBody()));
        });

        it('DIFFERS for a RE-RUN of the same commit (a new check_run id)', () => {
            expect(idOf(checkRunBody({ check_run: { id: 999 } }))).not.toBe(idOf(checkRunBody()));
        });

        it('DIFFERS for a new workflow run_attempt on the same commit', () => {
            const workflow = (attempt: number) =>
                normalizeGitHubCheck('workflow_run', {
                    repository: { full_name: 'octo/site' },
                    workflow_run: {
                        id: 77,
                        name: 'CI',
                        status: 'completed',
                        conclusion: 'failure',
                        head_sha: HEAD,
                        run_attempt: attempt,
                        updated_at: '2026-09-06T10:07:00Z',
                    },
                } as never)?.envelope.sourceEventId;
            expect(workflow(1)).not.toBe(workflow(2));
        });
    });

    it('reads a check_suite, which carries no per-job output and no page link', () => {
        const normalized = normalizeGitHubCheck('check_suite', {
            action: 'completed',
            repository: { full_name: 'octo/site' },
            check_suite: {
                id: 9,
                status: 'completed',
                conclusion: 'failure',
                head_sha: HEAD,
                head_branch: 'task/t-42',
                updated_at: '2026-09-06T10:06:00Z',
                app: { slug: 'github-actions' },
                pull_requests: [{ number: 42 }],
            },
        } as never);
        expect(normalized?.envelope.sourceEventId).toBe(
            `check:octo/site@${HEAD}:suite:9:completed:failure`,
        );
        expect(normalized?.envelope.sourceUrl).toBeUndefined();
        expect(normalized?.signal.outputSummary).toBeNull();
        expect(normalized?.signal.verdict).toBe('failing');
    });

    it('classifies conclusions the way the board rollup does', () => {
        const verdictOf = (status: string, conclusion: string | null) =>
            normalizeGitHubCheck(
                'check_run',
                checkRunBody({ check_run: { status, conclusion } }) as never,
            )?.signal.verdict;

        expect(verdictOf('completed', 'failure')).toBe('failing');
        expect(verdictOf('completed', 'timed_out')).toBe('failing');
        expect(verdictOf('completed', 'action_required')).toBe('failing');
        expect(verdictOf('completed', 'success')).toBe('passing');
        // A human stopping a job, or a job that decided it had nothing to
        // do, is not something to spend a model run fixing.
        expect(verdictOf('completed', 'cancelled')).toBe('inconclusive');
        expect(verdictOf('completed', 'neutral')).toBe('inconclusive');
        expect(verdictOf('completed', 'skipped')).toBe('inconclusive');
        expect(verdictOf('completed', 'stale')).toBe('inconclusive');
        // Completed with no verdict is never laundered into a pass.
        expect(verdictOf('completed', null)).toBe('inconclusive');
    });

    /**
     * CONTRACT CHANGE, deliberate: this used to assert
     * `verdictOf('in_progress', 'failure') === 'pending'`, i.e. that an
     * unfinished check produced a normalized envelope carrying a
     * `pending` verdict. It no longer produces one at all.
     *
     * The old behaviour ingested a durable row for EVERY state
     * transition, and each ingested row costs a REQUIRED activity_log
     * write plus an `AgentMemoryFacadeService.saveMemory` call that is a
     * paid embedding wherever a memory provider is configured. This
     * repo's `ci.yml` runs ~15 job instances per pull request push, each
     * announcing `queued` → `in_progress` → `completed`, with the suite
     * and workflow events restating every transition: roughly half of the
     * resulting tens of thousands of rows a day carried no verdict
     * anything reads. `classifyCheckResult`'s `pending` rule is unchanged
     * and still unit-tested next to the function; what changed is that
     * the intake stops before building an envelope for one.
     */
    it('produces NOTHING for a check that has not completed', () => {
        expect(
            normalizeGitHubCheck(
                'check_run',
                checkRunBody({
                    check_run: { status: 'in_progress', conclusion: 'failure' },
                }) as never,
            ),
        ).toBeNull();
        expect(
            normalizeGitHubCheck(
                'check_run',
                checkRunBody({ check_run: { status: 'queued', conclusion: null } }) as never,
            ),
        ).toBeNull();
        // …but every COMPLETED verdict, green and inconclusive included,
        // is still ingested: the board and the inbound trigger matcher
        // read those.
        for (const conclusion of ['success', 'cancelled', 'failure']) {
            expect(
                normalizeGitHubCheck(
                    'check_run',
                    checkRunBody({ check_run: { conclusion } }) as never,
                ),
            ).not.toBeNull();
        }
    });

    it('carries no failureKey for anything that is not a failure', () => {
        expect(
            normalizeGitHubCheck(
                'check_run',
                checkRunBody({ check_run: { conclusion: 'success' } }) as never,
            )?.signal.failureKey,
        ).toBeNull();
    });

    it('survives a fork pull request: no branch, no PR numbers, still a head commit', () => {
        const normalized = normalizeGitHubCheck(
            'check_run',
            checkRunBody({
                check_run: {
                    pull_requests: [],
                    check_suite: { id: 9, head_branch: null, head_sha: HEAD },
                },
            }) as never,
        );
        expect(normalized?.signal).toMatchObject({ headBranch: null, prNumbers: [] });
        expect(normalized?.signal.headSha).toBe(HEAD);
    });

    it('returns null for a delivery with no head commit, no repository, or an unknown event', () => {
        expect(
            normalizeGitHubCheck(
                'check_run',
                checkRunBody({ check_run: { head_sha: undefined } }) as never,
            ),
        ).toBeNull();
        expect(
            normalizeGitHubCheck('check_run', { check_run: { head_sha: HEAD } } as never),
        ).toBeNull();
        expect(normalizeGitHubCheck('pull_request', checkRunBody() as never)).toBeNull();
    });
});

describe('isReviewFeedbackDelivery', () => {
    const POLICY = {
        trusted: new Set(['coderabbitai[bot]']),
        self: new Set(['ever-works[bot]']),
    };
    const human = { login: 'evereq', type: 'User' };

    it('accepts only the shapes the review bridge records a rejection for', () => {
        expect(
            isReviewFeedbackDelivery(
                'pull_request_review',
                { review: { state: 'changes_requested', user: human } } as never,
                POLICY,
            ),
        ).toBe(true);
        expect(
            isReviewFeedbackDelivery(
                'pull_request_review',
                { review: { state: 'approved', user: human } } as never,
                POLICY,
            ),
        ).toBe(false);
        expect(
            isReviewFeedbackDelivery(
                'pull_request_review_comment',
                {
                    action: 'created',
                    pull_request: { number: 42 },
                    comment: { user: human },
                } as never,
                POLICY,
            ),
        ).toBe(true);
        expect(
            isReviewFeedbackDelivery(
                'pull_request_review_comment',
                {
                    action: 'edited',
                    pull_request: { number: 42 },
                    comment: { user: human },
                } as never,
                POLICY,
            ),
        ).toBe(false);
        // A PR thread reports as an issue; a PLAIN issue comment is not
        // about a pull request and must not cost a Task lookup.
        expect(
            isReviewFeedbackDelivery(
                'issue_comment',
                {
                    action: 'created',
                    issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
                    comment: { user: human },
                } as never,
                POLICY,
            ),
        ).toBe(true);
        expect(
            isReviewFeedbackDelivery(
                'issue_comment',
                { action: 'created', issue: { number: 42 }, comment: { user: human } } as never,
                POLICY,
            ),
        ).toBe(false);
        expect(isReviewFeedbackDelivery('push', {} as never, POLICY)).toBe(false);
    });

    /**
     * The doorbell used to check only `action === 'created'` and the
     * PR-thread shape, never the author — so the platform's OWN bot
     * comment on the pull request (a status update, the PR link the fleet
     * posts) was a valid trigger, and the loop could wake itself and
     * spend a model run echoing its own output. The PR-review bridge
     * refuses `self` and `untrusted-bot` before it records anything;
     * this consumer has to make the same judgement rather than inherit it.
     */
    it('refuses the platform’s own identity and any untrusted bot', () => {
        const thread = {
            action: 'created',
            issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
        };
        for (const user of [
            { login: 'ever-works[bot]', type: 'Bot' },
            { login: 'dependabot[bot]', type: 'Bot' },
            { login: 'github-actions[bot]', type: 'Bot' },
        ]) {
            expect(
                isReviewFeedbackDelivery(
                    'issue_comment',
                    { ...thread, comment: { user } } as never,
                    POLICY,
                ),
            ).toBe(false);
        }
        // …an allow-listed reviewer bot still rings it.
        expect(
            isReviewFeedbackDelivery(
                'issue_comment',
                {
                    ...thread,
                    comment: { user: { login: 'coderabbitai[bot]', type: 'Bot' } },
                } as never,
                POLICY,
            ),
        ).toBe(true);
    });

    it('refuses a `changes_requested` review submitted by the platform itself', () => {
        expect(
            isReviewFeedbackDelivery(
                'pull_request_review',
                {
                    review: {
                        state: 'changes_requested',
                        user: { login: 'ever-works[bot]', type: 'Bot' },
                    },
                } as never,
                POLICY,
            ),
        ).toBe(false);
    });
});

describe('GitHubCheckIntakeService (consumer wiring)', () => {
    it('registers itself on the ONE dispatcher for the CI and reviewer deliveries', () => {
        const dispatcher = { registerConsumer: jest.fn() };
        const service = new GitHubCheckIntakeService(dispatcher as never, {} as never);
        service.onModuleInit();
        expect(dispatcher.registerConsumer).toHaveBeenCalledWith(service);
        // Miss one of these names and the feature half-ships in silence:
        // the dispatcher's `consumer.events.includes(eventName)` simply
        // never matches and nothing errors.
        expect(service.events).toEqual([
            'check_run',
            'check_suite',
            'workflow_run',
            'pull_request_review',
            'issue_comment',
            'pull_request_review_comment',
        ]);
        expect([...GITHUB_CHECK_EVENTS, ...GITHUB_REVIEW_EVENTS]).toEqual(service.events);
    });

    it('ingests the envelope and resumes nothing when no evaluator is bound', async () => {
        const ingest = jest.fn().mockResolvedValue({
            inserted: 1,
            duplicates: 0,
            rejected: 0,
            filtered: 0,
        });
        const service = new GitHubCheckIntakeService(
            { registerConsumer: jest.fn() } as never,
            { ingest } as never,
        );
        const result = await service.handle(
            { userId: 'u1', webhookSecret: 's', matchedBy: 'binding' },
            'check_run',
            checkRunBody() as never,
        );
        expect(ingest).toHaveBeenCalledTimes(1);
        expect(result.ingested).toMatchObject({ inserted: 1 });
        expect(result.autoResume).toBeUndefined();
    });

    it('skips the evaluator on a confirmed redelivery, but not on a salience drop', async () => {
        const onCheckResult = jest.fn().mockResolvedValue({ reason: 'no-task' });
        const ingest = jest
            .fn()
            .mockResolvedValueOnce({ inserted: 0, duplicates: 1, rejected: 0, filtered: 0 })
            .mockResolvedValueOnce({ inserted: 0, duplicates: 0, rejected: 0, filtered: 1 });
        const service = new GitHubCheckIntakeService(
            { registerConsumer: jest.fn() } as never,
            { ingest } as never,
            { onCheckResult } as never,
        );
        const binding = { userId: 'u1', webhookSecret: 's', matchedBy: 'binding' as const };

        await service.handle(binding, 'check_run', checkRunBody() as never);
        expect(onCheckResult).not.toHaveBeenCalled();

        // A filtered envelope is NOT a duplicate: an operator's salience
        // configuration must not be able to switch the fix loop off.
        await service.handle(binding, 'check_run', checkRunBody() as never);
        expect(onCheckResult).toHaveBeenCalledTimes(1);
        expect(onCheckResult).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
    });
});
