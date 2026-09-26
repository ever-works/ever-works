/**
 * Unit spec for the fake-GitHub upstream-seed helper (APW-09 T45).
 *
 * The helper's whole job is to make one failure impossible: a lane whose seeded
 * `awaiting_approval` precondition was **silently dropped** because the fake was
 * started without `EVER_WORKS_E2E_FAKES=1`. Three cases pin that, plus the
 * read-back:
 *
 *   1. an applied seed is read back, and the pair is linked in the answer the
 *      helper returns (`rows`, `proposals`, `summary`);
 *   2. an ignored seed **throws**, and the message names the switch and the file
 *      to start with — the diagnosis, not just the failure;
 *   3. a `400` orphan-proposal refusal throws with the fake's own message;
 *   4. a `200` whose body carries no `seeded.upstreamSeed` at all is also a
 *      refusal, because a response shape that says nothing cannot be read as
 *      consent.
 *
 * The stub `APIRequestContext` records what was posted, so the spec can assert the
 * seed travelled unchanged — key spelling included, since the two keys are the
 * fake's own snake_case contract.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    FAKES_SWITCH_ENV,
    seedUpstreamState,
    upstreamProposalFor,
    upstreamRowFor,
} from '../github-fake-upstream';

type Json = Record<string, any>;

/** A minimal stand-in for Playwright's `APIRequestContext`. */
function stubRequest(handler: (url: string, options: Json) => Json) {
    const posted: Json[] = [];
    const request = {
        post: vi.fn(async (url: string, options: Json = {}) => {
            posted.push({ url, data: options.data });
            const answer = handler(url, options);
            return {
                status: () => answer.status,
                ok: () => answer.status >= 200 && answer.status < 300,
                text: async () => JSON.stringify(answer.body ?? null),
                json: async () => answer.body,
            };
        }),
        get: vi.fn(async (url: string) => {
            const answer = handler(url, {});
            return {
                status: () => answer.status,
                ok: () => answer.status >= 200 && answer.status < 300,
                text: async () => JSON.stringify(answer.body ?? null),
                json: async () => answer.body,
            };
        }),
    };
    return { request: request as any, posted };
}

const ROW = {
    id: 'upr-1',
    workId: 'work-1',
    sourceTaskId: 'task-1',
    upstreamOwner: 'ever-works',
    upstreamRepo: 'cal-diy-template',
    headBranch: 'upstream-pr/add-smoke-test-1a2b',
    state: 'awaiting_approval',
};

const PROPOSAL = {
    id: 'proposal-1',
    actionType: 'upstream_pull_request',
    status: 'pending',
    payload: { workId: 'work-1', sourceTaskId: 'task-1', upstreamPullRequestId: 'upr-1' },
};

function appliedState(): Json {
    return {
        repositories: [],
        upstreamPullRequests: [{ ...ROW, approvalProposalId: 'proposal-1' }],
        upstreamApprovalProposals: [PROPOSAL],
    };
}

describe('T45 — seedUpstreamState', () => {
    it('posts the seed unchanged and reads the row and its proposal back', async () => {
        const { request, posted } = stubRequest((url, options) => {
            if (url.endsWith('/_control/seed')) {
                return {
                    status: 200,
                    body: {
                        seeded: {
                            repositories: 7,
                            upstreamSeed: {
                                applied: true,
                                reason: 'armed',
                                rows: 1,
                                proposals: 1,
                                linked: 1,
                            },
                        },
                    },
                };
            }
            expect(options).toEqual({});
            return { status: 200, body: appliedState() };
        });

        const seeded = await seedUpstreamState(request, 'http://127.0.0.1:3915/', {
            upstream_pull_requests: [ROW],
            upstream_approval_proposals: [PROPOSAL],
        });

        expect(posted[0].url, 'a trailing slash on the origin must not double up').toBe(
            'http://127.0.0.1:3915/_control/seed',
        );
        expect(posted[0].data, 'the seed travels in the fake’s own key spelling').toEqual({
            upstream_pull_requests: [ROW],
            upstream_approval_proposals: [PROPOSAL],
        });

        expect(seeded.summary).toEqual({
            applied: true,
            reason: 'armed',
            rows: 1,
            proposals: 1,
            linked: 1,
        });
        const row = upstreamRowFor(seeded, 'upr-1');
        expect(row?.state).toBe('awaiting_approval');
        expect(upstreamProposalFor(seeded, row as any)?.id).toBe('proposal-1');
    });

    it('refuses the lane when the fake did not apply the seed, and names the switch', async () => {
        const { request } = stubRequest(() => ({
            status: 200,
            body: {
                seeded: {
                    upstreamSeed: {
                        applied: false,
                        reason: 'switch-off',
                        rows: 0,
                        proposals: 0,
                        linked: 0,
                    },
                },
            },
        }));

        await expect(
            seedUpstreamState(request, 'http://127.0.0.1:3915', { upstream_pull_requests: [ROW] }),
        ).rejects.toThrow(/switch-off/);
        await expect(
            seedUpstreamState(request, 'http://127.0.0.1:3915', { upstream_pull_requests: [ROW] }),
        ).rejects.toThrow(new RegExp(FAKES_SWITCH_ENV));
        await expect(
            seedUpstreamState(request, 'http://127.0.0.1:3915', { upstream_pull_requests: [ROW] }),
        ).rejects.toThrow(/started with the switch/);
    });

    it('surfaces the fake’s 400 for an orphan proposal', async () => {
        const { request } = stubRequest(() => ({
            status: 400,
            body: {
                message:
                    'approval proposal proposal-orphan matches no seeded upstream_pull_requests row',
                seeded: { upstreamSeed: { applied: false, reason: 'orphan-proposal' } },
            },
        }));

        await expect(
            seedUpstreamState(request, 'http://127.0.0.1:3915', {
                upstream_approval_proposals: [{ id: 'proposal-orphan' }],
            }),
        ).rejects.toThrow(/matches no seeded upstream_pull_requests row/);
    });

    it('refuses a 200 whose body says nothing about the upstream seed', async () => {
        const { request } = stubRequest(() => ({ status: 200, body: { seeded: {} } }));
        await expect(
            seedUpstreamState(request, 'http://127.0.0.1:3915', { upstream_pull_requests: [ROW] }),
        ).rejects.toThrow(/did not apply the upstream seed/);
    });
});
