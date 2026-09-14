// The agent barrels drag the whole entity/ESM graph through Jest's CJS
// transformer; the catalogue needs exactly two agent modules, so the barrels
// resolve to those REAL modules and nothing else. The readiness logic under
// test is the production code, not a stub.
jest.mock('@ever-works/agent/services', () => ({
    ...jest.requireActual('../../../../packages/agent/src/services/playbook-readiness.service'),
    ...jest.requireActual('../../../../packages/agent/src/services/playbook-adoption-plan'),
}));
jest.mock('@ever-works/agent/facades', () => ({
    PlaybookCatalogFacadeService: class PlaybookCatalogFacadeService {},
}));
// The auth barrel boots the ESM-only auth runtime; the controller only needs
// the guard class (as metadata) and the parameter decorator.
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PlaybookCatalogEntry } from '@ever-works/contracts';
import { PlaybookReadinessService } from '@ever-works/agent/services';
import { AuthSessionGuard } from '../auth';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CatalogController } from './catalog.controller';
import { ListPlaybooksDto, PreflightPlaybookDto } from './catalog.dto';
import { PlaybookCatalogService, playbookSearchRank } from './playbook-catalog.service';

const AUTH = { userId: 'user-1' } as AuthenticatedUser;

function playbook(slug: string, extra: Partial<PlaybookCatalogEntry> = {}): PlaybookCatalogEntry {
    return {
        slug,
        title: `Title ${slug}`,
        outcome: 'An outcome.',
        summary: 'A summary.',
        category: 'reporting',
        version: '1.0.0',
        icon: 'report',
        trigger: {
            kind: 'schedule',
            cadence: '0 7 * * 1',
            defaultLocalTime: '07:00',
            description: 'Mondays',
        },
        steps: [
            { position: 1, title: 'Read the week', produces: 'A list.', requiresApproval: false },
            { position: 2, title: 'Write it', produces: 'A doc.', requiresApproval: true },
        ],
        connections: [],
        artefacts: [{ kind: 'kb_document', title: 'Doc', where: 'Reports' }],
        escalations: [{ when: 'Always', becomes: 'approval', carriesRecommendation: true }],
        caps: {},
        costBand: 'low',
        estimatedTokensPerRun: { min: 1, max: 2 },
        tags: [],
        provision: {
            agentTemplateSlug: 'content-marketer',
            agentName: 'Reporter',
            skillSlugs: ['digest-compilation'],
            taskTemplate: { name: 'Template', slug: 'template' },
            guardrailsAtAdoption: { mode: 'require_approval' },
        },
        ...extra,
    };
}

const CATALOGUE = [
    playbook('weekly-report', { title: 'Weekly report', tags: ['reporting'] }),
    playbook('summary-hit', { title: 'Something', summary: 'A weekly digest of things.' }),
    playbook('tag-hit', { title: 'Another', tags: ['weekly'] }),
    playbook('needs-search', {
        category: 'research',
        connections: [{ capability: 'search', required: true, reason: 'Find things.' }],
    }),
];

function build(options: { searchEnabled?: boolean; agents?: string[] } = {}) {
    const facade = { listEntries: jest.fn().mockResolvedValue(CATALOGUE) };
    const registry = {
        getEnabledPluginsScoped: jest.fn(async () =>
            options.searchEnabled
                ? [
                      {
                          plugin: { id: 'search-plugin', name: 'Search' },
                          manifest: { name: 'Search' },
                      },
                  ]
                : [],
        ),
    };
    const agents = {
        findByUserIdScoped: jest.fn(async () => ({
            rows: (options.agents ?? []).map((name) => ({ name })),
            total: 0,
        })),
    };
    const readiness = new PlaybookReadinessService(registry as never, agents as never);
    const service = new PlaybookCatalogService(facade as never, readiness);
    return { controller: new CatalogController(service), facade, registry, agents };
}

async function dto<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
    const instance = plainToInstance(cls, plain);
    return { instance, errors: await validate(instance) };
}

