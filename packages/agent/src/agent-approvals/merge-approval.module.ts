import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MERGE_APPROVAL_VERIFIER } from '../policy/merge-approval.port';
import { AgentApprovalsModule } from './agent-approvals.module';
import { TaskRepository } from '../database/repositories/task.repository';
import { MergeApprovalService } from './merge-approval.service';

/**
 * Merge approval (self-build slice AE, EW-805) — the module that binds
 * `MERGE_APPROVAL_VERIFIER`.
 *
 * It is separate from `AgentApprovalsModule` on purpose. That module is a
 * two-entity leaf (proposals + agents) that api-side controllers import;
 * verifying an approval additionally needs the Task, the approver's User
 * row and the Organization roster, i.e. `DatabaseModule`. Folding those
 * into the leaf would drag the whole repository graph into every
 * controller that just wants the queue.
 *
 * Import direction: `FacadesModule` → here → (`AgentApprovalsModule`,
 * `DatabaseModule`). Neither of those imports `FacadesModule`, so the
 * graph stays acyclic — the same shape `PolicyModule` uses to stay
 * importable from the facade layer.
 *
 * `TaskRepository` is provided HERE rather than imported: it is not in
 * `_repository-inventory.ts`, so `DatabaseModule` neither provides nor
 * exports it, and every module that needs it lists it locally — see
 * `IngestModule`. Injecting it without this line is an unresolvable
 * dependency and the API does not boot. `DatabaseModule` re-exports
 * `TypeOrmModule` with every entity, so the `Task` repository it needs
 * is already in scope.
 *
 * The token is bound with `useExisting` so consumers depend on the
 * CONTRACT (`MergeApprovalVerifier`) and never on the concrete class.
 */
@Module({
    imports: [DatabaseModule, AgentApprovalsModule],
    providers: [
        TaskRepository,
        MergeApprovalService,
        { provide: MERGE_APPROVAL_VERIFIER, useExisting: MergeApprovalService },
    ],
    exports: [MergeApprovalService, MERGE_APPROVAL_VERIFIER],
})
export class MergeApprovalModule {}
