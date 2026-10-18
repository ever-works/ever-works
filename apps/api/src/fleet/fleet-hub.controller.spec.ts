import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NeedsALookService } from '@ever-works/agent/fleet';
import type { NeedsALookItem } from '@ever-works/contracts';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FLEET_PARTIAL_HEADER, FleetController } from './fleet.controller';
import { UpdateFleetNodeDto } from './dto/fleet.dto';

/**
 * Fleet hub (FL-01) — the routes the hub adds or widens on the existing
 * controller: the visible-node list, the needs-a-look reads, the shared
 * detail (no history for a non-owner), and the two owner-only PATCH fields.
 */

const auth = { userId: 'user-1' } as AuthenticatedUser;
const OWN = '11111111-1111-4111-8111-111111111111';
const SHARED = '22222222-2222-4222-8222-222222222222';

const view = (over: Record<string, unknown> = {}) => ({
    id: OWN,
    name: 'build-01',
    kind: 'node',
    status: 'online',
    platform: 'linux/x64',
    version: '1.0.0',
    capabilities: [],
    lastHeartbeatAt: null,
    createdAt: null,
    persisted: true,
    ...over,
});

const item = (over: Partial<NeedsALookItem> = {}): NeedsALookItem => ({
    id: 'disk-low:' + OWN,
    nodeId: OWN,
    severity: 'warn',
    kind: 'disk-low',
    title: 'Disk is 94% full',
    detail: '6 GB left',
    since: '2026-10-18T09:00:00.000Z',
    ...over,
});

function build(options: { needsALook?: NeedsALookService | null; role?: string } = {}) {
    const service = {
        listForUser: jest.fn(async () => [view()]),
        listVisibleForUser: jest.fn(async () => [
            view({ viewerRole: 'owner' }),
            view({ id: SHARED, name: 'design-mac', viewerRole: 'org-member' }),
            view({ id: 'k8s-1', kind: 'k8s', persisted: false, viewerRole: 'owner' }),
        ]),
        getVisibleForUser: jest.fn(async (_userId: string, id: string) => {
            if (id !== OWN && id !== SHARED)
                throw new NotFoundException(`Fleet node ${id} not found`);
            return {
                view: view({ id, viewerRole: options.role ?? 'owner' }),
                role: options.role ?? 'owner',
            };
        }),
        setFavoriteForUser: jest.fn(async () => view({ isFavorite: true })),
        setControlPolicyFamiliesForUser: jest.fn(async () => view()),
    };
    const jobs = {
        loadByNodeForUser: jest.fn(async () => ({ [OWN]: { activeJobCount: 2 } })),
        historyForNode: jest.fn(async () => []),
    };
    const controller = new FleetController(
        service as never,
        jobs as never,
        { snapshot: jest.fn() } as never,
        { listForUser: jest.fn() } as never,
        { describeForUser: jest.fn() } as never,
        { drainNodeForUser: jest.fn() } as never,
        { findByIds: jest.fn(async () => []) } as never,
        { recentForOwnerNode: jest.fn(async () => []) } as never,
        undefined,
        options.needsALook === null ? undefined : (options.needsALook ?? new NeedsALookService()),
    );
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => void (headers[name] = value) };
    return { controller, service, jobs, headers, res };
}

describe('GET /api/fleet/nodes — scope (FR-15)', () => {
    it('stays owner-only by default, exactly as before the hub', async () => {
        const { controller, service } = build();
        const nodes = await controller.list(auth);
        expect(service.listForUser).toHaveBeenCalledWith('user-1');
        expect(service.listVisibleForUser).not.toHaveBeenCalled();
        expect(nodes).toEqual([view({ load: { activeJobCount: 2 } })]);
    });

    it('adds the shared computers with scope=visible, without someone else’s load', async () => {
        const { controller, service } = build();
        const nodes = await controller.list(auth, 'visible');
        expect(service.listVisibleForUser).toHaveBeenCalledWith('user-1');
        expect(nodes.map((node) => [node.id, node.viewerRole, node.load])).toEqual([
            [OWN, 'owner', { activeJobCount: 2 }],
            [SHARED, 'org-member', null],
            ['k8s-1', 'owner', null],
        ]);
    });

    it('reads an unknown scope as the owner-only list (it never widens by accident)', async () => {
        const { controller, service } = build();
        await controller.list(auth, 'everyone');
        expect(service.listForUser).toHaveBeenCalledWith('user-1');
        expect(service.listVisibleForUser).not.toHaveBeenCalled();
    });
});

