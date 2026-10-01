import 'reflect-metadata';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { WorkRepository } from '../../database/repositories/work.repository';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { BuildFacadeService } from '../build-facade.service';

/**
 * APW-05 T16 — the plugin registry reaches `BuildFacadeService` by TOKEN, not by
 * emitted type.
 *
 * ## The defect this pins
 *
 * The constructor declared `@Optional() registry: PluginRegistryService | undefined`
 * with no `@Inject`, so Nest read the token from `design:paramtypes`. What that
 * metadata says depends on the compiler:
 *
 *   - tsc (ts-jest, this package's `strictNullChecks: false`) drops the
 *     `| undefined` and emits `PluginRegistryService` — so every spec in this
 *     package saw a registry;
 *   - SWC (`nest build -b swc`, what ships — see
 *     `packages/agent/dist/app-builds/build-facade.service.js`) emits `Object`
 *     for a union type. Nothing provides `Object`, the parameter is
 *     `@Optional()`, so the running API constructed the facade with NO registry
 *     and every Build plugin resolution answered "the plugin registry is not
 *     available in this injector".
 *
 * `apps/api/src/app-works-di-reachability.spec.ts` sees it because it compiles with
 * SWC's options; ts-jest cannot. This file pins the fix in a way that does not
 * depend on either compiler: the token is SELF-DECLARED (`@Inject`), which Nest
 * reads ahead of `design:paramtypes`, so what the container hands the facade is the
 * same whichever compiler emitted it.
 */
describe('BuildFacadeService — the registry is injected by token', () => {
    it('declares PluginRegistryService as the token of constructor[0]', () => {
        const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, BuildFacadeService) ??
            []) as { index: number; param: unknown }[];

        expect(declared).toEqual(
            expect.arrayContaining([{ index: 0, param: PluginRegistryService }]),
        );
    });

    it('receives the global registry when design:paramtypes says Object, as SWC emits it', async () => {
        // Reproduce the shipped metadata exactly: SWC's `Object` for the union type.
        // With the token self-declared, Nest never reads this slot.
        const paramtypes = Reflect.getMetadata('design:paramtypes', BuildFacadeService) as
            | unknown[]
            | undefined;
        const swcParamtypes = [...(paramtypes ?? [])];
        swcParamtypes[0] = Object;
        Reflect.defineMetadata('design:paramtypes', swcParamtypes, BuildFacadeService);

        const registry = { getAll: () => [] };

        // Root infra stand-in: the API registers `PluginsModule.forRoot()` globally.
        @Global()
        @Module({
            providers: [{ provide: PluginRegistryService, useValue: registry }],
            exports: [PluginRegistryService],
        })
        class GlobalPluginRegistryStandIn {}

        @Module({
            providers: [BuildFacadeService, { provide: WorkRepository, useValue: {} }],
        })
        class FacadeHost {}

        try {
            const moduleRef = await Test.createTestingModule({
                imports: [GlobalPluginRegistryStandIn, FacadeHost],
            }).compile();
            const facade = moduleRef.get(BuildFacadeService, { strict: false }) as unknown as {
                registry?: unknown;
            };

            expect(facade.registry).toBe(registry);
            await moduleRef.close();
        } finally {
            Reflect.defineMetadata('design:paramtypes', paramtypes, BuildFacadeService);
        }
    });
});
