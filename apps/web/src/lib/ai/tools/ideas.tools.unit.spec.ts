import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 9 PR Z1 — unit coverage for the Ideas chat tools. Same
 * pattern as missions.tools.unit.spec — mock the server actions +
 * the read-only API client, then verify each tool's `.execute()`
 * forwards the model's args and shapes the response correctly.
 */

const {
    refreshMock,
    dismissMock,
    acceptMock,
    statusMock,
    listMock,
    createIdeaActionMock,
    buildIdeaActionMock,
} = vi.hoisted(() => ({
    refreshMock: vi.fn(),
    dismissMock: vi.fn(),
    acceptMock: vi.fn(),
    statusMock: vi.fn(),
    listMock: vi.fn(),
    createIdeaActionMock: vi.fn(),
    buildIdeaActionMock: vi.fn(),
}));

const { workProposalsGetMock, workProposalsGetBudgetMock } = vi.hoisted(() => ({
    workProposalsGetMock: vi.fn(),
    workProposalsGetBudgetMock: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    refreshProposalsAction: refreshMock,
    dismissProposalAction: dismissMock,
    acceptProposalAction: acceptMock,
    getProposalsStatusAction: statusMock,
    listProposalsAction: listMock,
    createIdeaAction: createIdeaActionMock,
    buildIdeaAction: buildIdeaActionMock,
}));

vi.mock('@/lib/api/work-proposals', () => ({
    workProposalsAPI: {
        get: workProposalsGetMock,
        getBudget: workProposalsGetBudgetMock,
    },
}));

import {
    acceptIdea,
    buildIdea,
    createIdea,
    dismissIdea,
    getIdeaBudget,
    getIdeaDetails,
    getIdeasRefreshStatus,
    listIdeas,
    refreshIdeas,
} from './ideas.tools';

// AI SDK tools' `execute` return type is `R | AsyncIterable<R>` (the
// streaming branch). Our wrappers never stream — narrow with this
// tiny helper instead of casting at every call site.
async function run<R>(t: { execute?: (...args: never[]) => unknown }, args: unknown): Promise<R> {
    const exec = t.execute as (a: unknown, ctx: unknown) => Promise<R>;
    return await exec(args, {} as never);
}

const sampleIdea = {
    id: 'i-1',
    title: 'Sample Idea',
    description: 'Sample description',
    slugSuggestion: 'sample-idea',
    suggestedCategories: [{ name: 'Cat', slug: 'cat' }],
    suggestedFields: [{ name: 'Field', type: 'string' }],
    recommendedPlugins: [{ pluginId: 'p1', reason: 'because' }],
    generatedPrompt: 'p',
    reasoning: 'r',
    source: 'user-manual' as const,
    status: 'pending' as const,
    acceptedWorkId: null,
    missionId: null,
    failureMessage: null,
    failureKind: null,
    generatedAt: '2026-05-25T00:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('ideas chat tools — Read', () => {
    it('listIdeas defaults to ["pending"] + no missionId filter', async () => {
        listMock.mockResolvedValueOnce([sampleIdea]);
        const result = await run<{ total: number; ideas: Array<Record<string, unknown>> }>(
            listIdeas,
            {},
        );
        expect(listMock).toHaveBeenCalledWith(['pending'], {});
        expect(result.total).toBe(1);
        expect(result.ideas[0]).toMatchObject({ id: 'i-1', url: '/ideas' });
        // Trimmed: heavy fields land only via getIdeaDetails
        expect(result.ideas[0]).not.toHaveProperty('suggestedCategories');
        expect(result.ideas[0]).not.toHaveProperty('reasoning');
    });

    it('listIdeas forwards statuses + missionId scope when supplied', async () => {
        listMock.mockResolvedValueOnce([]);
        await run(listIdeas, { statuses: ['queued', 'building'], missionId: 'm-1' });
        expect(listMock).toHaveBeenCalledWith(['queued', 'building'], { missionId: 'm-1' });
    });

    it('listIdeas falls back to ["pending"] for an explicitly empty statuses array', async () => {
        // Edge case: model could send `statuses: []` — treat as "no filter
        // selected" rather than "match nothing".
        listMock.mockResolvedValueOnce([]);
        await run(listIdeas, { statuses: [] });
        expect(listMock).toHaveBeenCalledWith(['pending'], {});
    });

    it('getIdeaDetails returns the full surface (suggestions + reasoning) when found', async () => {
        workProposalsGetMock.mockResolvedValueOnce(sampleIdea);
        const result = await run<Record<string, unknown>>(getIdeaDetails, { ideaId: 'i-1' });
        expect(workProposalsGetMock).toHaveBeenCalledWith('i-1');
        expect(result).toMatchObject({
            id: 'i-1',
            suggestedCategories: [{ name: 'Cat', slug: 'cat' }],
            suggestedFields: [{ name: 'Field', type: 'string' }],
            recommendedPlugins: [{ pluginId: 'p1', reason: 'because' }],
            reasoning: 'r',
        });
    });

    it('getIdeaDetails returns an error envelope when not found', async () => {
        workProposalsGetMock.mockResolvedValueOnce(null);
        const result = await run<{ error: string }>(getIdeaDetails, { ideaId: 'nope' });
        expect(result).toEqual({ error: 'Idea not found' });
    });

    it('getIdeaBudget passes through the API response', async () => {
        const budget = {
            ownerType: 'idea',
            ownerId: 'i-1',
            periodStart: '2026-05-01',
            periodEnd: '2026-06-01',
            currentSpendCents: 100,
            capCents: 1000,
            currency: 'USD',
            percentUsed: 10,
            allowOverage: false,
            blocked: false,
        };
        workProposalsGetBudgetMock.mockResolvedValueOnce(budget);
        const result = await run<Record<string, unknown>>(getIdeaBudget, { ideaId: 'i-1' });
        expect(result).toEqual(budget);
    });

    it('getIdeaBudget returns an error envelope on failure', async () => {
        workProposalsGetBudgetMock.mockRejectedValueOnce(new Error('nope'));
        const result = await run<{ error: string }>(getIdeaBudget, { ideaId: 'i-1' });
        expect(result).toEqual({ error: 'nope' });
    });

    it('getIdeasRefreshStatus passes through the status envelope', async () => {
        statusMock.mockResolvedValueOnce({ researching: false, canRefresh: true });
        const result = await run<{ researching: boolean; canRefresh: boolean }>(
            getIdeasRefreshStatus,
            {},
        );
        expect(result).toEqual({ researching: false, canRefresh: true });
    });
});

