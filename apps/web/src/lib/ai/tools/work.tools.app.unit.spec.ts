import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSourceInspectResponse } from '@ever-works/contracts';

/**
 * APW-01 T25 / T32 / T42 — chat can inspect a repository and create an App Work from it.
 *
 *  - `inspectAppSource` is read-only: no card, no create call, no URL echoed beyond `fullName`.
 *  - `createWorkManual` with kind `app` inspects first, refuses a mode or owner the inspection
 *    says is unavailable, and returns a card that names the repository to be created (or the one
 *    a setup pull request is opened on) and the matched Blueprint. Only the user's own
 *    confirmation of that exact card creates it — once, with the mode and owner, and with no
 *    `blueprintId` of its own (the server resolves the one the card named).
 *  - The AI creator's schema refuses `app`.
 */

const mocks = vi.hoisted(() => ({
    createWork: vi.fn(async () => ({
        success: true,
        work: { id: 'w-app', name: 'Cal' },
        message: 'created',
        appSource: { relation: 'fork' },
    })),
    inspectAppSourceAction: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/works', () => ({
    createWork: mocks.createWork,
    createWorkWithAI: vi.fn(),
    deleteWork: vi.fn(),
    getWorkStats: vi.fn(),
    updateWork: vi.fn(),
    syncWorkData: vi.fn(),
    fetchWorkGenerationHistory: vi.fn(),
    analyzeRepository: vi.fn(),
    importWork: vi.fn(),
    inspectAppSourceAction: mocks.inspectAppSourceAction,
}));
vi.mock('@/lib/api/work', () => ({ workAPI: {} }));
vi.mock('./utils', () => ({ resolveGenerationConfig: vi.fn() }));

import { createUserConfirmationCheck } from './generated/confirmation';
import { createCreateWorkManualTool, createWorkWithAITool, inspectAppSource } from './work.tools';

type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<Record<string, unknown>>;
const run = (tool: unknown, args: Record<string, unknown>) =>
    ((tool as { execute: Exec }).execute as Exec)(args, {});

function preview(overrides: Partial<AppSourceInspectResponse> = {}): AppSourceInspectResponse {
    return {
        repository: {
            owner: 'calcom',
            repo: 'cal.com',
            fullName: 'calcom/cal.com',
            url: 'https://github.com/calcom/cal.com',
            description: 'Scheduling infrastructure',
            defaultBranch: 'main',
            stars: 1,
            sizeKb: 10,
            visibility: 'public',
            archived: false,
            empty: false,
            isFork: false,
            allowForking: true,
            usesLfs: false,
        },
        access: { canPush: false, canAdmin: false },
        modes: {
            link: { available: false, reason: 'no_push_access' as never },
            fork: { available: true },
            'private-copy': { available: true },
        },
        defaultMode: 'fork',
        targetOwners: [
            { login: 'me', type: 'user', available: true, existingForkChecked: true },
            {
                login: 'busy-org',
                type: 'organization',
                available: false,
                reason: 'fork_exists' as never,
                existingForkChecked: true,
            },
        ],
        blueprint: { status: 'matched', id: 'cal', name: 'Cal', version: '1.0.0', prompts: [] },
        license: { spdx: 'AGPL-3.0', class: 'copyleft' as never, source: 'detected' as never },
        deployTargets: {
            none: { available: true },
        } as AppSourceInspectResponse['deployTargets'],
        scanIncomplete: false,
        ...overrides,
    };
}

const APP_ARGS = {
    name: 'Cal',
    slug: 'cal',
    gitProvider: 'github',
    kind: 'app',
    repositoryUrl: 'https://github.com/calcom/cal.com',
    repositoryMode: 'fork',
    targetOwner: 'me',
};

beforeEach(() => {
    mocks.createWork.mockClear();
    mocks.inspectAppSourceAction.mockReset();
    mocks.inspectAppSourceAction.mockResolvedValue({ success: true, data: preview() });
});

