import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-08 T26 — `getAppChangeTargetAction`, the chat change card's name lookup. Its ids come from
 * LLM-authored tool arguments and are interpolated into `/works/:id` and `/agents/:id`, so each
 * must be ONE path segment (CodeRabbit on #3033); a refused id reads as unnamed, never throws.
 */

const { getAuth, getWork, getAgent, redirectMock } = vi.hoisted(() => ({
    getAuth: vi.fn(),
    getWork: vi.fn(),
    getAgent: vi.fn(),
    redirectMock: vi.fn(() => {
        throw new Error('NEXT_REDIRECT');
    }),
}));

vi.mock('@/lib/auth', () => ({ getAuthFromCookie: getAuth }));
vi.mock('@/lib/api/work', () => ({ workAPI: { get: getWork } }));
vi.mock('@/lib/api/agents', () => ({ agentsAPI: { get: getAgent } }));
vi.mock('@/lib/api/app-changes', () => ({ appChangesAPI: {} }));
vi.mock('@/lib/api/server-api', () => ({ ApiResponseError: class extends Error {} }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import { getAppChangeTargetAction } from './app-changes';

const WORK = '6f1d2c3b-0000-4000-8000-000000000001';
const AGENT = '6f1d2c3b-0000-4000-8000-0000000000a1';

beforeEach(() => {
    getAuth.mockReset();
    getWork.mockReset();
    getAgent.mockReset();
    getAuth.mockResolvedValue({ id: 'user-1' });
    getWork.mockResolvedValue({ work: { id: WORK, name: ' Bookings ' } });
    getAgent.mockResolvedValue({ id: AGENT, name: 'Wren' });
});

describe('getAppChangeTargetAction', () => {
    it('reads the Work and Agent names as the signed-in user', async () => {
        await expect(getAppChangeTargetAction(WORK, AGENT)).resolves.toEqual({
            workName: 'Bookings',
            agentName: 'Wren',
        });
        expect(getWork).toHaveBeenCalledWith(WORK);
        expect(getAgent).toHaveBeenCalledWith(AGENT);
    });

    it.each([['../agents/x'], ['a/b'], ['%2e%2e'], ['a.b'], [''], ['x'.repeat(65)]])(
        'refuses %j as a Work id without calling the API',
        async (id) => {
            await expect(getAppChangeTargetAction(id, AGENT)).resolves.toEqual({
                workName: null,
                agentName: null,
            });
            expect(getWork).not.toHaveBeenCalled();
            expect(getAgent).not.toHaveBeenCalled();
        },
    );

    it('drops an Agent id that is not one path segment, and still names the Work', async () => {
        await expect(getAppChangeTargetAction(WORK, '../works/other')).resolves.toEqual({
            workName: 'Bookings',
            agentName: null,
        });
        expect(getAgent).not.toHaveBeenCalled();
    });

    it('a failed read is unnamed, never thrown', async () => {
        getWork.mockRejectedValue(new Error('404'));
        getAgent.mockRejectedValue(new Error('down'));
        await expect(getAppChangeTargetAction(WORK, AGENT)).resolves.toEqual({
            workName: null,
            agentName: null,
        });
    });

    it('authenticates first', async () => {
        getAuth.mockResolvedValue(null);
        await expect(getAppChangeTargetAction(WORK, AGENT)).rejects.toThrow('NEXT_REDIRECT');
        expect(getWork).not.toHaveBeenCalled();
    });
});