describe('ideas chat tools — Create', () => {
    it('createIdea omits the optional title when not supplied', async () => {
        createIdeaActionMock.mockResolvedValueOnce(sampleIdea);
        await run(createIdea, { description: 'A reasonably long description string' });
        expect(createIdeaActionMock).toHaveBeenCalledWith({
            description: 'A reasonably long description string',
        });
    });

    it('createIdea forwards the title when supplied', async () => {
        createIdeaActionMock.mockResolvedValueOnce(sampleIdea);
        await run(createIdea, {
            description: 'A reasonably long description string',
            title: 'My title',
        });
        expect(createIdeaActionMock).toHaveBeenCalledWith({
            description: 'A reasonably long description string',
            title: 'My title',
        });
    });

    it('refreshIdeas passes the rate-limited envelope through unchanged', async () => {
        refreshMock.mockResolvedValueOnce({ status: 'rate-limited', error: 'try-later' });
        const result = await run<{ status: string; error: string }>(refreshIdeas, {});
        expect(result).toEqual({ status: 'rate-limited', error: 'try-later' });
    });
});

describe('ideas chat tools — Lifecycle', () => {
    it('buildIdea returns queued=true plus the goalId for navigation', async () => {
        buildIdeaActionMock.mockResolvedValueOnce({
            idea: { ...sampleIdea, status: 'queued' },
            goalId: 'g-1',
        });
        const result = await run<{
            queued: boolean;
            goalId: string;
            idea: { id: string; status: string };
        }>(buildIdea, { ideaId: 'i-1' });
        expect(buildIdeaActionMock).toHaveBeenCalledWith('i-1');
        expect(result).toMatchObject({
            queued: true,
            goalId: 'g-1',
            idea: expect.objectContaining({ id: 'i-1', status: 'queued' }),
        });
    });

    it('dismissIdea returns a tombstone envelope', async () => {
        dismissMock.mockResolvedValueOnce(undefined);
        const result = await run<{ dismissed: boolean; ideaId: string }>(dismissIdea, {
            ideaId: 'i-1',
        });
        expect(dismissMock).toHaveBeenCalledWith('i-1');
        expect(result).toEqual({ dismissed: true, ideaId: 'i-1' });
    });

    it('acceptIdea forwards both ids + echoes them back in the result', async () => {
        acceptMock.mockResolvedValueOnce({ ok: true });
        const result = await run<{ ok: boolean; ideaId: string; workId: string }>(acceptIdea, {
            ideaId: 'i-1',
            workId: 'w-1',
        });
        expect(acceptMock).toHaveBeenCalledWith('i-1', 'w-1');
        expect(result).toEqual({ ok: true, ideaId: 'i-1', workId: 'w-1' });
    });
});
