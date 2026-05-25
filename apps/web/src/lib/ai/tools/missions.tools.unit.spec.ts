import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 9 PR Z1 — unit coverage for the Missions chat tools.
 *
 * We mock the server-action module + the read-only API client so each
 * tool's `.execute()` runs against an in-memory fixture. The assertions
 * pin three things per tool:
 *   1. Arguments forwarded to the underlying action match the model's
 *      input (tri-state semantics intact: omit ≠ null ≠ value).
 *   2. The returned shape carries the trimmed summary fields the model
 *      consumes (we never want a future entity field to leak in).
 *   3. Lifecycle tools surface the action's mutation result verbatim.
 */

const { listMissionsMock, createMissionMock, updateMissionMock, deleteMissionMock } = vi.hoisted(
    () => ({
        listMissionsMock: vi.fn(),
        createMissionMock: vi.fn(),
        updateMissionMock: vi.fn(),
        deleteMissionMock: vi.fn(),
    }),
);

const { pauseMissionMock, resumeMissionMock, completeMissionMock, runNowMock, cloneMissionMock } =
    vi.hoisted(() => ({
        pauseMissionMock: vi.fn(),
        resumeMissionMock: vi.fn(),
        completeMissionMock: vi.fn(),
        runNowMock: vi.fn(),
        cloneMissionMock: vi.fn(),
    }));

const { missionsAPIGetMock, missionsAPIGetBudgetMock } = vi.hoisted(() => ({
    missionsAPIGetMock: vi.fn(),
    missionsAPIGetBudgetMock: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/missions', () => ({
    listMissionsAction: listMissionsMock,
    createMissionAction: createMissionMock,
    updateMissionAction: updateMissionMock,
    deleteMissionAction: deleteMissionMock,
    pauseMissionAction: pauseMissionMock,
    resumeMissionAction: resumeMissionMock,
    completeMissionAction: completeMissionMock,
    runMissionNowAction: runNowMock,
    cloneMissionAction: cloneMissionMock,
}));

vi.mock('@/lib/api/missions', () => ({
    missionsAPI: {
        get: missionsAPIGetMock,
        getBudget: missionsAPIGetBudgetMock,
    },
}));

import {
    cloneMission,
    completeMission,
    createMission,
    deleteMission,
    getMissionBudget,
    getMissionDetails,
    listMissions,
    pauseMission,
    resumeMission,
    runMissionNow,
    updateMission,
} from './missions.tools';

// AI SDK tools' `execute` return type is `R | AsyncIterable<R>` (the
// streaming branch). Our wrappers never stream — narrow with this
// tiny helper instead of casting at every call site.
async function run<R>(t: { execute?: (...args: never[]) => unknown }, args: unknown): Promise<R> {
    const exec = t.execute as (a: unknown, ctx: unknown) => Promise<R>;
    return await exec(args, {} as never);
}

const sampleMission = {
    id: 'm-1',
    title: 'Sample Mission',
    description: 'Sample description',
    type: 'one-shot' as const,
    status: 'active' as const,
    schedule: null,
    autoBuildWorks: false,
    outstandingIdeasCap: null,
    guardrailsOverride: null,
    missionTemplateRepo: null,
    missionRepo: null,
    sourceMissionId: null,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
});

describe('missions chat tools — Read', () => {
    it('listMissions returns trimmed summaries + total count', async () => {
        listMissionsMock.mockResolvedValueOnce([sampleMission, { ...sampleMission, id: 'm-2' }]);
        const result = await run<{ total: number; missions: Array<Record<string, unknown>> }>(
            listMissions,
            {},
        );
        expect(listMissionsMock).toHaveBeenCalledOnce();
        expect(result.total).toBe(2);
        expect(result.missions[0]).toMatchObject({
            id: 'm-1',
            title: 'Sample Mission',
            status: 'active',
            url: '/missions/m-1',
        });
        // Trimmed: internal entity fields shouldn't leak
        expect(result.missions[0]).not.toHaveProperty('guardrailsOverride');
        expect(result.missions[0]).not.toHaveProperty('createdAt');
    });

    it('getMissionDetails returns the summary when found', async () => {
        missionsAPIGetMock.mockResolvedValueOnce(sampleMission);
        const result = await run<Record<string, unknown>>(getMissionDetails, { missionId: 'm-1' });
        expect(missionsAPIGetMock).toHaveBeenCalledWith('m-1');
        expect(result).toMatchObject({ id: 'm-1', url: '/missions/m-1' });
    });

    it('getMissionDetails returns an error envelope when not found', async () => {
        missionsAPIGetMock.mockResolvedValueOnce(null);
        const result = await run<{ error: string }>(getMissionDetails, { missionId: 'nope' });
        expect(result).toEqual({ error: 'Mission not found' });
    });

    it('getMissionBudget passes through the API response on success', async () => {
        const budget = {
            ownerType: 'mission',
            ownerId: 'm-1',
            periodStart: '2026-05-01',
            periodEnd: '2026-06-01',
            currentSpendCents: 1234,
            capCents: 10000,
            currency: 'USD',
            percentUsed: 12,
            allowOverage: false,
            blocked: false,
        };
        missionsAPIGetBudgetMock.mockResolvedValueOnce(budget);
        const result = await run<Record<string, unknown>>(getMissionBudget, { missionId: 'm-1' });
        expect(result).toEqual(budget);
    });

    it('getMissionBudget returns an error envelope on failure (does not throw)', async () => {
        missionsAPIGetBudgetMock.mockRejectedValueOnce(new Error('boom'));
        const result = await run<{ error: string }>(getMissionBudget, { missionId: 'm-1' });
        expect(result).toEqual({ error: 'boom' });
    });
});

