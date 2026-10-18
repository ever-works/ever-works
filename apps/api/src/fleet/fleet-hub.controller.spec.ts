import 'reflect-metadata';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
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

function build(
    options: {
        needsALook?: NeedsALookService | null;
        role?: string;
        /** The caller's role for a machines-family act; `refuse` = permission_denied. */
        actor?: 'owner' | 'org-admin' | 'org-member' | 'refuse' | 'missing';
    } = {},
) {
    const actorRole = options.actor ?? 'owner';
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
        resolveMachinesActor: jest.fn(async (userId: string, id: string) => {
            if (actorRole === 'missing') throw new NotFoundException(`Fleet node ${id} not found`);
            if (actorRole === 'refuse') {
                throw new ForbiddenException({
                    statusCode: 403,
                    error: { code: 'permission_denied', details: { family: 'machines' } },
                });
            }
            if (actorRole === 'owner') {
                return { ownerUserId: userId, role: 'owner', nodeName: 'build-01', ctx: {} };
            }
            return {
                ownerUserId: 'the-owner',
                role: actorRole,
                nodeName: 'build-01',
                ctx: {
                    actorUserId: userId,
                    details: { family: 'machines', viewerRole: actorRole },
                },
            };
        }),
        renameForUser: jest.fn(async () => view({ name: 'build-02', modelIdentity: 'secret' })),
        setPausedForUser: jest.fn(async () => view({ status: 'paused' })),
        setDisabledForUser: jest.fn(async () => view({ status: 'disabled' })),
        deleteForUser: jest.fn(async () => undefined),
    };
    const panic = {
        drainNodeForUser: jest.fn(async () => ({
            node: view({ status: 'disabled' }),
            releasedJobs: 2,
        })),
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
        panic as never,
        { findByIds: jest.fn(async () => []) } as never,
        { recentForOwnerNode: jest.fn(async () => []) } as never,
        undefined,
        options.needsALook === null ? undefined : (options.needsALook ?? new NeedsALookService()),
    );
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => void (headers[name] = value) };
    return { controller, service, jobs, panic, headers, res };
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

describe('machines-family acts — rename, pause, disable, drain, remove (FR-22, ACC-FL01-16)', () => {
    const adminCtx = {
        actorUserId: 'user-1',
        details: { family: 'machines', viewerRole: 'org-admin' },
    };

    it('lets the owner rename exactly as before', async () => {
        const { controller, service } = build();
        await controller.update(auth, OWN, { name: 'build-02' } as UpdateFleetNodeDto);
        expect(service.resolveMachinesActor).toHaveBeenCalledWith('user-1', OWN);
        expect(service.renameForUser).toHaveBeenCalledWith('user-1', OWN, 'build-02');
        expect(service.getVisibleForUser).not.toHaveBeenCalled();
    });

    it('lets an org admin the family admits rename the owner’s row, answered with the shared view', async () => {
        const { controller, service } = build({ actor: 'org-admin', role: 'org-admin' });
        const result = await controller.update(auth, SHARED, {
            name: 'build-02',
            paused: true,
        } as UpdateFleetNodeDto);
        expect(service.renameForUser).toHaveBeenCalledWith(
            'the-owner',
            SHARED,
            'build-02',
            adminCtx,
        );
        expect(service.setPausedForUser).toHaveBeenCalledWith('the-owner', SHARED, true, adminCtx);
        // Never the owner's full row: the view the owner shares with them.
        expect(service.getVisibleForUser).toHaveBeenCalledWith('user-1', SHARED);
        expect(result).toMatchObject({ id: SHARED, viewerRole: 'org-admin' });
        expect(result).not.toHaveProperty('modelIdentity');
    });

    it('refuses owner-only fields beside a lifecycle act before ANY write', async () => {
        const { controller, service } = build({ actor: 'org-admin', role: 'org-admin' });
        const refusal = await controller
            .update(auth, SHARED, { name: 'build-02', isFavorite: true } as UpdateFleetNodeDto)
            .catch((e) => e);
        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect((refusal as ForbiddenException).getResponse()).toMatchObject({
            error: { code: 'permission_denied', details: { ownerOnly: true } },
        });
        expect(service.renameForUser).not.toHaveBeenCalled();
        expect(service.setFavoriteForUser).not.toHaveBeenCalled();
    });

    it('writes nothing when the family refuses the caller', async () => {
        const { controller, service } = build({ actor: 'refuse' });
        await expect(
            controller.update(auth, SHARED, { disabled: true } as UpdateFleetNodeDto),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.setDisabledForUser).not.toHaveBeenCalled();
    });

    it('drains as the owner exactly as before', async () => {
        const { controller, panic } = build();
        await controller.drain(auth, OWN, { drain: true });
        expect(panic.drainNodeForUser).toHaveBeenCalledWith('user-1', OWN, true);
    });

    it('drains the owner’s node for an org admin, audited as them, answered with the shared view', async () => {
        const { controller, panic } = build({ actor: 'org-admin', role: 'org-admin' });
        const result = await controller.drain(auth, SHARED, { drain: true });
        expect(panic.drainNodeForUser).toHaveBeenCalledWith('the-owner', SHARED, true, {
            actorUserId: 'user-1',
            details: adminCtx.details,
        });
        expect(result.releasedJobs).toBe(2);
        expect(result.node).toMatchObject({ id: SHARED, viewerRole: 'org-admin' });
    });

    it('drains nothing for a stranger (the 404 of an unknown id)', async () => {
        const { controller, panic } = build({ actor: 'missing' });
        await expect(controller.drain(auth, SHARED, { drain: true })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(panic.drainNodeForUser).not.toHaveBeenCalled();
    });

    it('removes for an org admin with the typed name, on the owner’s row', async () => {
        const { controller, service } = build({ actor: 'org-admin' });
        await controller.remove(auth, SHARED, 'build-01');
        expect(service.deleteForUser).toHaveBeenCalledWith('the-owner', SHARED, adminCtx, {
            confirmName: 'build-01',
        });
    });

    it('asks a non-owner for the typed name before removing the owner’s computer (CONTRACTS §2.2)', async () => {
        const { controller, service } = build({ actor: 'org-admin' });
        const refusal = await controller.remove(auth, SHARED).catch((e) => e);
        expect(refusal).toBeInstanceOf(ConflictException);
        expect((refusal as ConflictException).getResponse()).toMatchObject({
            error: {
                code: 'confirmation_required',
                details: { class: 'confirm-destructive', summary: 'Remove build-01 from Fleet?' },
            },
        });
        expect(service.deleteForUser).not.toHaveBeenCalled();
    });

    it('removes for the owner without a typed name exactly as before', async () => {
        const { controller, service } = build();
        await controller.remove(auth, OWN);
        expect(service.deleteForUser).toHaveBeenCalledWith('user-1', OWN);
    });

    it('removes nothing when the family refuses the caller', async () => {
        const { controller, service } = build({ actor: 'refuse' });
        await expect(controller.remove(auth, SHARED, 'build-01')).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(service.deleteForUser).not.toHaveBeenCalled();
    });
});
