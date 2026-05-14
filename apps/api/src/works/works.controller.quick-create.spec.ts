// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph.
jest.mock('@ever-works/agent/dto', () => ({}));
jest.mock('@ever-works/agent/items-generator', () => ({
    CreateItemsGeneratorDto: class CreateItemsGeneratorDto {
        name?: string;
        prompt?: string;
        model?: string;
    },
}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/comparison-generator', () => ({}));
jest.mock('@ever-works/agent/template-catalog', () => ({}));
jest.mock('@ever-works/agent/generators', () => ({
    getDefaultWebsiteTemplateId: jest.fn(() => 'default-template'),
}));
jest.mock('@ever-works/agent/community-pr', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({ CACHE_MANAGER: 'CACHE_MANAGER' }));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        WORK_CREATED: 'WORK_CREATED',
        GENERATION: 'GENERATION',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED', IN_PROGRESS: 'IN_PROGRESS' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

function makeController(overrides: {
    createWorkResult?: unknown;
    generateResult?: unknown;
    generateThrows?: Error;
}) {
    const createWork = jest.fn().mockResolvedValue(
        overrides.createWorkResult ?? {
            status: 'success',
            work: { id: 'w-1', slug: 'my-slug', name: 'My Slug' },
        },
    );
    const generateItems = overrides.generateThrows
        ? jest.fn().mockRejectedValue(overrides.generateThrows)
        : jest.fn().mockResolvedValue(
              overrides.generateResult ?? {
                  status: 'pending',
                  historyId: 'gen-1',
                  message: 'Generation started',
              },
          );

    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const authService = { getUser: jest.fn().mockResolvedValue({ id: 'user-1' }) };

    const controller = new WorksController(
        { wrap: jest.fn() } as any,
        { typeormAdapter: { deleteUnscopedEntriesLike: jest.fn() } } as any,
        {} as any,
        { createWork } as any,
        { generateItems, updateItemsGenerator: jest.fn(), cancelGeneration: jest.fn() } as any,
        authService as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        activityLog as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { rotate: jest.fn(), getOrGenerate: jest.fn() } as any,
    );

    return { controller, createWork, generateItems, activityLog, authService };
}

const baseDto = {
    slug: 'ai-coding-assistants',
    name: 'AI Coding Assistants',
    description: 'A curated directory of AI coding assistants',
    prompt: 'AI coding assistants directory with reviews and pricing',
    organization: false,
};

describe('WorksController.quickCreateWork (EW-617 G4)', () => {
    it('creates the work then kicks off generation and returns the combined response', async () => {
        const { controller, createWork, generateItems, activityLog } = makeController({});

        const result = await (controller as any).quickCreateWork(auth, baseDto);

        expect(createWork).toHaveBeenCalledTimes(1);
        const createDtoArg = createWork.mock.calls[0][0];
        expect(createDtoArg).toMatchObject({
            slug: 'ai-coding-assistants',
            name: 'AI Coding Assistants',
            description: 'A curated directory of AI coding assistants',
            organization: false,
            gitProvider: 'github',
        });
        // Prompt is NOT passed to createWork — it belongs in the generator DTO.
        expect(createDtoArg.prompt).toBeUndefined();

        expect(generateItems).toHaveBeenCalledTimes(1);
        const [workId, generatorDto, , awaitCompletion] = generateItems.mock.calls[0];
        expect(workId).toBe('w-1');
        expect(generatorDto.prompt).toBe(baseDto.prompt);
        expect(generatorDto.name).toBe(baseDto.name);
        expect(awaitCompletion).toBe(false);

        expect(result).toEqual({
            status: 'pending',
            work: { id: 'w-1', slug: 'my-slug', name: 'My Slug' },
            generation: { historyId: 'gen-1', message: 'Generation started' },
        });

        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                workId: 'w-1',
                action: 'work.quick_create',
            }),
        );
    });

    it('passes through provider overrides when supplied', async () => {
        const { controller, createWork } = makeController({});

        await (controller as any).quickCreateWork(auth, {
            ...baseDto,
            deployProvider: 'k8s',
            storageProvider: 'ever-works-git',
            gitProvider: 'gitlab',
            websiteTemplateId: 'modern',
            model: 'claude-3-haiku',
        });

        expect(createWork).toHaveBeenCalledTimes(1);
        const createDtoArg = createWork.mock.calls[0][0];
        expect(createDtoArg.deployProvider).toBe('k8s');
        expect(createDtoArg.storageProvider).toBe('ever-works-git');
        expect(createDtoArg.gitProvider).toBe('gitlab');
        expect(createDtoArg.websiteTemplateId).toBe('modern');
    });

    it('forwards model to the generator DTO but never to createWork', async () => {
        const { controller, createWork, generateItems } = makeController({});

        await (controller as any).quickCreateWork(auth, { ...baseDto, model: 'gpt-4o-mini' });

        const generatorDto = generateItems.mock.calls[0][1];
        expect(generatorDto.model).toBe('gpt-4o-mini');
        expect(createWork.mock.calls[0][0].model).toBeUndefined();
    });

    it('throws BadRequestException when createWork returns a non-success status', async () => {
        const { controller } = makeController({
            createWorkResult: { status: 'error', work: null },
        });

        await expect((controller as any).quickCreateWork(auth, baseDto)).rejects.toThrow(
            BadRequestException,
        );
    });

    it('bubbles up generation errors after creating the work (caller polls or retries)', async () => {
        const { controller, createWork } = makeController({
            generateThrows: new Error('queue full'),
        });

        await expect((controller as any).quickCreateWork(auth, baseDto)).rejects.toThrow(
            'queue full',
        );
        // The work was created — caller can retry just the generation step
        // via POST /works/:id/generate.
        expect(createWork).toHaveBeenCalledTimes(1);
    });

    it("defaults organization to false when omitted", async () => {
        const { controller, createWork } = makeController({});

        const dto: any = { ...baseDto };
        delete dto.organization;
        await (controller as any).quickCreateWork(auth, dto);

        expect(createWork.mock.calls[0][0].organization).toBe(false);
    });
});
