import 'reflect-metadata';
import {
    BadRequestException,
    NotFoundException,
    RequestMethod,
    ValidationPipe,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SkillReadinessService } from '@ever-works/agent/skills';
import { SkillsController, SKILL_READINESS_REFRESH_BUDGET_MS } from './skills.controller';
import { ListSkillsQueryDto, ListSkillTagsQueryDto } from './dto/skill.dto';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Skills shelf — the controller surface: the extended list, the tag facet,
 * the on/off switch and the readiness endpoints.
 *
 * Pinned: a list call with none of the new params builds the same filter as
 * before; every new param reaches the repository; 7 tags or a malformed tag
 * is a 400 with the product's copy; `GET tags` is declared before every `:id`
 * route; every id-addressed endpoint answers 404 for someone else's Skill; a
 * re-check that overruns its budget returns the cached verdict labelled
 * stale.
 */
const AUTH = { userId: 'u1' } as AuthenticatedUser;
const ID = '11111111-1111-4111-8111-111111111111';

function skillRow(over: Record<string, unknown> = {}) {
    return {
        id: ID,
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: 'invoicing',
        title: 'Invoicing',
        description: 'd',
        frontmatter: { name: 'invoicing', description: 'd' },
        instructionsMd: '# body',
        contentHash: 'h',
        version: '1.0.0',
        sourceCatalogSlug: null,
        sourcePath: null,
        readiness: 'missing_requirements',
        readinessDetail: {
            requirements: [
                { kind: 'credential', id: 'stripe_key', status: 'missing', reason: 'notSet' },
            ],
            boundTargetCount: 1,
            mutedBindingCount: 0,
            evaluatedForAgentIds: [],
            evaluatedAt: '2026-09-14T00:00:00.000Z',
        },
        readinessCheckedAt: new Date('2026-09-14T00:00:00.000Z'),
        disabledAt: null,
        reviewState: null,
        ...over,
    };
}

const COUNTS = {
    ready: 3,
    needs_setup: 1,
    missing_requirements: 1,
    blocked_by_access: 0,
    unknown: 0,
    check_failed: 0,
    disabled: 1,
    needs_review: 0,
};

function build(opts: { wired?: boolean } = {}) {
    const wired = opts.wired ?? true;
    const skills = {
        findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [skillRow()], total: 1 }),
        findByIdAndUser: jest.fn().mockResolvedValue(skillRow()),
        countsByCardState: jest.fn().mockResolvedValue(COUNTS),
    };
    const service = {
        getOne: jest.fn(async (userId: string) => {
            if (userId !== 'u1') throw new NotFoundException(`Skill ${ID} not found.`);
            return skillRow();
        }),
        enable: jest
            .fn()
            .mockResolvedValue({ id: ID, cardState: 'ready', disabledAt: null, changed: true }),
        disable: jest.fn().mockResolvedValue({
            id: ID,
            cardState: 'disabled',
            disabledAt: new Date(),
            changed: true,
        }),
        create: jest.fn(async (_u: string, input: { frontmatter?: unknown }) => ({
            id: ID,
            frontmatter: input.frontmatter,
        })),
        update: jest.fn(async (_u: string, _id: string, input: { frontmatter?: unknown }) => ({
            id: ID,
            frontmatter: input.frontmatter,
        })),
    };
    const readiness = {
        refreshSkill: jest.fn(async (skill: Record<string, unknown>) => {
            skill.readiness = 'ready';
            skill.readinessDetail = null;
            return { readiness: 'ready' };
        }),
        recheckVisible: jest.fn().mockResolvedValue(0),
    };
    const tags = {
        findBySkillIds: jest.fn().mockResolvedValue(new Map([[ID, ['billing', 'email']]])),
        facets: jest.fn().mockResolvedValue({ tags: [{ tag: 'billing', count: 2 }], total: 1 }),
    };
    const bindings = { countBySkillIds: jest.fn().mockResolvedValue(new Map([[ID, 2]])) };
    const registry = {
        getByCapability: jest.fn(() => [
            { manifest: { id: 'default-provider', defaultForCapabilities: ['skills-provider'] } },
        ]),
    };
    const controller = new SkillsController(
        skills as never,
        {} as never,
        service as never,
        {} as never,
        {} as never,
        {} as never,
        wired ? (readiness as never) : undefined,
        wired ? (tags as never) : undefined,
        wired ? (bindings as never) : undefined,
        wired ? (registry as never) : undefined,
    );
    return { controller, skills, service, readiness, tags, bindings };
}

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const parseList = (query: Record<string, unknown>) =>
    pipe.transform(query, {
        type: 'query',
        metatype: ListSkillsQueryDto,
    }) as Promise<ListSkillsQueryDto>;

