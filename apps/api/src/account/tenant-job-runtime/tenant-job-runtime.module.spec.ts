/**
 * `TenantAwareRuntimeResolver` must read the job-runtime registry the
 * platform actually registers into — the @Global `TriggerModule`'s
 * (`packages/tasks/src/trigger/trigger.module.ts`), which binds
 * `JOB_RUNTIME_PROVIDER_REGISTRY` to an `InMemoryJobRuntimeProviderRegistry`
 * holding the Trigger.dev adapter.
 *
 * `TenantJobRuntimeModule` used to bind its OWN
 * `{ provide: JOB_RUNTIME_PROVIDER_REGISTRY, useClass: InMemoryJobRuntimeProviderRegistry }`.
 * NestJS resolves a provider's dependencies from its own module first, so that
 * local binding shadowed the global one for every service declared here, and
 * nothing ever registered into it: `resolver.resolve(anyTenant)` answered
 * `null` (no runtime) while the global registry's `getActive()` answered the
 * Trigger.dev provider. Wired into the plugin execution router as-is, every
 * tenant-scoped long-running call would have answered
 * JOB_RUNTIME_UNAVAILABLE.
 *
 * Mocking posture mirrors `account.module.spec.ts`: the controllers, guard,
 * admin service and the auth/database modules are stubbed so the decorator
 * metadata can be read without the auth stack or a database; the resolver,
 * its injection tokens and the registry come from the real
 * `@ever-works/agent/tasks`, so token identity is the production one.
 */

jest.mock('@ever-works/agent/database', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../auth/auth.module', () => ({ AuthModule: class AuthModule {} }));
jest.mock('../../auth/guards/platform-admin.guard', () => ({
    IsPlatformAdminGuard: class IsPlatformAdminGuard {},
}));
jest.mock(
    '../../operator/tenant-runtime-allowlist/operator-tenant-runtime-allowlist.controller',
    () => ({
        OperatorTenantRuntimeAllowlistController: class OperatorTenantRuntimeAllowlistController {},
    }),
);
jest.mock('./tenant-job-runtime-boot-audit.service', () => ({
    TenantJobRuntimeBootAuditService: class TenantJobRuntimeBootAuditService {},
}));
jest.mock('./tenant-job-runtime.controller', () => ({
    TenantJobRuntimeController: class TenantJobRuntimeController {},
}));
jest.mock('./tenant-job-runtime.service', () => ({
    TenantJobRuntimeService: class TenantJobRuntimeService {},
}));

import { Global, Module, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { IJobRuntimeProvider } from '@ever-works/plugin';
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import {
    CredentialVersionService,
    InMemoryJobRuntimeProviderRegistry,
    JOB_RUNTIME_PROVIDER_REGISTRY,
    SECRET_STORE_RESOLVER,
    TenantAwareRuntimeResolver,
    TenantCredentialCache,
} from '@ever-works/agent/tasks';
import { TenantJobRuntimeModule } from './tenant-job-runtime.module';

function tokenOf(provider: unknown): unknown {
    return typeof provider === 'object' && provider !== null
        ? (provider as { provide?: unknown }).provide
        : provider;
}

function metadata(key: 'providers' | 'exports'): unknown[] {
    return (Reflect.getMetadata(key, TenantJobRuntimeModule) as unknown[]) ?? [];
}

describe('TenantJobRuntimeModule — the job-runtime registry the resolver reads', () => {
    it('does not bind its own JOB_RUNTIME_PROVIDER_REGISTRY (it would shadow the @Global one)', () => {
        const providers = metadata('providers');
        expect(providers.map(tokenOf)).not.toContain(JOB_RUNTIME_PROVIDER_REGISTRY);
        // Nor a bare class registration of the in-memory registry.
        expect(providers).not.toContain(InMemoryJobRuntimeProviderRegistry);
    });

    it('still provides and exports the resolver', () => {
        expect(metadata('providers').map(tokenOf)).toContain(TenantAwareRuntimeResolver);
        expect(metadata('exports').map(tokenOf)).toContain(TenantAwareRuntimeResolver);
    });

    /**
     * The module's OWN bindings for the resolver and for what the resolver
     * injects (taken from the real metadata, so a local registry binding comes
     * along if the module declares one), next to a @Global module that
     * provides the registry — the shape of the API graph.
     */
    describe('in a Nest container with the @Global registry', () => {
        const OWN_TOKENS: unknown[] = [
            TenantAwareRuntimeResolver,
            JOB_RUNTIME_PROVIDER_REGISTRY,
            SECRET_STORE_RESOLVER,
            TenantCredentialCache,
        ];

        const platformProvider = {
            id: 'trigger',
            runtimeId: 'trigger',
            dispatchers: {},
        } as unknown as IJobRuntimeProvider;

        async function compile(findOne: jest.Mock) {
            const registry = new InMemoryJobRuntimeProviderRegistry();
            registry.register(platformProvider);

            class GlobalRuntimeHost {}
            Module({
                providers: [{ provide: JOB_RUNTIME_PROVIDER_REGISTRY, useValue: registry }],
                exports: [JOB_RUNTIME_PROVIDER_REGISTRY],
            })(GlobalRuntimeHost);
            Global()(GlobalRuntimeHost);

            const own = metadata('providers').filter((provider) =>
                OWN_TOKENS.includes(tokenOf(provider)),
            ) as Provider[];
            class TenantHost {}
            Module({
                providers: [
                    ...own,
                    { provide: getRepositoryToken(TenantJobRuntimeConfig), useValue: { findOne } },
                    {
                        provide: CredentialVersionService,
                        useValue: { getCurrentVersion: jest.fn(async () => null) },
                    },
                ],
                exports: [TenantAwareRuntimeResolver],
            })(TenantHost);

            const moduleRef = await Test.createTestingModule({
                imports: [GlobalRuntimeHost, TenantHost],
            }).compile();
            return { moduleRef, registry };
        }

        it('resolve(null) answers the provider registered in the @Global registry', async () => {
            const findOne = jest.fn(async () => null);
            const { moduleRef } = await compile(findOne);

            await expect(moduleRef.get(TenantAwareRuntimeResolver).resolve(null)).resolves.toBe(
                platformProvider,
            );
            await moduleRef.close();
        });

        it('a tenant with no overlay row resolves to the same registered provider', async () => {
            const findOne = jest.fn(async () => null);
            const { moduleRef } = await compile(findOne);

            await expect(
                moduleRef.get(TenantAwareRuntimeResolver).resolve('tenant-without-row'),
            ).resolves.toBe(platformProvider);
            expect(findOne).toHaveBeenCalledWith({ where: { tenantId: 'tenant-without-row' } });
            await moduleRef.close();
        });
    });
});
