jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    GitHubAppUserLinkRepository: class {},
}));
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));

import { DependabotIncidentSource } from '../incidents/dependabot-incident.source';
import {
    GITHUB_ISSUE_EVENT_KIND,
    GitHubIssueIntakeService,
    normalizeGitHubIssue,
} from './github-issue-intake.service';

const BINDING = { userId: 'user-1', webhookSecret: 'sec', matchedBy: 'binding' as const };

function issueBody(
    overrides: Record<string, unknown> = {},
    issueOverrides: Record<string, unknown> = {},
) {
    return {
        action: 'opened',
        repository: { full_name: 'octo/site', html_url: 'https://github.com/octo/site' },
        sender: { login: 'octocat', type: 'User' },
        issue: {
            number: 42,
            title: 'Login button does nothing on Safari',
            body: 'Steps: open /login on Safari 17, click Sign in. Nothing happens.',
            html_url: 'https://github.com/octo/site/issues/42',
            state: 'open',
            created_at: '2026-09-01T09:00:00Z',
            updated_at: '2026-09-01T09:00:00Z',
            user: { login: 'reporter', type: 'User' },
            labels: [{ name: 'bug' }, { name: 'frontend' }],
            assignees: [{ login: 'ada' }],
            ...issueOverrides,
        },
        ...overrides,
    };
}

describe('normalizeGitHubIssue', () => {
    it('turns an opened issue into a github.issue envelope with the stable issue id as subject', () => {
        const envelope = normalizeGitHubIssue(issueBody());
        expect(envelope).toMatchObject({
            source: 'github',
            kind: GITHUB_ISSUE_EVENT_KIND,
            sourceEventId: 'issue:octo/site#42@opened:2026-09-01T09:00:00.000Z',
            occurredAt: '2026-09-01T09:00:00.000Z',
            actor: { name: 'octocat' },
            subject: {
                type: 'issue',
                externalId: 'octo/site#42',
                title: 'Login button does nothing on Safari',
            },
            workHint: { kind: 'repo', externalId: 'octo/site' },
            sourceUrl: 'https://github.com/octo/site/issues/42',
            payload: {
                action: 'opened',
                repoFullName: 'octo/site',
                issueNumber: 42,
                title: 'Login button does nothing on Safari',
                state: 'open',
                labels: ['bug', 'frontend'],
                assignees: ['ada'],
                author: 'reporter',
                url: 'https://github.com/octo/site/issues/42',
                body: 'Steps: open /login on Safari 17, click Sign in. Nothing happens.',
                createdAt: '2026-09-01T09:00:00.000Z',
                updatedAt: '2026-09-01T09:00:00.000Z',
            },
        });
    });

    it.each(['reopened', 'closed', 'labeled', 'unlabeled', 'assigned', 'unassigned'])(
        'ingests the %s action as a new revision of the SAME issue',
        (action) => {
            const opened = normalizeGitHubIssue(issueBody());
            const later = normalizeGitHubIssue(
                issueBody(
                    { action, label: { name: 'triage' }, assignee: { login: 'ada' } },
                    { updated_at: '2026-09-01T10:00:00Z' },
                ),
            );
            expect(later?.subject?.externalId).toBe(opened?.subject?.externalId);
            expect(later?.sourceEventId).not.toBe(opened?.sourceEventId);
            expect(later?.payload.action).toBe(action);
        },
    );

    it('distinguishes two labels applied in the same second by carrying the label in the revision', () => {
        const bug = normalizeGitHubIssue(issueBody({ action: 'labeled', label: { name: 'bug' } }));
        const p1 = normalizeGitHubIssue(issueBody({ action: 'labeled', label: { name: 'p1' } }));
        expect(bug?.sourceEventId).toBe('issue:octo/site#42@labeled:bug:2026-09-01T09:00:00.000Z');
        expect(p1?.sourceEventId).toBe('issue:octo/site#42@labeled:p1:2026-09-01T09:00:00.000Z');
        expect(bug?.payload.label).toBe('bug');
    });

    it('is deterministic for an exact redelivery, so the spine dedupes it to zero', () => {
        expect(normalizeGitHubIssue(issueBody())?.sourceEventId).toBe(
            normalizeGitHubIssue(issueBody())?.sourceEventId,
        );
    });

    it('ingests a title edit (with the previous title) but ignores a body-only edit', () => {
        const titled = normalizeGitHubIssue(
            issueBody({ action: 'edited', changes: { title: { from: 'Old title' } } }),
        );
        expect(titled?.payload.previousTitle).toBe('Old title');

        expect(
            normalizeGitHubIssue(
                issueBody({ action: 'edited', changes: { body: { from: 'old body' } } }),
            ),
        ).toBeNull();
    });

    it('skips pull-request threads — the PR path owns those', () => {
        expect(
            normalizeGitHubIssue(
                issueBody(
                    {},
                    { pull_request: { url: 'https://api.github.com/repos/octo/site/pulls/42' } },
                ),
            ),
        ).toBeNull();
    });

    it('ignores actions outside the intake lifecycle', () => {
        for (const action of [
            'pinned',
            'milestoned',
            'transferred',
            'deleted',
            'locked',
            undefined,
        ]) {
            expect(normalizeGitHubIssue(issueBody({ action }))).toBeNull();
        }
    });

    it('refuses a delivery without a repository or an issue number', () => {
        expect(normalizeGitHubIssue(issueBody({ repository: {} }))).toBeNull();
        expect(normalizeGitHubIssue(issueBody({}, { number: undefined }))).toBeNull();
        expect(normalizeGitHubIssue({ action: 'opened' })).toBeNull();
    });

    it('caps the body, title and id at the ingested_events column widths', () => {
        const envelope = normalizeGitHubIssue(
            issueBody({}, { title: 't'.repeat(900), body: 'b'.repeat(10_000) }),
        );
        expect(envelope?.subject?.title).toHaveLength(500);
        expect((envelope?.payload.title as string).length).toBe(500);
        expect((envelope?.payload.body as string).length).toBe(4000);
        expect(envelope?.sourceEventId.length).toBeLessThanOrEqual(200);
    });

    /**
     * `actorName` and `subjectExternalId` are varchar(200). An overflow
     * fails the INSERT, which on this public receiver is a 500 GitHub
     * redelivers rather than a filed issue — so the width is enforced
     * here rather than inferred from GitHub's own naming limits.
     */
    it('⭐ keeps an over-long sender login and repo name inside the column widths', () => {
        const envelope = normalizeGitHubIssue(
            issueBody({
                repository: { full_name: `octo/${'r'.repeat(400)}` },
                sender: { login: 'l'.repeat(400) },
            }),
        );
        expect(envelope?.actor?.name).toHaveLength(200);
        expect(envelope?.subject?.externalId).toHaveLength(200);
    });

    it('keeps a malformed provider timestamp from reaching the spine', () => {
        const envelope = normalizeGitHubIssue(issueBody({}, { updated_at: 'not a date' }));
        expect(Number.isNaN(Date.parse(envelope?.occurredAt ?? ''))).toBe(false);
    });

    it('drops a non-https issue link instead of persisting it', () => {
        const envelope = normalizeGitHubIssue(issueBody({}, { html_url: 'javascript:alert(1)' }));
        expect(envelope?.sourceUrl).toBeUndefined();
        expect(envelope?.payload.url).toBeUndefined();
    });
});

