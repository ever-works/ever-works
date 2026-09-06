import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MergeApprovalModule } from '../merge-approval.module';
import { MergeApprovalService } from '../merge-approval.service';
import { MERGE_APPROVAL_VERIFIER } from '../../policy/merge-approval.port';
import { ENTITIES } from '../../database/database.config';

/**
 * The module compiles against a REAL Nest container.
 *
 * This exists because the slice that added `MergeApprovalService` shipped an
 * unresolvable dependency — `TaskRepository` is not in
 * `_repository-inventory.ts`, so `DatabaseModule` neither provides nor
 * exports it, and every module that needs it must list it locally. Nothing
 * caught it: the service's own spec constructs it directly, which proves the
 * logic and says nothing about wiring, and the module specs that WOULD have
 * caught it (`facades.module.spec.ts`, and the api-side module specs) cannot
 * load in a working checkout because `@ever-works/agent-plugins` has no build
 * output there. So the first thing that would have failed was the API
 * refusing to boot.
 *
 * This spec deliberately imports only `MergeApprovalModule` over an in-memory
 * database, avoiding that plugin chain entirely, so it runs everywhere.
 * Delete the `TaskRepository` provider and it fails with "Nest can't resolve
 * dependencies of the MergeApprovalService ... argument TaskRepository at
 * index [1]" — verified, not assumed.
 */
describe('MergeApprovalModule — dependency injection', () => {
    it('compiles and resolves both the class and the verifier token', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                MergeApprovalModule,
            ],
        }).compile();

        // The token is what `GitFacadeService` injects. Resolving the class
        // but not the token would still leave the gate unbound at runtime,
        // which fails closed but refuses every merge — so both are asserted.
        expect(moduleRef.get(MergeApprovalService)).toBeInstanceOf(MergeApprovalService);
        expect(moduleRef.get(MERGE_APPROVAL_VERIFIER)).toBe(moduleRef.get(MergeApprovalService));

        await moduleRef.close();
    });
});
