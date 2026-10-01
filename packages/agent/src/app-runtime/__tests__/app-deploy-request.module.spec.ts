// `AppDeployRequestModule` imports `AppSpecModule` for `APP_DEPLOY_SPEC_SOURCE`,
// and that module carries `FacadesModule`, whose `AiFacadeService` needs the
// plugin registry `PluginsModule.forRoot()` registers GLOBALLY at application
// bootstrap — present at the API root, absent in a standalone compile. It is
// shelled here as `app-works.module.spec.ts` and `community-pr.module.spec.ts`
// shell it, so this stays a test of THIS wiring.
//
// The shell is not EMPTY, though, and that is the interesting part:
// `AppSpecService` takes `GitFacadeService` **not** `@Optional()` (it reads
// `.works/works.yml` through it), so an empty shell fails the compile with
// "GitFacadeService at index [1]". The stub below is what the real
// `FacadesModule` would export; nothing in these cases calls it, because none of
// them reads a spec.
jest.mock('../../facades/facades.module', () => {
    const { Module } = require('@nestjs/common');
    const { GitFacadeService } = require('../../facades/git.facade');

    @Module({
        providers: [{ provide: GitFacadeService, useValue: {} }],
        exports: [GitFacadeService],
    })
    class FacadesModule {}

    return { FacadesModule };
});

import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { AppDeployRequestModule } from '../app-deploy-request.module';
import {
    APP_DEPLOY_DEPLOYMENT_STORE,
    APP_DEPLOY_DISPATCHER,
    AppDeployRequestService,
} from '../app-deploy-request.service';
import {
    APP_DEPLOY_BUILD_SOURCE,
    APP_DEPLOY_SPEC_SOURCE,
    AppDeployPreconditionsService,
} from '../app-deploy-preconditions.service';
import { AppDeployBuildSourceAdapter } from '../app-deploy-build.source';
import { AppSpecService } from '../../app-spec/app-spec.service';
import { WORK_APP_RUNTIME_STATES } from '../../app-launcher/app-launcher.service';

/**
 * APW-06 §2.2 — the deploy request path, COMPILED.
 *
 * `AppDeployRequestService` had 36 passing unit tests and existed in no Nest
 * module, which is precisely the gap a unit test cannot see: its own spec
 * hand-constructs it, so it passed while the service was unreachable from any
 * route. The rule this branch has paid for twice — a slice that touches a Nest
 * module must compile one — is what this file does.
 *
 * It uses a real in-memory DataSource because `AppRuntimeStateModule` carries
 * `TypeOrmModule.forFeature`, and a mocked one would not prove the thing that
 * actually broke the API boot on this branch before: a repository the module
 * declares but cannot resolve.
 */
