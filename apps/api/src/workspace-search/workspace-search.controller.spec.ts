import 'reflect-metadata';

// The controller imports `WorkspaceSearchService` as a DI token only. Pulling
// the real agent barrel drags the whole entity/TypeORM graph into this spec
// for no benefit — stub it, as schedules.controller.spec.ts does.
jest.mock('@ever-works/agent/workspace-search', () => ({
    WorkspaceSearchService: class {},
}));
jest.mock('../scope', () => ({
    ScopeContextService: class {},
}));

import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import type { WorkspaceSearchResponse } from '@ever-works/contracts/api';
import { WorkspaceSearchController } from './workspace-search.controller';
import { WorkspaceSearchQueryDto } from './dto/workspace-search-query.dto';

// Mirrors `app.useGlobalPipes(...)` in apps/api/src/main.ts.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const metadata: ArgumentMetadata = {
    type: 'query',
    metatype: WorkspaceSearchQueryDto,
    data: undefined,
};
const parse = (query: Record<string, unknown>) =>
    pipe.transform(query, metadata) as Promise<WorkspaceSearchQueryDto>;

const RESPONSE: WorkspaceSearchResponse = {
    query: 'invoice',
    groups: [
        {
            kind: 'mission',
            total: 1,
            hits: [
                {
                    id: 'mission:m1',
                    kind: 'mission',
                    sourceId: 'm1',
                    title: 'Invoice reconciliation',
                    subtitle: null,
                    statusLabel: 'active',
                    destination: '/missions/m1',
                    score: 90,
                    matchReason: 'prefix',
                    updatedAt: null,
                },
            ],
        },
    ],
    degradedKinds: [],
    servedBy: 'fanout',
    tookMs: 3,
};

function build(scope = { tenantId: 'tenant-1', organizationId: 'org-1' }) {
    const search = jest.fn().mockResolvedValue(RESPONSE);
    const controller = new WorkspaceSearchController(
        { search } as never,
        { getScope: () => scope } as never,
    );
    return { controller, search };
}

const auth = { userId: 'user-1' } as never;

describe('WorkspaceSearchController', () => {
    it('answers a query shorter than two characters with an empty payload and no service call', async () => {
        const { controller, search } = build();
        await expect(controller.search(auth, await parse({ q: ' a ' }))).resolves.toEqual({
            query: 'a',
            groups: [],
            degradedKinds: [],
            servedBy: 'fanout',
            tookMs: 0,
        });
        await expect(controller.search(auth, await parse({}))).resolves.toMatchObject({
            groups: [],
        });
        expect(search).not.toHaveBeenCalled();
    });

    it('threads the caller and the active request scope into the service', async () => {
        const { controller, search } = build({ tenantId: 'tenant-9', organizationId: 'org-9' });
        const result = await controller.search(auth, await parse({ q: 'invoice' }));
        expect(result).toBe(RESPONSE);
        expect(search).toHaveBeenCalledWith(
            { userId: 'user-1', tenantId: 'tenant-9', organizationId: 'org-9' },
            expect.objectContaining({ query: 'invoice' }),
        );
    });

    it('threads the personal scope (no Organization) unchanged', async () => {
        const { controller, search } = build({
            tenantId: 'tenant-1',
            organizationId: null as never,
        });
        await controller.search(auth, await parse({ q: 'invoice' }));
        expect(search.mock.calls[0][0]).toEqual({
            userId: 'user-1',
            tenantId: 'tenant-1',
            organizationId: null,
        });
    });

    it('carries the per-route throttle of 120 requests per minute', () => {
        const keys = Reflect.getMetadataKeys(
            WorkspaceSearchController.prototype.search,
        ) as string[];
        const values = Object.fromEntries(
            keys.map((key) => [
                key,
                Reflect.getMetadata(key, WorkspaceSearchController.prototype.search),
            ]),
        );
        expect(values).toEqual(
            expect.objectContaining({ 'THROTTLER:LIMITlong': 120, 'THROTTLER:TTLlong': 60_000 }),
        );
    });
});

describe('WorkspaceSearchQueryDto', () => {
    it('clamps limit and perKindLimit instead of rejecting them', async () => {
        await expect(parse({ q: 'ab', limit: '999', perKindLimit: '0' })).resolves.toMatchObject({
            limit: 60,
            perKindLimit: 1,
        });
        await expect(parse({ q: 'ab', limit: 'abc', perKindLimit: '30' })).resolves.toMatchObject({
            limit: 60,
            perKindLimit: 25,
        });
    });

    it('ignores unknown kinds rather than answering 400', async () => {
        await expect(
            parse({ q: 'ab', kinds: ['task', 'nonsense', 'mission'] }),
        ).resolves.toMatchObject({
            kinds: ['task', 'mission'],
        });
        await expect(parse({ q: 'ab', kinds: 'agent,bogus' })).resolves.toMatchObject({
            kinds: ['agent'],
        });
    });

    it('truncates an over-long query', async () => {
        const dto = await parse({ q: 'x'.repeat(300) });
        expect(dto.q).toHaveLength(128);
    });

    it('keeps only well-formed recent keys, at most twelve', async () => {
        const recent = [
            ...Array.from({ length: 14 }, (_, i) => `task:t${i}`),
            'nope',
            'mission:has spaces',
        ];
        const dto = await parse({ q: 'ab', recent });
        expect(dto.recent).toHaveLength(12);
        expect(dto.recent?.every((key) => key.startsWith('task:'))).toBe(true);
    });

    it('still rejects an undeclared parameter', async () => {
        await expect(parse({ q: 'ab', sort: 'name' })).rejects.toBeInstanceOf(BadRequestException);
    });
});
