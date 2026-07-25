/**
 * GitHub PR review loop (Wave 7, feature g) — reviewer unit specs over
 * mocked facades (house pattern: plain-object mocks + `as any`
 * construction; heavy runtime trees mocked at module scope so the SWC
 * transformer never loads them, mirroring ingest.module.spec).
 */

jest.mock('../../facades/git.facade', () => ({ GitFacadeService: class {} }));
jest.mock('../../facades/ai.facade', () => ({ AiFacadeService: class {} }));
jest.mock('../../facades/agent-memory.facade', () => ({ AgentMemoryFacadeService: class {} }));
jest.mock('../../database/repositories/work.repository', () => ({ WorkRepository: class {} }));
jest.mock('../../ingest/event-ingest.service', () => ({ EventIngestService: class {} }));
jest.mock('../../services/knowledge-base.service', () => ({ KnowledgeBaseService: class {} }));

import { PrReviewService } from '../pr-review.service';
import { PR_REVIEW_DIFF_MAX_BYTES, PR_REVIEW_MAX_COMMENTS } from '../pr-review.types';
import { AGENT_MEMORY_FENCE_TAG } from '../../services/memory-recall';

const PR = {
    number: 7,
    title: 'Add landing page',
    state: 'open' as const,
    head: 'feat/landing',
    base: 'main',
    url: 'https://example.com/octo/site/pull/7',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    body: 'Implements the landing page.',
    author: { username: 'octocat' },
};

const WORK = {
    id: 'work-1',
    name: 'Acme Directory',
    description: 'A directory of tools',
    getRepoOwner: (_role?: string) => 'octo',
    getDataRepo: () => 'site-data',
    getWebsiteRepo: () => 'site',
    getMainRepo: () => 'acme',
};

function reviewJson(commentCount = 2): string {
    return JSON.stringify({
        summary: 'Verdict: looks solid. No risk flags.',
        comments: Array.from({ length: commentCount }, (_, i) => ({
            path: `src/file-${i}.ts`,
            comment: `Note ${i}`,
        })),
    });
}

