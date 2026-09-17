import 'reflect-metadata';

/**
 * Module wiring for the Shared view API.
 *
 * Guards the failure `tsc` cannot see: a collaborator that type-checks but is
 * not provided by this module or exported by one it imports. Nest resolves
 * that at boot, so the symptom would be every API pod crash-looping. An
 * `undefined` paramtype is the signature of a circular import.
 *
 * The heavy workspace barrels are stubbed; the stubs are identity anchors
 * only.
 */

jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
    OrganizationRepository: class OrganizationRepository {},
    TenantRepository: class TenantRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/entities', () => ({ KbDocumentClass: {} }));
jest.mock('@ever-works/agent/shared-views', () => ({
    SharedViewsModule: class SharedViewsModule {},
    SharedViewService: class SharedViewService {},
    SharedViewProjectionService: class SharedViewProjectionService {},
    SharedViewRepository: class SharedViewRepository {},
    SharedView: class SharedView {},
    SharedViewConflictError: class SharedViewConflictError extends Error {},
    SharedViewMissingError: class SharedViewMissingError extends Error {},
    SharedViewInvalidSettingsError: class SharedViewInvalidSettingsError extends Error {},
    sharedViewDefaults: () => ({}),
}));
jest.mock('../auth/auth.module', () => ({ AuthModule: class AuthModule {} }));
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));
jest.mock('../organizations/organizations.module', () => ({
    OrganizationsModule: class OrganizationsModule {},
}));
jest.mock('../organizations/guards/organization-ownership.guard', () => ({
    OrganizationOwnershipGuard: class OrganizationOwnershipGuard {},
}));

import {
    EXCEPTION_FILTERS_METADATA,
    INTERCEPTORS_METADATA,
    MODULE_METADATA,
} from '@nestjs/common/constants';
import { SharedViewOwnerGuard, SharedViewOwnerResolver } from './shared-view-owner.guard';
import { SharedViewPublicController } from './shared-view-public.controller';
import {
    SharedViewPublicExceptionFilter,
    SharedViewPublicHeadersInterceptor,
} from './shared-view-public.http';
import { SharedViewSessionGuard } from './shared-view-session.guard';
import { SharedViewSessionService } from './shared-view-session.service';
import { SharedViewViewDedupe } from './shared-view-view-dedupe';
import { SharedViewsApiModule } from './shared-views.module';
import { SharedViewsController } from './shared-views.controller';

/** What the imported modules export, by class name. */
const IMPORTED = new Set([
    // @ever-works/agent/shared-views → SharedViewsModule
    'SharedViewService',
    'SharedViewProjectionService',
    'SharedViewRepository',
    // @ever-works/agent/database → DatabaseModule
    'OrganizationRepository',
    'TenantRepository',
]);

describe('SharedViewsApiModule wiring', () => {
    const providers: Array<{ name: string }> =
        Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SharedViewsApiModule) ?? [];
    const provided = new Set([...providers.map((provider) => provider.name), ...IMPORTED]);

    it('registers both controllers and imports the domain, database, organizations and auth modules', () => {
        expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SharedViewsApiModule)).toEqual([
            SharedViewsController,
            SharedViewPublicController,
        ]);
        const imports = (
            Reflect.getMetadata(MODULE_METADATA.IMPORTS, SharedViewsApiModule) ?? []
        ).map((entry: { name: string }) => entry.name);
        expect(imports).toEqual(
            expect.arrayContaining([
                'SharedViewsModule',
                'DatabaseModule',
                'OrganizationsModule',
                'AuthModule',
            ]),
        );
    });

    it('provides the public posture enhancers the public controller declares', () => {
        // The filter makes every refusal identical bytes and the interceptor
        // sets the no-store/no-referrer/crawler-block headers. Declaring them
        // on the controller is what applies them; listing them here is what
        // keeps them resolvable from this module.
        expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, SharedViewPublicController)).toEqual(
            [SharedViewPublicExceptionFilter],
        );
        expect(Reflect.getMetadata(INTERCEPTORS_METADATA, SharedViewPublicController)).toEqual([
            SharedViewPublicHeadersInterceptor,
        ]);
        expect(providers).toEqual(
            expect.arrayContaining([
                SharedViewPublicExceptionFilter,
                SharedViewPublicHeadersInterceptor,
            ]),
        );
    });

    it.each([
        SharedViewsController,
        SharedViewPublicController,
        SharedViewOwnerGuard,
        SharedViewOwnerResolver,
        SharedViewSessionGuard,
        SharedViewSessionService,
        SharedViewViewDedupe,
        SharedViewPublicExceptionFilter,
        SharedViewPublicHeadersInterceptor,
    ])('every constructor dependency of %p resolves inside the module', (target) => {
        const params: Array<{ name?: string } | undefined> =
            Reflect.getMetadata('design:paramtypes', target) ?? [];
        for (const param of params) {
            expect(param).toBeDefined();
            expect(provided.has(param!.name ?? '')).toBe(true);
        }
    });
});
