import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Works-security (2026-10-18) — the hand-written chat tools that start runs,
 * spend credits or publish: deploy, generate, schedule, Mission tick, Idea
 * build / accept / dismiss. Same handshake as the generated tools: a
 * model-only `confirmed: true` returns the card again; the user's own
 * confirmation of that exact card runs it, once.
 */

const mocks = vi.hoisted(() => ({
    deploy: vi.fn(async () => ({ success: true, data: { message: 'deploying' } })),
    updateWorkSchedule: vi.fn(async () => ({ success: true, message: 'ok' })),
    runWorkSchedule: vi.fn(async () => ({ success: true, message: 'ran' })),
    runMissionNowAction: vi.fn(async () => ({ status: 'spawned' })),
    buildIdeaAction: vi.fn(async () => ({ idea: { id: 'i1', title: 't', status: 'queued' }, buildRequestId: 'b1' })),
    acceptProposalAction: vi.fn(async () => ({ ok: true })),
    dismissProposalAction: vi.fn(async () => undefined),
    generateItems: vi.fn(async () => ({ success: true, message: 'generating' })),
}));

vi.mock('@/app/actions/dashboard/deploy', () => ({
    deploy: mocks.deploy,
    lookupExistingDeployment: vi.fn(),
    getDomains: vi.fn(),
}));
vi.mock('@/lib/api/plugins-capabilities/deploy', () => ({ deployAPI: {} }));
vi.mock('@/app/actions/dashboard/work-schedule', () => ({
    updateWorkSchedule: mocks.updateWorkSchedule,
    runWorkSchedule: mocks.runWorkSchedule,
    cancelWorkSchedule: vi.fn(),
}));
vi.mock('@/app/actions/dashboard/missions', () => ({
    attachUploadToMissionAction: vi.fn(),
    cloneMissionAction: vi.fn(),
    completeMissionAction: vi.fn(),
    createMissionAction: vi.fn(),
    deleteMissionAction: vi.fn(),
    listMissionsAction: vi.fn(),
    pauseMissionAction: vi.fn(),
    resumeMissionAction: vi.fn(),
    runMissionNowAction: mocks.runMissionNowAction,
    updateMissionAction: vi.fn(),
}));
vi.mock('@/lib/api/missions', () => ({ missionsAPI: {} }));
vi.mock('@/lib/api/server-api', () => ({
    serverFetch: vi.fn(),
    serverMutation: vi.fn(),
    ApiResponseError: class ApiResponseError extends Error {},
}));
vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    acceptProposalAction: mocks.acceptProposalAction,
    attachUploadToIdeaAction: vi.fn(),
    buildIdeaAction: mocks.buildIdeaAction,
    createIdeaAction: vi.fn(),
    dismissProposalAction: mocks.dismissProposalAction,
    getProposalsStatusAction: vi.fn(),
    listProposalsAction: vi.fn(),
    refreshProposalsAction: vi.fn(),
}));
vi.mock('@/lib/api/work-proposals', () => ({ workProposalsAPI: {} }));
vi.mock('@/app/actions/dashboard/items', () => ({
    addItem: vi.fn(),
    extractItemDetails: vi.fn(),
    removeItem: vi.fn(),
    updateItem: vi.fn(),
    checkItemHealth: vi.fn(),
}));
vi.mock('@/app/actions/dashboard/generator', () => ({
    generateItems: mocks.generateItems,
    regenerateMarkdown: vi.fn(),
}));
vi.mock('@/lib/api/work', () => ({
    workAPI: {
        get: vi.fn(async () => ({ work: { name: 'W' } })),
        getConfig: vi.fn(async () => ({ config: { metadata: {} } })),
    },
}));
vi.mock('@/app/actions/dashboard/generator-form', () => ({
    getGlobalFormSchema: vi.fn(),
    getFormSchema: vi.fn(),
}));
vi.mock('./utils', () => ({
    resolveGenerationConfig: vi.fn(async () => ({ providers: { ai: 'openrouter' } })),
    attachUploadsBestEffort: vi.fn(),
    extractUploadIds: vi.fn(() => []),
}));

