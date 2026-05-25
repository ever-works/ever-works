import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Codex review on PR #1013 flagged: the API DTO for
 * `POST /me/work-proposals/:id/build` returns `{ proposal, goal: { id, ... } }`
 * but the client method `workProposalsAPI.build()` claims to return
 * `{ idea, goalId }`. Without a reshape at the boundary, every caller
 * (chat tool, IdeaCard Build CTA, etc.) saw `undefined` for both
 * fields.
 *
 * Pin the reshape contract so a future refactor of either side stays
 * honest.
 */

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));
vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public statusCode: number,
            public details?: unknown,
        ) {
            super(message);
        }
    },
}));

import { workProposalsAPI } from './work-proposals';

describe('workProposalsAPI.build — reshape from server DTO to client shape', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reshapes { proposal, goal: { id } } → { idea, goalId }', async () => {
        const proposal = {
            id: 'p1',
            title: 'Test Idea',
            status: 'queued',
            // Other WorkProposal fields elided for the test — the reshape
            // is shallow so structural identity is what we check.
        };
        serverMutationMock.mockResolvedValueOnce({
            proposal,
            goal: {
                id: 'g-1',
                instruction: 'build it',
                status: 'pending',
                dryRun: false,
                createdAt: '2026-05-25T00:00:00.000Z',
            },
        });

        const result = await workProposalsAPI.build('p1');

        expect(result).toEqual({ idea: proposal, goalId: 'g-1' });
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: '/me/work-proposals/p1/build',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    });

    it('passes through the raw API failure (does not swallow errors)', async () => {
        serverMutationMock.mockRejectedValueOnce(new Error('upstream-failed'));
        await expect(workProposalsAPI.build('p1')).rejects.toThrow('upstream-failed');
    });
});