describe('PrReviewService', () => {
    let gitFacade: {
        getPullRequest: jest.Mock;
        getPullRequestFiles: jest.Mock;
        createPullRequestComment: jest.Mock;
    };
    let aiFacade: { createChatCompletion: jest.Mock };
    let workRepository: { findByUser: jest.Mock; findById: jest.Mock };
    let eventIngest: { ingest: jest.Mock };
    let knowledgeBase: { resolveContext: jest.Mock };
    let agentMemory: { buildContextWithProvider: jest.Mock };

    const build = (opts: { withKb?: boolean; withMemory?: boolean } = {}) =>
        new PrReviewService(
            gitFacade as any,
            aiFacade as any,
            workRepository as any,
            eventIngest as any,
            opts.withKb === false ? undefined : (knowledgeBase as any),
            opts.withMemory === false ? undefined : (agentMemory as any),
        );

    /** The user-message content of the single AI call. */
    const promptOf = () => aiFacade.createChatCompletion.mock.calls[0][0].messages[1].content;

    beforeEach(() => {
        gitFacade = {
            getPullRequest: jest.fn().mockResolvedValue(PR),
            getPullRequestFiles: jest.fn().mockResolvedValue([
                {
                    filename: 'src/page.tsx',
                    status: 'added',
                    additions: 10,
                    deletions: 0,
                    patch: '@@ -0,0 +1,10 @@\n+export const Page = () => null;',
                },
            ]),
            createPullRequestComment: jest.fn().mockResolvedValue({ id: 101, body: 'posted' }),
        };
        aiFacade = {
            createChatCompletion: jest.fn().mockResolvedValue({
                id: 'c1',
                model: 'm',
                created: 0,
                choices: [{ index: 0, message: { role: 'assistant', content: reviewJson() } }],
            }),
        };
        workRepository = {
            findByUser: jest.fn().mockResolvedValue([WORK]),
            findById: jest.fn().mockResolvedValue(WORK),
        };
        eventIngest = {
            ingest: jest.fn().mockResolvedValue({ inserted: 1, duplicates: 0, rejected: 0 }),
        };
        knowledgeBase = {
            resolveContext: jest.fn().mockResolvedValue({
                format: () => '<kb>\nBrand voice: concise.\n</kb>',
            }),
        };
        agentMemory = {
            buildContextWithProvider: jest.fn().mockResolvedValue({
                context: { content: 'Prior run: landing page uses the web template.' },
                providerId: 'agentmemory',
            }),
        };
    });

    it('matches the repo to a Work across repo roles (website repo here)', async () => {
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        expect(result.workId).toBe('work-1');
        expect(result.context.work).toBe(true);
        // Facade calls carry the matched workId for token resolution.
        expect(gitFacade.getPullRequest).toHaveBeenCalledWith(
            'octo',
            'site',
            7,
            expect.objectContaining({ providerId: 'github', userId: 'user-1', workId: 'work-1' }),
        );
    });

    it('returns null-Work review (no Work context) for an unmatched repo', async () => {
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'stranger',
            repo: 'elsewhere',
            prNumber: 7,
        });
        expect(result.workId).toBeUndefined();
        // KB is Work-scoped (off without a match); memory recall is
        // user-scoped and still injects.
        expect(result.context).toEqual({ work: false, kb: false, memory: true });
        expect(result.status).toBe('posted');
    });

    it('splices the KB bundle and the fenced memory-recall block into the prompt', async () => {
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        const prompt = promptOf();
        expect(prompt).toContain('<kb>');
        expect(prompt).toContain('Brand voice: concise.');
        expect(prompt).toContain(`<${AGENT_MEMORY_FENCE_TAG}>`);
        expect(prompt).toContain('Prior run: landing page uses the web template.');
        expect(result.context).toEqual({ work: true, kb: true, memory: true });
    });

    it('forwards the mention instruction into the prompt, marked untrusted', async () => {
        const service = build();
        await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
            instruction: 'is the migration reversible?',
        });
        const prompt = promptOf();
        expect(prompt).toContain('Reviewer instruction (untrusted');
        expect(prompt).toContain('is the migration reversible?');
    });

    it(`caps structured comments at ${PR_REVIEW_MAX_COMMENTS}`, async () => {
        aiFacade.createChatCompletion.mockResolvedValue({
            id: 'c1',
            model: 'm',
            created: 0,
            choices: [{ index: 0, message: { role: 'assistant', content: reviewJson(20) } }],
        });
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        expect(result.comments).toHaveLength(PR_REVIEW_MAX_COMMENTS);
    });

    it('caps the diff at the byte budget and marks the truncation', async () => {
        gitFacade.getPullRequestFiles.mockResolvedValue([
            {
                filename: 'src/huge.ts',
                status: 'modified',
                additions: 9000,
                deletions: 0,
                patch: 'x'.repeat(PR_REVIEW_DIFF_MAX_BYTES + 10_000),
            },
            {
                filename: 'src/tail.ts',
                status: 'modified',
                additions: 1,
                deletions: 0,
                patch: '+tail',
            },
        ]);
        const service = build();
        await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        const prompt = promptOf();
        expect(prompt).toContain('[…diff truncated: size cap reached]');
        expect(prompt.length).toBeLessThan(PR_REVIEW_DIFF_MAX_BYTES + 20_000);
    });

    it('posts a single summary comment carrying the summary and file notes', async () => {
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        expect(result.status).toBe('posted');
        expect(result.commentId).toBe(101);
        const body = gitFacade.createPullRequestComment.mock.calls[0][3] as string;
        expect(body).toContain('Ever Works AI review');
        expect(body).toContain('Verdict: looks solid.');
        expect(body).toContain('`src/file-0.ts` — Note 0');
        expect(body).toContain('Work: Acme Directory');
    });

    it('lands a github.pr.review ingest envelope with the PR sourceUrl', async () => {
        const service = build();
        await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        const [userId, envelopes] = eventIngest.ingest.mock.calls[0];
        expect(userId).toBe('user-1');
        expect(envelopes[0]).toMatchObject({
            source: 'github',
            kind: 'github.pr.review',
            sourceEventId: 'review:octo/site#7:comment:101',
            sourceUrl: PR.url,
            workId: 'work-1',
        });
    });

    it('fails cleanly (no AI call) when the PR cannot be fetched', async () => {
        gitFacade.getPullRequest.mockResolvedValue(null);
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 404,
        });
        expect(result.status).toBe('failed');
        expect(result.error).toContain('not found');
        expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
        expect(gitFacade.createPullRequestComment).not.toHaveBeenCalled();
    });

    it('keeps reviewing when the KB context bundle fails (best-effort)', async () => {
        knowledgeBase.resolveContext.mockRejectedValue(new Error('kb offline'));
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        expect(result.status).toBe('posted');
        expect(result.context.kb).toBe(false);
    });

    it('reports failed with the AI error when the completion throws', async () => {
        aiFacade.createChatCompletion.mockRejectedValue(new Error('budget exceeded'));
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        expect(result.status).toBe('failed');
        expect(result.error).toContain('budget exceeded');
        expect(gitFacade.createPullRequestComment).not.toHaveBeenCalled();
    });

    it('still ingests (posted:false) when the comment post is rejected', async () => {
        gitFacade.createPullRequestComment.mockRejectedValue(new Error('403 forbidden'));
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        expect(result.status).toBe('failed');
        expect(result.summary).toContain('Verdict');
        expect(result.error).toContain('403 forbidden');
        const [, envelopes] = eventIngest.ingest.mock.calls[0];
        expect(envelopes[0].payload).toMatchObject({ posted: false });
    });

    it('falls back to a raw-text summary when the completion is not JSON', async () => {
        aiFacade.createChatCompletion.mockResolvedValue({
            id: 'c1',
            model: 'm',
            created: 0,
            choices: [
                { index: 0, message: { role: 'assistant', content: 'Just plain prose review.' } },
            ],
        });
        const service = build();
        const result = await service.reviewPullRequest({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });
        expect(result.summary).toBe('Just plain prose review.');
        expect(result.comments).toEqual([]);
    });
});