describe('missions chat tools — Create / Update', () => {
    it('createMission defaults type to "one-shot" and omits keys the model did not send', async () => {
        createMissionMock.mockResolvedValueOnce(sampleMission);
        await run(createMission, { description: 'A new mission with enough length' });
        expect(createMissionMock).toHaveBeenCalledWith({
            description: 'A new mission with enough length',
            type: 'one-shot',
        });
    });

    it('createMission forwards optional fields when present', async () => {
        createMissionMock.mockResolvedValueOnce(sampleMission);
        await run(createMission, {
            description: 'Scheduled mission with all fields',
            type: 'scheduled',
            schedule: '0 9 * * *',
            title: 'Daily standup',
            autoBuildWorks: true,
            outstandingIdeasCap: 5,
        });
        expect(createMissionMock).toHaveBeenCalledWith({
            description: 'Scheduled mission with all fields',
            type: 'scheduled',
            schedule: '0 9 * * *',
            title: 'Daily standup',
            autoBuildWorks: true,
            outstandingIdeasCap: 5,
        });
    });

    it('createMission accepts -1 (unlimited) and null (reset) on outstandingIdeasCap', async () => {
        createMissionMock.mockResolvedValueOnce(sampleMission);
        await run(createMission, {
            description: 'Unlimited cap mission',
            outstandingIdeasCap: -1,
        });
        expect(createMissionMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ outstandingIdeasCap: -1 }),
        );

        createMissionMock.mockResolvedValueOnce(sampleMission);
        await run(createMission, {
            description: 'Null cap mission',
            outstandingIdeasCap: null,
        });
        expect(createMissionMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ outstandingIdeasCap: null }),
        );
    });

    it('updateMission forwards the patch verbatim (preserves tri-state semantics)', async () => {
        updateMissionMock.mockResolvedValueOnce(sampleMission);
        await run(updateMission, {
            missionId: 'm-1',
            title: 'Renamed',
            schedule: null,
            autoBuildWorks: true,
        });
        expect(updateMissionMock).toHaveBeenCalledWith('m-1', {
            title: 'Renamed',
            schedule: null,
            autoBuildWorks: true,
        });
    });
});

describe('missions chat tools — Lifecycle', () => {
    it('pauseMission delegates to pauseMissionAction', async () => {
        pauseMissionMock.mockResolvedValueOnce({ ...sampleMission, status: 'paused' });
        const result = await run<{ paused: boolean; mission: { id: string; status: string } }>(
            pauseMission,
            { missionId: 'm-1' },
        );
        expect(pauseMissionMock).toHaveBeenCalledWith('m-1');
        expect(result).toEqual({
            paused: true,
            mission: expect.objectContaining({ id: 'm-1', status: 'paused' }),
        });
    });

    it('resumeMission delegates to resumeMissionAction', async () => {
        resumeMissionMock.mockResolvedValueOnce({ ...sampleMission, status: 'active' });
        const result = await run<{ resumed: boolean }>(resumeMission, { missionId: 'm-1' });
        expect(resumeMissionMock).toHaveBeenCalledWith('m-1');
        expect(result).toMatchObject({ resumed: true });
    });

    it('completeMission delegates to completeMissionAction', async () => {
        completeMissionMock.mockResolvedValueOnce({ ...sampleMission, status: 'completed' });
        const result = await run<{ completed: boolean }>(completeMission, { missionId: 'm-1' });
        expect(completeMissionMock).toHaveBeenCalledWith('m-1');
        expect(result).toMatchObject({ completed: true });
    });

    it('deleteMission returns a tombstone envelope (no entity fields)', async () => {
        deleteMissionMock.mockResolvedValueOnce({ deleted: true });
        const result = await run<{ deleted: boolean; missionId: string }>(deleteMission, {
            missionId: 'm-1',
        });
        expect(deleteMissionMock).toHaveBeenCalledWith('m-1');
        expect(result).toEqual({ deleted: true, missionId: 'm-1' });
    });

    it('runMissionNow passes through the spawn-status envelope', async () => {
        const runResult = {
            status: 'spawned' as const,
            missionId: 'm-1',
            ideasCreated: 3,
            ideasQueued: 3,
        };
        runNowMock.mockResolvedValueOnce(runResult);
        const result = await run<typeof runResult>(runMissionNow, { missionId: 'm-1' });
        expect(runNowMock).toHaveBeenCalledWith('m-1');
        expect(result).toEqual(runResult);
    });

    it('cloneMission surfaces ideasCloned + ideasSkipped counts alongside the new Mission', async () => {
        cloneMissionMock.mockResolvedValueOnce({
            mission: { ...sampleMission, id: 'm-cloned', sourceMissionId: 'm-1' },
            ideasCloned: 5,
            ideasSkipped: 2,
        });
        const result = await run<{
            cloned: boolean;
            mission: { id: string; sourceMissionId: string };
            ideasCloned: number;
            ideasSkipped: number;
        }>(cloneMission, { missionId: 'm-1', title: 'My fork' });
        expect(cloneMissionMock).toHaveBeenCalledWith('m-1', 'My fork');
        expect(result).toMatchObject({
            cloned: true,
            mission: expect.objectContaining({ id: 'm-cloned', sourceMissionId: 'm-1' }),
            ideasCloned: 5,
            ideasSkipped: 2,
        });
    });

    it('cloneMission omits the optional title arg when the user did not supply one', async () => {
        cloneMissionMock.mockResolvedValueOnce({
            mission: sampleMission,
            ideasCloned: 0,
            ideasSkipped: 0,
        });
        await run(cloneMission, { missionId: 'm-1' });
        expect(cloneMissionMock).toHaveBeenCalledWith('m-1', undefined);
    });
});