describe('CatalogController', () => {
    it('is guarded by the session guard', () => {
        expect(Reflect.getMetadata(GUARDS_METADATA, CatalogController)).toContain(AuthSessionGuard);
    });

    describe('GET /api/catalog/playbooks', () => {
        it('lists every playbook with the caller’s readiness', async () => {
            const { controller, registry } = build();
            const result = await controller.list(AUTH, {});
            expect(result.total).toBe(4);
            expect(result.items.map((item) => [item.slug, item.readiness])).toEqual([
                ['weekly-report', 'ready'],
                ['summary-hit', 'ready'],
                ['tag-hit', 'ready'],
                ['needs-search', 'needs_connection'],
            ]);
            expect(result.items[3].missingRequired).toEqual(['search']);
            expect(registry.getEnabledPluginsScoped).toHaveBeenCalledWith(
                'search',
                undefined,
                'user-1',
            );
        });

        it('filters by category', async () => {
            const { controller } = build();
            const result = await controller.list(AUTH, { category: 'research' });
            expect(result.items.map((item) => item.slug)).toEqual(['needs-search']);
        });

        it('ranks a title match above a tag match above a summary match', async () => {
            const { controller } = build();
            const result = await controller.list(AUTH, { search: 'weekly' });
            expect(result.items.map((item) => item.slug)).toEqual([
                'weekly-report',
                'tag-hit',
                'summary-hit',
            ]);
            expect(result.total).toBe(3);
        });

        it('returns an empty page, not an error, when nothing matches', async () => {
            const { controller } = build();
            await expect(controller.list(AUTH, { search: 'zzz' })).resolves.toEqual({
                items: [],
                total: 0,
            });
        });

        it('filters by readiness and reflects an enabled provider', async () => {
            const blocked = build();
            expect(
                (await blocked.controller.list(AUTH, { readiness: 'needs_connection' })).total,
            ).toBe(1);
            const enabled = build({ searchEnabled: true });
            expect(
                (await enabled.controller.list(AUTH, { readiness: 'needs_connection' })).total,
            ).toBe(0);
            expect((await enabled.controller.list(AUTH, { readiness: 'ready' })).total).toBe(4);
        });

        it('pages with limit and offset while reporting the true total', async () => {
            const { controller } = build();
            const page = await controller.list(AUTH, { limit: 2, offset: 1 });
            expect(page.items.map((item) => item.slug)).toEqual(['summary-hit', 'tag-hit']);
            expect(page.total).toBe(4);
        });

        it('serves the catalogue from the per-caller cache on a second read', async () => {
            const { controller, facade } = build();
            await controller.list(AUTH, {});
            await controller.list(AUTH, {});
            expect(facade.listEntries).toHaveBeenCalledTimes(1);
            await controller.list({ userId: 'user-2' } as AuthenticatedUser, {});
            expect(facade.listEntries).toHaveBeenCalledTimes(2);
        });
    });

    describe('ListPlaybooksDto', () => {
        it('clamps limit at 50', async () => {
            const { instance, errors } = await dto(ListPlaybooksDto, { limit: '500' });
            expect(errors).toEqual([]);
            expect(instance.limit).toBe(50);
        });

        it('rejects a limit below 1 and a negative offset', async () => {
            expect((await dto(ListPlaybooksDto, { limit: '0' })).errors).toHaveLength(1);
            expect((await dto(ListPlaybooksDto, { offset: '-1' })).errors).toHaveLength(1);
        });

        it('requires a search of 2–64 characters', async () => {
            expect((await dto(ListPlaybooksDto, { search: 'a' })).errors).toHaveLength(1);
            expect((await dto(ListPlaybooksDto, { search: 'x'.repeat(65) })).errors).toHaveLength(
                1,
            );
            expect((await dto(ListPlaybooksDto, { search: 'we' })).errors).toEqual([]);
        });

        it('accepts only known categories and readiness filters', async () => {
            expect((await dto(ListPlaybooksDto, { category: 'sales' })).errors).toHaveLength(1);
            expect((await dto(ListPlaybooksDto, { readiness: 'blocked' })).errors).toHaveLength(1);
            expect(
                (await dto(ListPlaybooksDto, { category: 'inbox', readiness: 'adopted' })).errors,
            ).toEqual([]);
        });

        it('validates the preflight body', async () => {
            expect((await dto(PreflightPlaybookDto, { workId: 'nope' })).errors).toHaveLength(1);
            expect((await dto(PreflightPlaybookDto, { instanceName: '' })).errors).toHaveLength(1);
            expect(
                (await dto(PreflightPlaybookDto, { instanceName: 'x'.repeat(201) })).errors,
            ).toHaveLength(1);
            expect((await dto(PreflightPlaybookDto, {})).errors).toEqual([]);
        });
    });

    describe('GET /api/catalog/playbooks/:slug', () => {
        it('returns the entry and full readiness, including a name collision', async () => {
            const { controller } = build({ agents: ['Reporter'] });
            const result = await controller.detail(AUTH, 'weekly-report');
            expect(result.entry.slug).toBe('weekly-report');
            expect(result.readiness.state).toBe('ready');
            expect(result.readiness.collisions).toEqual([
                { type: 'agent_name', requested: 'Reporter', suggested: 'Reporter 2' },
            ]);
        });

        it('404s an unknown slug with a machine code', async () => {
            const { controller } = build();
            await expect(controller.detail(AUTH, 'does-not-exist')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await controller.detail(AUTH, 'does-not-exist').catch((err: NotFoundException) => {
                expect(err.getResponse()).toMatchObject({ code: 'playbook_not_found' });
            });
        });

        it('400s a malformed slug before reading anything', async () => {
            const { controller, facade } = build();
            await expect(controller.detail(AUTH, 'Not A Slug')).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(facade.listEntries).not.toHaveBeenCalled();
        });
    });

    describe('POST /api/catalog/playbooks/:slug/preflight', () => {
        it('returns readiness plus the itemised plan with the de-duplicated agent name', async () => {
            const { controller } = build({ agents: ['Reporter'] });
            const report = await controller.preflight(AUTH, 'weekly-report', {
                instanceName: 'Monday report',
            });
            expect(report.state).toBe('ready');
            expect(report.plan.instanceName).toBe('Monday report');
            expect(report.plan.items[0]).toMatchObject({ type: 'agent', names: ['Reporter 2'] });
            expect(report.plan.planHash).toMatch(/^[0-9a-f]{64}$/);
        });

        it('reports a missing required connection and still itemises the plan', async () => {
            const { controller } = build();
            const report = await controller.preflight(AUTH, 'needs-search', {});
            expect(report.state).toBe('needs_connection');
            expect(report.missingRequired).toEqual(['search']);
            expect(report.plan.items.length).toBeGreaterThan(0);
        });

        it('only reads — it never calls anything that writes', async () => {
            const { controller, facade, registry, agents } = build();
            for (let i = 0; i < 20; i++) {
                await controller.preflight(AUTH, 'weekly-report', {});
            }
            const touched = [facade, registry, agents].flatMap((stub) => Object.keys(stub));
            expect(touched.sort()).toEqual([
                'findByUserIdScoped',
                'getEnabledPluginsScoped',
                'listEntries',
            ]);
        });

        it('404s an unknown slug and 400s a malformed one', async () => {
            const { controller } = build();
            await expect(controller.preflight(AUTH, 'missing', {})).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await expect(controller.preflight(AUTH, '../etc', {})).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });
});

describe('playbookSearchRank', () => {
    it('returns null when nothing matches and 3 for a step-title-only match', () => {
        const entry = playbook('x', { title: 'Alpha', summary: 'Beta', outcome: 'Gamma' });
        expect(playbookSearchRank(entry, 'zzz')).toBeNull();
        expect(playbookSearchRank(entry, 'read the')).toBe(3);
        expect(playbookSearchRank(entry, 'gamma')).toBe(2);
    });
});
