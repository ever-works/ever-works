import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Codex review on PR #1013 flagged: the API DTO for
 * `POST /me/work-proposals/:id/build` returns `{ proposal, goal: { id, ... } }`
 * but the client method `workProposalsAPI.build()` claims to return
 * `{ idea, buildRequestId }`. Without a reshape at the boundary, every caller
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
import { ApiResponseError } from './server-api';

describe('workProposalsAPI.get — null only for gone/unauthorized, rethrow transient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the proposal on success', async () => {
        const proposal = { id: 'p1', title: 'Idea', status: 'building' };
        serverFetchMock.mockResolvedValueOnce(proposal);
        await expect(workProposalsAPI.get('p1')).resolves.toEqual(proposal);
        expect(serverFetchMock).toHaveBeenCalledWith('/me/work-proposals/p1', { method: 'GET' });
    });

    it.each([404, 403])('returns null for a definitive %s', async (statusCode) => {
        serverFetchMock.mockRejectedValueOnce(new ApiResponseError('nope', statusCode));
        await expect(workProposalsAPI.get('p1')).resolves.toBeNull();
    });

    it.each([500, 502, 429])(
        'rethrows a transient %s so pollers keep retrying',
        async (statusCode) => {
            serverFetchMock.mockRejectedValueOnce(new ApiResponseError('boom', statusCode));
            await expect(workProposalsAPI.get('p1')).rejects.toBeInstanceOf(ApiResponseError);
        },
    );

    it('rethrows a non-HTTP failure (network blip) instead of swallowing it', async () => {
        serverFetchMock.mockRejectedValueOnce(new Error('fetch failed'));
        await expect(workProposalsAPI.get('p1')).rejects.toThrow('fetch failed');
    });
});

describe('workProposalsAPI.build — reshape from server DTO to client shape', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reshapes { proposal, goal: { id } } → { idea, buildRequestId }', async () => {
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

        expect(result).toEqual({ idea: proposal, buildRequestId: 'g-1' });
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
