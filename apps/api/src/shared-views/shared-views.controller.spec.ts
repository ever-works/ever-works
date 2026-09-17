jest.mock('@ever-works/agent/database', () => ({
    OrganizationRepository: class OrganizationRepository {},
    TenantRepository: class TenantRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    KbDocumentClass: { BRAND: 'brand', GLOSSARY: 'glossary' },
}));
jest.mock('@ever-works/agent/shared-views', () => {
    class SharedView {}
    class SharedViewConflictError extends Error {}
    class SharedViewMissingError extends Error {}
    class SharedViewInvalidSettingsError extends Error {
        constructor(readonly reason: string) {
            super(reason);
        }
    }
    return {
        SharedView,
        SharedViewConflictError,
        SharedViewMissingError,
        SharedViewInvalidSettingsError,
        SharedViewService: class SharedViewService {},
        SharedViewProjectionService: class SharedViewProjectionService {},
        sharedViewDefaults: () => ({
            status: 'active',
            sections: { board: true, knowledge: false },
            knowledgeClasses: [],
            searchIndexable: false,
            viewCount: 0,
            rotationCount: 0,
        }),
    };
});
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));
jest.mock('../organizations/guards/organization-ownership.guard', () => ({
    OrganizationOwnershipGuard: class OrganizationOwnershipGuard {},
}));

import 'reflect-metadata';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT, THROTTLER_TRACKER } from '@nestjs/throttler/dist/throttler.constants';
import {
    SharedViewConflictError,
    SharedViewInvalidSettingsError,
    SharedViewMissingError,
} from '@ever-works/agent/shared-views';
import { AuthSessionGuard } from '../auth';
import { OrganizationOwnershipGuard } from '../organizations/guards/organization-ownership.guard';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { SHARED_VIEW_ACTOR_KEY, SharedViewOwnerGuard } from './shared-view-owner.guard';
import { SharedViewsController } from './shared-views.controller';

const TOKEN = 'Zb3kQ9x_T1-vYwP0aLmN8cR4sD6fG2hJ5kL7qW9eR1t';
const ACTOR = { organizationId: 'org-1', tenantId: 'tenant-1', ownerUserId: 'owner-1' };

const user = (userId: string) => ({ userId }) as AuthenticatedUser;

function storedView(overrides: Record<string, unknown> = {}) {
    return {
        id: 'view-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        ownerUserId: 'owner-1',
        tokenHash: 'h'.repeat(64),
        tokenEncrypted: { token: TOKEN },
        status: 'active',
        sections: { board: true, knowledge: false },
        knowledgeClasses: [],
        searchIndexable: false,
        viewCount: 41,
        lastViewedAt: new Date('2026-09-14T11:48:00.000Z'),
        tokenRotatedAt: new Date('2026-09-02T00:00:00.000Z'),
        rotationCount: 1,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        ...overrides,
    };
}

function makeController() {
    const views = {
        getForOrganization: jest.fn().mockResolvedValue(storedView()),
        enable: jest.fn().mockResolvedValue({ view: storedView(), created: true }),
        regenerate: jest.fn().mockResolvedValue(storedView({ rotationCount: 2 })),
        updateSettings: jest.fn().mockResolvedValue(storedView({ status: 'paused' })),
        deleteForOrganization: jest.fn().mockResolvedValue(undefined),
        readToken: jest.fn((view: { tokenEncrypted?: { token?: string } }) =>
            view.tokenEncrypted?.token === TOKEN ? TOKEN : null,
        ),
    };
    const projection = {
        projectBoard: jest.fn().mockResolvedValue({ workspaceName: 'Northwind Studio' }),
    };
    const owners = { resolve: jest.fn().mockResolvedValue(ACTOR) };
    const controller = new SharedViewsController(
        views as never,
        projection as never,
        owners as never,
    );
    return { controller, views, projection, owners };
}

const ownerRequest = () => ({ [SHARED_VIEW_ACTOR_KEY]: ACTOR });