describe('ListSkillsQueryDto — shelf params', () => {
    it('accepts no shelf params, exactly as before', async () => {
        const dto = await parseList({ search: 'x', limit: '10' });
        expect(dto.tags).toBeUndefined();
        expect(dto.readiness).toBeUndefined();
        expect(dto.sort).toBeUndefined();
    });

    it('parses comma-separated tags, readiness, provenance, enabled and sort', async () => {
        const dto = await parseList({
            tags: 'billing, email',
            readiness: 'attention',
            provenance: 'firstParty',
            enabled: 'false',
            sort: 'attention',
        });
        expect(dto).toMatchObject({
            tags: ['billing', 'email'],
            readiness: 'attention',
            provenance: 'firstParty',
            enabled: false,
            sort: 'attention',
        });
    });

    it('rejects a seventh tag with the product copy', async () => {
        const err = await parseList({ tags: 'a,b,c,d,e,f,g' }).catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(JSON.stringify(err.getResponse())).toContain(
            'Six tags is the limit for one filter.',
        );
    });

    it.each([['Billing'], ['bad tag'], ['-lead'], ['x'.repeat(41)]])(
        'rejects the malformed tag %p',
        async (tag) => {
            await expect(parseList({ tags: tag })).rejects.toBeInstanceOf(BadRequestException);
        },
    );

    it.each([
        ['readiness', 'broken'],
        ['provenance', 'stolen'],
        ['sort', 'random'],
        ['enabled', 'maybe'],
    ])('rejects %s=%p', async (key, value) => {
        await expect(parseList({ [key]: value })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('caps the tag facet limit at 200', async () => {
        const parseTags = (query: Record<string, unknown>) =>
            pipe.transform(query, { type: 'query', metatype: ListSkillTagsQueryDto });
        await expect(parseTags({ limit: '201' })).rejects.toBeInstanceOf(BadRequestException);
        await expect(parseTags({ limit: '200' })).resolves.toMatchObject({ limit: 200 });
    });
});

describe('SkillsController — GET /api/skills (shelf)', () => {
    it('with no shelf params passes exactly the pre-shelf filter', async () => {
        const { controller, skills } = build();
        await controller.list(AUTH, { search: 'inv' } as ListSkillsQueryDto);
        expect(skills.findByUserIdFiltered).toHaveBeenCalledWith('u1', {
            ownerType: undefined,
            ownerId: undefined,
            search: 'inv',
            limit: 50,
            offset: 0,
        });
    });

    it('passes every shelf filter through, with provenance ids resolved from the registry', async () => {
        const { controller, skills } = build();
        await controller.list(AUTH, {
            tags: ['billing'],
            readiness: 'attention',
            provenance: 'firstParty',
            enabled: true,
            sort: 'name',
        } as ListSkillsQueryDto);
        expect(skills.findByUserIdFiltered.mock.calls[0][1]).toMatchObject({
            tags: ['billing'],
            readiness: 'attention',
            provenance: 'firstParty',
            enabled: true,
            sort: 'name',
            provenanceSources: { firstPartyProviderIds: ['default-provider'] },
        });
    });

    it('projects tags, card state, provenance and reach in batched calls, keeps every existing field, and returns counts', async () => {
        const { controller, tags, bindings } = build();
        const out = await controller.list(AUTH, {} as ListSkillsQueryDto);
        expect(tags.findBySkillIds).toHaveBeenCalledWith([ID], 'u1');
        expect(bindings.countBySkillIds).toHaveBeenCalledWith([ID], 'u1');
        expect(out.meta).toEqual({ total: 1, limit: 50, offset: 0 });
        expect(out.counts).toEqual(COUNTS);
        expect(out.data[0]).toMatchObject({
            id: ID,
            slug: 'invoicing',
            instructionsMd: '# body',
            tags: ['billing', 'email'],
            cardState: 'missing_requirements',
            provenance: 'authored',
            boundTargetCount: 2,
        });
    });

    it('still answers when the shelf dependencies are not wired', async () => {
        const { controller } = build({ wired: false });
        const out = await controller.list(AUTH, {} as ListSkillsQueryDto);
        expect(out.data[0]).toMatchObject({
            tags: [],
            boundTargetCount: 0,
            provenance: 'authored',
        });
    });
});

describe('SkillsController — GET /api/skills/tags', () => {
    it('returns the facets for the caller, capped by the requested limit', async () => {
        const { controller, tags } = build();
        expect(await controller.tags(AUTH, { limit: 12 })).toEqual({
            tags: [{ tag: 'billing', count: 2 }],
            total: 1,
        });
        expect(tags.facets).toHaveBeenCalledWith('u1', 12);
        await controller.tags(AUTH, {});
        expect(tags.facets).toHaveBeenLastCalledWith('u1', 200);
    });

    it('is declared before every :id route so an id of "tags" cannot shadow it', () => {
        const proto = SkillsController.prototype as unknown as Record<string, unknown>;
        const getRoutes = Object.getOwnPropertyNames(proto)
            .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
            .filter(
                (name) => Reflect.getMetadata(METHOD_METADATA, proto[name]) === RequestMethod.GET,
            )
            .map((name) => Reflect.getMetadata(PATH_METADATA, proto[name]) as string);
        const tagsIndex = getRoutes.indexOf('tags');
        const firstIdIndex = getRoutes.findIndex((path) => path.startsWith(':id'));
        expect(tagsIndex).toBeGreaterThanOrEqual(0);
        expect(tagsIndex).toBeLessThan(firstIdIndex);
    });
});

describe('SkillsController — on/off switch', () => {
    it('disable and enable answer with the card state and the stored verdict', async () => {
        const { controller, service } = build();
        const off = await controller.disable(AUTH, ID);
        expect(service.disable).toHaveBeenCalledWith('u1', ID);
        expect(off).toMatchObject({
            id: ID,
            cardState: 'disabled',
            readiness: 'missing_requirements',
            changed: true,
        });
        const on = await controller.enable(AUTH, ID);
        expect(on).toMatchObject({ id: ID, cardState: 'ready', disabledAt: null });
    });

    it('carries the throttle on both verbs', () => {
        for (const name of ['enable', 'disable'] as const) {
            const handler = SkillsController.prototype[name];
            const keys = Reflect.getMetadataKeys(handler).map(String);
            expect(keys.some((key) => key.includes('THROTTLER'))).toBe(true);
        }
    });
});

describe('SkillsController — readiness', () => {
    it('GET :id/readiness returns the cached verdict with identifiers only', async () => {
        const { controller } = build();
        const out = await controller.getReadiness(AUTH, ID);
        expect(out).toMatchObject({
            id: ID,
            readiness: 'missing_requirements',
            cardState: 'missing_requirements',
        });
        expect(out.readinessDetail?.requirements[0]).toEqual({
            kind: 'credential',
            id: 'stripe_key',
            status: 'missing',
            reason: 'notSet',
        });
    });

    it('POST :id/readiness/refresh returns the fresh verdict', async () => {
        const { controller, readiness } = build();
        const out = await controller.refreshReadiness(AUTH, ID);
        expect(readiness.refreshSkill).toHaveBeenCalledTimes(1);
        expect(out).toMatchObject({ readiness: 'ready', cardState: 'ready' });
        expect(out.stale).toBeUndefined();
    });

    it('a re-check over its budget returns the cached verdict as Couldn’t check, marked stale', async () => {
        jest.useFakeTimers();
        try {
            const { controller, readiness } = build();
            readiness.refreshSkill.mockImplementation(() => new Promise(() => undefined));
            const pending = controller.refreshReadiness(AUTH, ID);
            await jest.advanceTimersByTimeAsync(SKILL_READINESS_REFRESH_BUDGET_MS + 1);
            const out = await pending;
            expect(out).toMatchObject({
                readiness: 'missing_requirements',
                cardState: 'check_failed',
                stale: true,
            });
        } finally {
            jest.useRealTimers();
        }
    });

    it('a re-check that throws never reports ready', async () => {
        const { controller, readiness } = build();
        readiness.refreshSkill.mockRejectedValue(new Error('db down'));
        const out = await controller.refreshReadiness(AUTH, ID);
        expect(out.cardState).toBe('check_failed');
        expect(out.stale).toBe(true);
    });
});

describe('SkillsController — GET /api/skills re-checks unchecked Skills in the background', () => {
    const flush = async () => {
        for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    it('hands the visible rows to the bounded re-check without waiting for it', async () => {
        const { controller, readiness } = build();
        let finish: () => void = () => undefined;
        readiness.recheckVisible.mockImplementation(
            () => new Promise<number>((resolve) => (finish = () => resolve(1))),
        );
        const out = await controller.list(AUTH, {} as ListSkillsQueryDto);
        expect(out.data).toHaveLength(1);
        await flush();
        expect(readiness.recheckVisible).toHaveBeenCalledTimes(1);
        expect(
            readiness.recheckVisible.mock.calls[0][0].map((row: { id: string }) => row.id),
        ).toEqual([ID]);
        finish();
    });

    it('still returns the list when the re-check rejects or throws', async () => {
        const { controller, readiness } = build();
        readiness.recheckVisible.mockRejectedValueOnce(new Error('db down'));
        await expect(controller.list(AUTH, {} as ListSkillsQueryDto)).resolves.toMatchObject({
            meta: { total: 1 },
        });
        readiness.recheckVisible.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        await expect(controller.list(AUTH, {} as ListSkillsQueryDto)).resolves.toMatchObject({
            meta: { total: 1 },
        });
        await flush();
    });

    it('still returns the list, unchanged, when evaluating an unchecked Skill throws', async () => {
        const { skills, service } = build();
        const neverChecked = skillRow({
            readiness: 'unknown',
            readinessDetail: null,
            readinessCheckedAt: null,
        });
        skills.findByUserIdFiltered.mockResolvedValue({ rows: [neverChecked], total: 1 });
        const failingSkills = {
            recordReadiness: jest.fn().mockRejectedValue(new Error('write failed')),
        };
        const failingBindings = {
            findBySkillId: jest.fn().mockRejectedValue(new Error('db down')),
        };
        const realReadiness = new SkillReadinessService(
            failingSkills as never,
            failingBindings as never,
        );
        jest.spyOn(
            (realReadiness as unknown as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        const recheck = jest.spyOn(realReadiness, 'recheckVisible');
        const controller = new SkillsController(
            skills as never,
            {} as never,
            service as never,
            {} as never,
            {} as never,
            {} as never,
            realReadiness,
        );

        const out = await controller.list(AUTH, {} as ListSkillsQueryDto);
        expect(out.data[0]).toMatchObject({ id: ID, readiness: 'unknown', cardState: 'unknown' });
        await flush();
        expect(recheck).toHaveBeenCalledTimes(1);
        await expect(recheck.mock.results[0].value).resolves.toBe(0);
        expect(failingSkills.recordReadiness).toHaveBeenCalledTimes(1);
        // The row already handed back was never touched by the failed re-check.
        expect(out.data[0]).toMatchObject({ readiness: 'unknown', readinessCheckedAt: null });
    });

    it('does nothing when readiness is not wired', async () => {
        const { controller } = build({ wired: false });
        await expect(controller.list(AUTH, {} as ListSkillsQueryDto)).resolves.toBeDefined();
    });
});

describe('SkillsController — cross-workspace ids answer 404 on every shelf verb', () => {
    const OTHER = { userId: 'u2' } as AuthenticatedUser;

    it.each([
        ['GET :id/readiness', (c: SkillsController) => c.getReadiness(OTHER, ID)],
        ['POST :id/readiness/refresh', (c: SkillsController) => c.refreshReadiness(OTHER, ID)],
    ])('%s', async (_label, call) => {
        const { controller, readiness } = build();
        await expect(call(controller)).rejects.toBeInstanceOf(NotFoundException);
        expect(readiness.refreshSkill).not.toHaveBeenCalled();
    });

    it.each([['enable'], ['disable']] as const)('POST :id/%s', async (verb) => {
        const { controller, service } = build();
        service[verb].mockRejectedValue(new NotFoundException(`Skill ${ID} not found.`));
        await expect(controller[verb](OTHER, ID)).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('SkillsController — tags dropped on write (FR-10)', () => {
    it('reports the tags past the twelfth, and adds nothing when none were dropped', async () => {
        const { controller } = build();
        const many = Array.from({ length: 15 }, (_, i) => `t${i}`);
        const created = (await controller.create(AUTH, {
            ownerType: 'tenant',
            ownerId: 'u1',
            title: 'x',
            description: 'd',
            instructionsMd: '#',
            frontmatter: { tags: many },
        } as never)) as unknown as { tagsDropped?: string[] };
        expect(created.tagsDropped).toEqual(['t12', 't13', 't14']);

        const updated = (await controller.update(AUTH, ID, {
            frontmatter: { tags: ['a'] },
        } as never)) as unknown as Record<string, unknown>;
        expect(updated).not.toHaveProperty('tagsDropped');
    });
});