describe('GET /api/fleet/needs-a-look (CONTRACTS §4.6, §11.2)', () => {
    it('answers an empty list when nothing is registered (ACC-FL01-03)', async () => {
        const { controller, headers, res } = build();
        await expect(controller.needsALookFleet(auth, res)).resolves.toEqual([]);
        expect(headers[FLEET_PARTIAL_HEADER]).toBeUndefined();
    });

    it('answers an empty list when the registry is not bound at all', async () => {
        const { controller, res } = build({ needsALook: null });
        await expect(controller.needsALookFleet(auth, res)).resolves.toEqual([]);
    });

    it('asks the producers about every ENROLLED computer the caller may see', async () => {
        const registry = new NeedsALookService();
        const produce = jest.fn((_nodes: ReadonlyArray<{ id: string }>) => [
            item(),
            item({ id: 'shared', nodeId: SHARED, severity: 'critical' }),
        ]);
        registry.register({ id: 'stub', produce });
        const { controller, res, service } = build({ needsALook: registry });

        const items = await controller.needsALookFleet(auth, res);
        // Without the live cluster merge: no producer reads cluster rows.
        expect(service.listVisibleForUser).toHaveBeenCalledWith('user-1', {
            includeClusters: false,
        });
        expect(produce.mock.calls[0]?.[0].map((node) => node.id)).toEqual([OWN, SHARED]);
        expect(items.map((entry) => entry.id)).toEqual(['shared', 'disk-low:' + OWN]);
    });

    it('marks the answer partial when a producer fails, and still answers the rest (U11)', async () => {
        const registry = new NeedsALookService();
        jest.spyOn(
            (registry as never as { logger: Record<string, () => void> }).logger,
            'warn',
        ).mockImplementation(() => undefined);
        registry.register({
            id: 'broken',
            produce: () => {
                throw new Error('boom');
            },
        });
        registry.register({ id: 'ok', produce: () => [item()] });
        const { controller, headers, res } = build({ needsALook: registry });

        await expect(controller.needsALookFleet(auth, res)).resolves.toEqual([item()]);
        expect(headers[FLEET_PARTIAL_HEADER]).toBe('true');
    });
});

describe('GET /api/fleet/nodes/:id/needs-a-look', () => {
    it('answers for that one computer', async () => {
        const registry = new NeedsALookService();
        registry.register({
            id: 'stub',
            produce: (nodes) => nodes.map((node) => item({ id: node.id, nodeId: node.id })),
        });
        const { controller, res } = build({ needsALook: registry });
        await expect(controller.needsALookNode(auth, OWN, res)).resolves.toEqual([
            item({ id: OWN, nodeId: OWN }),
        ]);
    });

    it('404s a computer the caller may not see BEFORE any producer runs (FR-30)', async () => {
        const registry = new NeedsALookService();
        const produce = jest.fn(() => []);
        registry.register({ id: 'stub', produce });
        const { controller, res } = build({ needsALook: registry });
        await expect(
            controller.needsALookNode(auth, '33333333-3333-4333-8333-333333333333', res),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(produce).not.toHaveBeenCalled();
    });
});

describe('GET /api/fleet/nodes/:id — a shared computer', () => {
    it('opens it for an Organization member without reading the owner’s job history', async () => {
        const { controller, jobs } = build({ role: 'org-member' });
        const detail = await controller.detail(auth, SHARED);
        expect(detail.node).toMatchObject({ id: SHARED, viewerRole: 'org-member' });
        expect(detail.recentJobs).toEqual([]);
        expect(jobs.historyForNode).not.toHaveBeenCalled();
    });

    it('reads the history for the owner', async () => {
        const { controller, jobs } = build();
        await controller.detail(auth, OWN);
        expect(jobs.historyForNode).toHaveBeenCalledWith('user-1', OWN, 25);
    });
});

describe('PATCH /api/fleet/nodes/:id — favourite and policy families', () => {
    it('routes isFavorite to the owner-only star', async () => {
        const { controller, service } = build();
        const result = await controller.update(auth, OWN, {
            isFavorite: true,
        } as UpdateFleetNodeDto);
        expect(service.setFavoriteForUser).toHaveBeenCalledWith('user-1', OWN, true);
        expect(result.isFavorite).toBe(true);
    });

    it('routes controlPolicyFamilies to the owner-only policy write', async () => {
        const { controller, service } = build();
        await controller.update(auth, OWN, {
            controlPolicyFamilies: { sessions: 'org-admins' },
        } as UpdateFleetNodeDto);
        expect(service.setControlPolicyFamiliesForUser).toHaveBeenCalledWith('user-1', OWN, {
            sessions: 'org-admins',
        });
    });

    it('still rejects a patch with nothing actionable', async () => {
        const { controller } = build();
        await expect(controller.update(auth, OWN, {} as UpdateFleetNodeDto)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it.each([
        [
            'a valid partial map',
            { controlPolicyFamilies: { sessions: 'org-admins', logs: 'owner' } },
            true,
        ],
        ['a favourite', { isFavorite: false }, true],
        ['an unknown family', { controlPolicyFamilies: { lifecycle: 'owner' } }, false],
        ['an unknown audience', { controlPolicyFamilies: { sessions: 'everyone' } }, false],
        ['an empty map', { controlPolicyFamilies: {} }, false],
        ['a non-map', { controlPolicyFamilies: ['sessions'] }, false],
        ['a non-boolean favourite', { isFavorite: 'yes' }, false],
    ])('validates %s', async (_name, body, valid) => {
        const errors = await validate(plainToInstance(UpdateFleetNodeDto, body));
        expect(errors.length === 0).toBe(valid);
    });
});