describe('AppDeployRequestModule', () => {
    async function compile() {
        return Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                AppDeployRequestModule,
            ],
        }).compile();
    }

    it('compiles, and resolves both services', async () => {
        const moduleRef = await compile();

        expect(moduleRef.get(AppDeployRequestService)).toBeInstanceOf(AppDeployRequestService);
        expect(moduleRef.get(AppDeployPreconditionsService)).toBeInstanceOf(
            AppDeployPreconditionsService,
        );

        await moduleRef.close();
    });

    it('resolves the runtime-state store it imports T17 for', async () => {
        // Both services inject `WORK_APP_RUNTIME_STATES`. Before T17 nothing
        // provided it and `requestDeploy` short-circuited on
        // `503 app_deploy_state_unavailable` before the lock claim.
        const moduleRef = await compile();

        expect(moduleRef.get(WORK_APP_RUNTIME_STATES, { strict: false })).toBeDefined();

        await moduleRef.close();
    });

    it('refuses a request with `worker_not_isolated` — reachable, and honest about it', async () => {
        // The point of this case. With no `APP_DEPLOY_DISPATCHER` bound, §9.2's
        // isolated-worker gate is the first and final answer: 422, no row
        // created, nothing read. "Reachable and refusing for a named reason" is
        // a different state from "declared in no module", and it is the state
        // the epic is honestly in.
        const moduleRef = await compile();
        const service = moduleRef.get(AppDeployRequestService);

        const result = await service.request({
            workId: '11111111-1111-4111-8111-111111111111',
            trigger: 'manual',
        } as never);

        expect(result.httpStatus).toBe(422);
        expect(result.code).toBe('worker_not_isolated');

        await moduleRef.close();
    });

    it('resolves the four §5.1 seams it now binds', async () => {
        // Each one was a refusal before it was bound, and the container is where
        // that is checkable: the dormancy register reads module METADATA, which
        // cannot tell a token bound to nothing from one bound to a provider that
        // does not resolve.
        const moduleRef = await compile();

        expect(moduleRef.get(APP_DEPLOY_DEPLOYMENT_STORE, { strict: false })).toBeDefined();
        expect(moduleRef.get(APP_DEPLOY_BUILD_SOURCE, { strict: false })).toBeDefined();
        expect(moduleRef.get(APP_DEPLOY_DISPATCHER, { strict: false })).toBeDefined();
        // APW-03's own service, not a wrapper: `getEffectiveSpec` is the one read
        // §5.1 names, and a narrowing adapter would be a second place to keep it
        // in step with APW-03.
        expect(moduleRef.get(APP_DEPLOY_SPEC_SOURCE, { strict: false })).toBeInstanceOf(
            AppSpecService,
        );

        await moduleRef.close();
    });

    it('exports the Build source CLASS for the worker’s RPC target — and neither §5.1 token', async () => {
        // The API's `TriggerInternalController` publishes the adapter by name, so the isolated
        // App runtime worker (no DataSource) can proxy `APP_DEPLOY_BUILD_SOURCE` to it. The
        // class, not the token: exporting a token would bind it in every importer's scope
        // (`WorksModule`, `DeployModule`) as a side effect nobody asked for.
        const exported = (Reflect.getMetadata('exports', AppDeployRequestModule) ??
            []) as unknown[];

        expect(exported).toContain(AppDeployBuildSourceAdapter);
        expect(exported).not.toContain(APP_DEPLOY_BUILD_SOURCE);
        expect(exported).not.toContain(APP_DEPLOY_SPEC_SOURCE);

        // And it is the SAME instance the token resolves (`useExisting`), so the worker's reads
        // and the API's own §5.1 pass go through one adapter.
        const moduleRef = await compile();
        expect(moduleRef.get(AppDeployBuildSourceAdapter)).toBe(
            moduleRef.get(APP_DEPLOY_BUILD_SOURCE, { strict: false }),
        );

        await moduleRef.close();
    });

    it('gives the exported adapter exactly the two reads the port declares — its whole RPC surface', async () => {
        // This IS the remote surface the API publishes: `TriggerInternalController` registers
        // the adapter instance by name and auto-derives its allow-list from every
        // function-valued name on the instance and its prototype chain (stopping at
        // `Object.prototype`). The controller's own spec mocks the app-runtime barrel, so it
        // only ever sees a double; this case pins the REAL class. A public method added here
        // later becomes callable over the internal RPC channel, so it must fail this case first.
        const moduleRef = await compile();
        const adapter = moduleRef.get(AppDeployBuildSourceAdapter) as unknown as Record<
            string,
            unknown
        >;

        const names = new Set<string>(Object.getOwnPropertyNames(adapter));
        for (
            let proto: object | null = Object.getPrototypeOf(adapter);
            proto && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto)
        ) {
            for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
        }
        const callable = [...names]
            .filter((name) => name !== 'constructor' && typeof adapter[name] === 'function')
            .sort();

        expect(callable).toEqual(['getBuild', 'listDeployableBuilds']);

        await moduleRef.close();
    });
});