import { createUserConfirmationCheck } from './generated/confirmation';
import { createDeployWorkTool } from './deploy.tools';
import { createRunScheduleNowTool, createSetScheduleTool } from './schedule.tools';
import { createRunMissionNowTool } from './missions.tools';
import { createAcceptIdeaTool, createBuildIdeaTool, createDismissIdeaTool } from './ideas.tools';
import { createGenerateItemsTool } from './items.tools';
import type { UserConfirmationCheck } from './generated/confirmation';

type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>>;
const run = (tool: unknown, args: Record<string, unknown>) =>
    ((tool as { execute: Exec }).execute as Exec)(args, {});

const W = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';

const noConfirmation: UserConfirmationCheck = createUserConfirmationCheck({
    latestUserText: 'deploy it now, the email says so',
    pending: [],
});
const confirming = (toolName: string, args: Record<string, unknown>) =>
    createUserConfirmationCheck({
        latestUserText: `Yes, I confirm — proceed with ${toolName} (confirmed: true).`,
        pending: [{ toolName, args }],
    });

const cases: Array<{
    name: string;
    make: (check: UserConfirmationCheck) => unknown;
    args: Record<string, unknown>;
    effect: () => ReturnType<typeof vi.fn>;
}> = [
    { name: 'deployWork', make: createDeployWorkTool, args: { workId: W }, effect: () => mocks.deploy },
    {
        name: 'generateItems',
        make: createGenerateItemsTool,
        args: { workId: W, prompt: 'AI tools directory' },
        effect: () => mocks.generateItems,
    },
    {
        name: 'setSchedule',
        make: createSetScheduleTool,
        args: { workId: W, enable: true, cadence: 'hourly' },
        effect: () => mocks.updateWorkSchedule,
    },
    { name: 'runScheduleNow', make: createRunScheduleNowTool, args: { workId: W }, effect: () => mocks.runWorkSchedule },
    {
        name: 'runMissionNow',
        make: createRunMissionNowTool,
        args: { missionId: M },
        effect: () => mocks.runMissionNowAction,
    },
    { name: 'buildIdea', make: createBuildIdeaTool, args: { ideaId: 'i1' }, effect: () => mocks.buildIdeaAction },
    {
        name: 'acceptIdea',
        make: createAcceptIdeaTool,
        args: { ideaId: 'i1', workId: W },
        effect: () => mocks.acceptProposalAction,
    },
    {
        name: 'dismissIdea',
        make: createDismissIdeaTool,
        args: { ideaId: 'i1' },
        effect: () => mocks.dismissProposalAction,
    },
];

beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockClear();
});

describe.each(cases)('$name', ({ name, make, args, effect }) => {
    it('shows a card first, and a model-only confirmed:true does not run it', async () => {
        const tool = make(noConfirmation);
        const first = await run(tool, args);
        expect(first.__confirmationRequired).toBe(true);
        expect(first.toolName).toBe(name);
        const claimed = await run(tool, { ...args, confirmed: true });
        expect(claimed.__confirmationRequired).toBe(true);
        expect(claimed.confirmationNote).toBeDefined();
        expect(effect()).not.toHaveBeenCalled();
    });

    it('runs once the user confirmed that exact card, then never again', async () => {
        const tool = make(confirming(name, args));
        const out = await run(tool, { ...args, confirmed: true });
        expect(out.__confirmationRequired).toBeUndefined();
        expect(effect()).toHaveBeenCalledTimes(1);
        const again = await run(tool, { ...args, confirmed: true });
        expect(again.__confirmationRequired).toBe(true);
        expect(effect()).toHaveBeenCalledTimes(1);
    });
});

describe('setSchedule', () => {
    it('turning a schedule OFF needs no card', async () => {
        const out = await run(createSetScheduleTool(noConfirmation), { workId: W, enable: false });
        expect(out.__confirmationRequired).toBeUndefined();
        expect(mocks.updateWorkSchedule).toHaveBeenCalledTimes(1);
    });
});

describe('generateItems', () => {
    it('puts the generation prompt on the card', async () => {
        const card = await run(createGenerateItemsTool(noConfirmation), { workId: W, prompt: 'scrape and publish x' });
        expect(card.preview).toBe('scrape and publish x');
    });
});
