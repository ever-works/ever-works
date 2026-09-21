import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { AppDeployRequestModule } from '../app-deploy-request.module';
import { AppDeployRequestService } from '../app-deploy-request.service';
import { AppDeployPreconditionsService } from '../app-deploy-preconditions.service';
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
});