describe('GitHubIssueIntakeService', () => {
    function createService() {
        const dispatcher = { registerConsumer: jest.fn() };
        const ingest = {
            ingest: jest
                .fn()
                .mockResolvedValue({ inserted: 1, duplicates: 0, rejected: 0, filtered: 0 }),
        };
        const service = new GitHubIssueIntakeService(
            dispatcher as never,
            ingest as never,
            new DependabotIncidentSource(),
        );
        return { service, dispatcher, ingest };
    }

    it('registers itself on the ONE GitHub receiver for issues + dependabot_alert at boot', () => {
        const { service, dispatcher } = createService();
        service.onModuleInit();
        expect(dispatcher.registerConsumer).toHaveBeenCalledWith(service);
        expect(service.events).toEqual(['issues', 'dependabot_alert']);
    });

    it('ingests an issues delivery under the BINDING owner — never a user named in the payload', async () => {
        const { service, ingest } = createService();
        const body = issueBody({ owner: { id: 'user-attacker' }, user_id: 'user-attacker' });

        const result = await service.handle(BINDING, 'issues', body as never);

        expect(result.ingested).toEqual({ inserted: 1, duplicates: 0, rejected: 0, filtered: 0 });
        expect(ingest.ingest).toHaveBeenCalledTimes(1);
        const [userId, envelopes] = ingest.ingest.mock.calls[0];
        expect(userId).toBe('user-1');
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0]).toMatchObject({ kind: GITHUB_ISSUE_EVENT_KIND });
    });

    it('routes a dependabot_alert delivery through the Dependabot incident source', async () => {
        const { service, ingest } = createService();
        const body = {
            action: 'created',
            repository: { full_name: 'octo/site' },
            alert: {
                number: 7,
                state: 'open',
                html_url: 'https://github.com/octo/site/security/dependabot/7',
                updated_at: '2026-09-01T10:00:00Z',
                dependency: { package: { ecosystem: 'npm', name: 'lodash' } },
                security_advisory: { summary: 'Prototype pollution', severity: 'high' },
            },
        };

        await service.handle(BINDING, 'dependabot_alert', body as never);

        const [, envelopes] = ingest.ingest.mock.calls[0];
        expect(envelopes[0]).toMatchObject({
            kind: 'incident',
            subject: { externalId: 'octo/site#dependabot-7' },
            payload: { provider: 'dependabot', level: 'high' },
        });
    });

    it('reports a redelivery as a duplicate without a second insert', async () => {
        const { service, ingest } = createService();
        ingest.ingest.mockResolvedValueOnce({
            inserted: 0,
            duplicates: 1,
            rejected: 0,
            filtered: 0,
        });

        const result = await service.handle(BINDING, 'issues', issueBody() as never);

        expect(result.ingested?.duplicates).toBe(1);
        expect(result.ingested?.inserted).toBe(0);
    });

    it('files nothing for a delivery the normalizer skips (PR thread, unknown action, other event)', async () => {
        const { service, ingest } = createService();

        await expect(
            service.handle(
                BINDING,
                'issues',
                issueBody({}, { pull_request: { url: 'x' } }) as never,
            ),
        ).resolves.toEqual({ ingested: null });
        await expect(
            service.handle(BINDING, 'issues', issueBody({ action: 'pinned' }) as never),
        ).resolves.toEqual({ ingested: null });
        await expect(service.handle(BINDING, 'push', {} as never)).resolves.toEqual({
            ingested: null,
        });
        expect(ingest.ingest).not.toHaveBeenCalled();
    });

    it('lets an ingest failure surface so the receiver can 500 and GitHub redelivers', async () => {
        const { service, ingest } = createService();
        ingest.ingest.mockRejectedValue(new Error('db down'));
        await expect(service.handle(BINDING, 'issues', issueBody() as never)).rejects.toThrow(
            'db down',
        );
    });
});