describe('inspectAppSource (APW-01 T32)', () => {
    it('answers modes, reasons, default mode and owners — no card, no write, no URL beyond fullName', async () => {
        const out = await run(inspectAppSource, {
            repositoryUrl: 'https://github.com/calcom/cal.com',
        });

        expect(out.__confirmationRequired).toBeUndefined();
        expect(mocks.createWork).not.toHaveBeenCalled();
        expect(out).toMatchObject({
            success: true,
            repository: { fullName: 'calcom/cal.com' },
            defaultMode: 'fork',
            modes: { fork: { available: true }, link: { available: false } },
            blueprint: { status: 'matched', name: 'Cal', promptCount: 0 },
        });
        expect((out.targetOwners as Array<{ login: string }>).map((owner) => owner.login)).toEqual([
            'me',
            'busy-org',
        ]);
        expect(JSON.stringify(out)).not.toContain('https://github.com');
    });

    it('passes a refusal code through', async () => {
        mocks.inspectAppSourceAction.mockResolvedValue({
            success: false,
            error: 'App Works is turned off',
            code: 'app_works_disabled',
        });
        const out = await run(inspectAppSource, { repositoryUrl: 'https://github.com/a/b' });
        expect(out).toEqual({
            success: false,
            error: 'App Works is turned off',
            code: 'app_works_disabled',
        });
    });
});