describe('SharedViewsController', () => {
    const proto = SharedViewsController.prototype as unknown as Record<string, object>;

    describe('wiring', () => {
        it('is mounted under the Workspace behind session and membership guards', () => {
            expect(Reflect.getMetadata(PATH_METADATA, SharedViewsController)).toBe(
                'api/organizations/:orgId/shared-view',
            );
            const guards = Reflect.getMetadata(GUARDS_METADATA, SharedViewsController);
            expect(guards).toEqual([AuthSessionGuard, OrganizationOwnershipGuard]);
        });

        it.each(['enable', 'regenerate', 'update', 'remove', 'preview', 'knowledgeClasses'])(
            '%s is owner-only',
            (name) => {
                expect(Reflect.getMetadata(GUARDS_METADATA, proto[name])).toContain(
                    SharedViewOwnerGuard,
                );
            },
        );

        it('lets members read the settings without the owner guard', () => {
            expect(Reflect.getMetadata(GUARDS_METADATA, proto.get)).toBeUndefined();
        });

        it('throttles turning on and regenerating at 10 per minute, regenerate per Workspace', () => {
            expect(Reflect.getMetadata(`${THROTTLER_LIMIT}long`, proto.enable)).toBe(10);
            expect(Reflect.getMetadata(`${THROTTLER_LIMIT}long`, proto.regenerate)).toBe(10);
            expect(Reflect.getMetadata(`${THROTTLER_LIMIT}long`, proto.update)).toBe(30);
            const tracker = Reflect.getMetadata(`${THROTTLER_TRACKER}long`, proto.regenerate);
            expect(tracker({ params: { orgId: 'org-1' } })).toBe('org:org-1');
        });
    });

    describe('GET settings', () => {
        it('gives the Tenant owner the link and the counters', async () => {
            const { controller } = makeController();
            const settings = await controller.get('org-1', user('owner-1'));
            expect(settings).toEqual({
                exists: true,
                canManage: true,
                status: 'active',
                sections: { board: true, knowledge: false },
                knowledgeClasses: [],
                searchIndexable: false,
                viewCount: 41,
                lastViewedAt: '2026-09-14T11:48:00.000Z',
                tokenRotatedAt: '2026-09-02T00:00:00.000Z',
                rotationCount: 1,
                createdAt: '2026-08-01T00:00:00.000Z',
                link: { token: TOKEN },
                linkUnreadable: false,
            });
        });

        it('gives a member the settings WITHOUT the link', async () => {
            const { controller, views } = makeController();
            const settings = await controller.get('org-1', user('member-2'));
            expect(settings.canManage).toBe(false);
            expect(settings.link).toBeNull();
            expect(settings.linkUnreadable).toBe(false);
            expect(JSON.stringify(settings)).not.toContain(TOKEN);
            expect(JSON.stringify(settings)).not.toContain('h'.repeat(64));
            expect(views.readToken).not.toHaveBeenCalled();
        });

        it('reports sharing off for a Workspace that never turned it on', async () => {
            const { controller, views } = makeController();
            views.getForOrganization.mockResolvedValue(null);
            const settings = await controller.get('org-1', user('owner-1'));
            expect(settings).toMatchObject({
                exists: false,
                status: null,
                sections: { board: true, knowledge: false },
                searchIndexable: false,
                link: null,
            });
        });

        it('tells the owner to regenerate when the stored link cannot be read', async () => {
            const { controller, views } = makeController();
            views.getForOrganization.mockResolvedValue(
                storedView({ tokenEncrypted: { token: 'enc::v1::x' } }),
            );
            const settings = await controller.get('org-1', user('owner-1'));
            expect(settings.link).toBeNull();
            expect(settings.linkUnreadable).toBe(true);
        });

        it('answers 404 when the Workspace owner cannot be resolved', async () => {
            const { controller, owners } = makeController();
            owners.resolve.mockResolvedValue(null);
            await expect(controller.get('org-1', user('owner-1'))).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });
    });

    describe('owner writes', () => {
        it('answers 201 when sharing is first turned on and 200 when it already existed', async () => {
            const { controller, views } = makeController();
            const response = { status: jest.fn() };
            const created = await controller.enable(ownerRequest(), response);
            expect(response.status).toHaveBeenLastCalledWith(201);
            expect(created.link).toEqual({ token: TOKEN });
            expect(views.enable).toHaveBeenCalledWith(ACTOR);

            views.enable.mockResolvedValue({ view: storedView(), created: false });
            await controller.enable(ownerRequest(), response);
            expect(response.status).toHaveBeenLastCalledWith(200);
        });

        it('passes the rotation count the page saw, and maps a lost race to 409', async () => {
            const { controller, views } = makeController();
            await controller.regenerate(ownerRequest(), { expectedRotationCount: 1 });
            expect(views.regenerate).toHaveBeenCalledWith(ACTOR, 1);

            views.regenerate.mockRejectedValue(new SharedViewConflictError());
            await expect(
                controller.regenerate(ownerRequest(), { expectedRotationCount: 1 }),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('forwards each facet and maps an invalid setting to 400', async () => {
            const { controller, views } = makeController();
            await controller.update(ownerRequest(), {
                status: 'paused',
                sections: { board: true },
                knowledgeClasses: ['glossary'],
                searchIndexable: true,
            });
            expect(views.updateSettings).toHaveBeenCalledWith(ACTOR, {
                status: 'paused',
                sections: { board: true },
                knowledgeClasses: ['glossary'],
                searchIndexable: true,
            });

            views.updateSettings.mockRejectedValue(
                new SharedViewInvalidSettingsError('knowledge_section_unavailable'),
            );
            await expect(
                controller.update(ownerRequest(), { sections: { knowledge: true } }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('maps a missing view to 404, never 403', async () => {
            const { controller, views } = makeController();
            views.deleteForOrganization.mockRejectedValue(new SharedViewMissingError());
            const attempt = controller.remove(ownerRequest());
            await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
            await expect(attempt).rejects.not.toBeInstanceOf(ForbiddenException);
        });

        it('fails closed when the owner guard did not run', async () => {
            const { controller } = makeController();
            await expect(controller.remove({})).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('preview', () => {
        it('runs the public projection over the stored view', async () => {
            const { controller, projection } = makeController();
            await expect(controller.preview(ownerRequest())).resolves.toEqual({
                workspaceName: 'Northwind Studio',
            });
            expect(projection.projectBoard).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'view-1' }),
            );
        });

        it('previews a Workspace that never turned sharing on, with the default sections', async () => {
            const { controller, views, projection } = makeController();
            views.getForOrganization.mockResolvedValue(null);
            await controller.preview(ownerRequest());
            expect(projection.projectBoard).toHaveBeenCalledWith(
                expect.objectContaining({
                    organizationId: 'org-1',
                    tenantId: 'tenant-1',
                    ownerUserId: 'owner-1',
                    sections: { board: true, knowledge: false },
                }),
            );
        });
    });

    it('reports zero publishable documents per class until the knowledge section ships', () => {
        const { controller } = makeController();
        expect(controller.knowledgeClasses()).toEqual([
            { documentClass: 'brand', count: 0 },
            { documentClass: 'glossary', count: 0 },
        ]);
    });
});