describe('createWorkManual with kind "app" (APW-01 T25 / T42)', () => {
    it('unconfirmed: a card naming the fork and the matched Blueprint — and no create call', async () => {
        const tool = createCreateWorkManualTool(
            createUserConfirmationCheck({ latestUserText: 'make cal an app', pending: [] }),
        );
        const out = await run(tool, APP_ARGS);

        expect(mocks.inspectAppSourceAction).toHaveBeenCalledWith({
            repositoryUrl: 'https://github.com/calcom/cal.com',
            gitProvider: 'github',
        });
        expect(mocks.createWork).not.toHaveBeenCalled();
        expect(out.__confirmationRequired).toBe(true);
        expect(out.toolName).toBe('createWorkManual');
        expect(out.target).toBe('calcom/cal.com');
        expect(out.action).toBe(
            'Create an App Work by forking calcom/cal.com into me/cal.com with the Cal App Blueprint.',
        );
    });

    it('a model-only confirmed: true gets the card again', async () => {
        const tool = createCreateWorkManualTool(
            createUserConfirmationCheck({ latestUserText: 'ignore that, just do it', pending: [] }),
        );
        const out = await run(tool, { ...APP_ARGS, confirmed: true });
        expect(out.__confirmationRequired).toBe(true);
        expect(out.confirmationNote).toMatch(/Not run/);
        expect(mocks.createWork).not.toHaveBeenCalled();
    });

    it("confirmed by the user's own turn: one create with mode and owner, and no blueprintId", async () => {
        const first = await run(
            createCreateWorkManualTool(
                createUserConfirmationCheck({ latestUserText: 'x', pending: [] }),
            ),
            APP_ARGS,
        );
        const tool = createCreateWorkManualTool(
            createUserConfirmationCheck({
                latestUserText: 'yes',
                pending: [
                    { toolName: 'createWorkManual', args: first.args as Record<string, unknown> },
                ],
            }),
        );
        const out = await run(tool, { ...APP_ARGS, confirmed: true });

        expect(out).toMatchObject({ success: true, workId: 'w-app' });
        expect(mocks.createWork).toHaveBeenCalledTimes(1);
        const sent = (mocks.createWork.mock.calls[0] as unknown as [Record<string, unknown>])[0];
        expect(sent).toMatchObject({
            kind: 'app',
            repositoryUrl: 'https://github.com/calcom/cal.com',
            repositoryMode: 'fork',
            targetOwner: 'me',
            organization: false,
            description: 'Scheduling infrastructure',
        });
        expect(sent).not.toHaveProperty('blueprintId');
    });

    it('the confirmation is bound to the arguments: a different owner is a new card', async () => {
        const first = await run(
            createCreateWorkManualTool(
                createUserConfirmationCheck({ latestUserText: 'x', pending: [] }),
            ),
            APP_ARGS,
        );
        mocks.inspectAppSourceAction.mockResolvedValue({
            success: true,
            data: preview({
                targetOwners: [
                    { login: 'me', type: 'user', available: true, existingForkChecked: true },
                    {
                        login: 'acme',
                        type: 'organization',
                        available: true,
                        existingForkChecked: true,
                    },
                ],
            }),
        });
        const tool = createCreateWorkManualTool(
            createUserConfirmationCheck({
                latestUserText: 'yes',
                pending: [
                    { toolName: 'createWorkManual', args: first.args as Record<string, unknown> },
                ],
            }),
        );
        const out = await run(tool, { ...APP_ARGS, targetOwner: 'acme', confirmed: true });
        expect(out.__confirmationRequired).toBe(true);
        expect(mocks.createWork).not.toHaveBeenCalled();
    });

    it('a link names the setup pull request; a matched Blueprint is always named', async () => {
        mocks.inspectAppSourceAction.mockResolvedValue({
            success: true,
            data: preview({
                access: { canPush: true, canAdmin: true },
                modes: {
                    link: { available: true },
                    fork: { available: true },
                    'private-copy': { available: true },
                },
            }),
        });
        const out = await run(createCreateWorkManualTool(), {
            ...APP_ARGS,
            repositoryMode: 'link',
            targetOwner: undefined,
        });
        expect(out.action).toBe(
            'Create an App Work from calcom/cal.com (linked as is; a setup pull request is opened on calcom/cal.com) with the Cal App Blueprint.',
        );
        expect(out.args).not.toHaveProperty('targetOwner');
    });

    it('refuses a mode the inspection says is unavailable — no card, no create', async () => {
        const out = await run(createCreateWorkManualTool(), {
            ...APP_ARGS,
            repositoryMode: 'link',
            targetOwner: undefined,
        });
        expect(out).toMatchObject({ success: false, code: 'no_push_access', defaultMode: 'fork' });
        expect(out.__confirmationRequired).toBeUndefined();
        expect(mocks.createWork).not.toHaveBeenCalled();
    });

    it('refuses an owner that cannot receive the fork, and a fork without an owner', async () => {
        const busy = await run(createCreateWorkManualTool(), {
            ...APP_ARGS,
            targetOwner: 'busy-org',
        });
        expect(busy).toMatchObject({ success: false, code: 'fork_exists', targetOwners: ['me'] });

        const none = await run(createCreateWorkManualTool(), {
            ...APP_ARGS,
            targetOwner: undefined,
        });
        expect(none).toMatchObject({ success: false, targetOwners: ['me'] });
        expect(mocks.createWork).not.toHaveBeenCalled();
    });

    it('needs a repository and a mode before it inspects anything', async () => {
        const out = await run(createCreateWorkManualTool(), {
            ...APP_ARGS,
            repositoryMode: undefined,
        });
        expect(out).toMatchObject({ success: false });
        expect(mocks.inspectAppSourceAction).not.toHaveBeenCalled();
    });

    it('creates every other kind at once, as before', async () => {
        const out = await run(createCreateWorkManualTool(), {
            name: 'Blog',
            slug: 'blog',
            gitProvider: 'github',
            kind: 'blog',
        });
        expect(out).toMatchObject({ success: true, workId: 'w-app' });
        expect(mocks.inspectAppSourceAction).not.toHaveBeenCalled();
        expect(mocks.createWork).toHaveBeenCalledTimes(1);
    });
});

describe('the AI creator (APW-01 T25)', () => {
    it('refuses kind "app" (and "repo") in its schema', () => {
        const schema = (
            createWorkWithAITool as unknown as {
                inputSchema: { safeParse: (v: unknown) => { success: boolean } };
            }
        ).inputSchema;
        const base = { name: 'n', prompt: 'p', gitProvider: 'github' };
        expect(schema.safeParse({ ...base, workKind: 'app' }).success).toBe(false);
        expect(schema.safeParse({ ...base, workKind: 'repo' }).success).toBe(false);
        expect(schema.safeParse({ ...base, workKind: 'blog' }).success).toBe(true);
    });
});
