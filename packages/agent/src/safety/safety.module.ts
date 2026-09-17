import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { AutonomyGrant } from '../entities/autonomy-grant.entity';
import { RailRefusal } from '../entities/rail-refusal.entity';
import { WorkspacePause } from '../entities/workspace-pause.entity';
import { SafetyReadinessService } from './safety-readiness.service';
import { AutonomyGrantRepository } from './autonomy-grant.repository';
import { AutonomyGrantService } from './autonomy-grant.service';
import { RailRefusalRepository } from './rail-refusal.repository';
import { RailRefusalService } from './rail-refusal.service';
import { SAFETY_GATE } from './safety-gate.port';
import { SafetyGateService } from './safety-gate.service';
import { SafetyStateCache } from './safety-state.cache';
import { WorkspacePauseRepository } from './workspace-pause.repository';
import { WorkspacePauseService } from './workspace-pause.service';

/**
 * Safety rails and the trust ladder (AW-24) — the agent-side module.
 *
 * Deliberately a LEAF, like `PolicyModule`: it imports only its own three
 * tables, so anything that has to ask "may this happen?" can depend on it
 * without creating a cycle. The two ports it consumes — the platform stop
 * flag and, later, the delegating rails — arrive via `@Optional()`
 * injection, bound by whichever runtime has them.
 *
 * `SAFETY_GATE` is bound with `useExisting`, so consumers depend on the
 * CONTRACT (`safety-gate.port.ts`, a zero-import leaf) and never on the
 * concrete class.
 *
 * Every entity here MUST also stay registered in the DataSource ENTITIES
 * array (`database/_entities-inventory.ts`) — this repo has no
 * `autoLoadEntities`, so a `forFeature`'d-but-unregistered entity throws
 * `EntityMetadataNotFoundError` on the first query. All three are registered
 * by the same change that added them.
 */
@Module({
    imports: [
        // `AgentActionProposal` is read-only here: readiness counts what a
        // person actually answered, and the approval queue is the decision
        // record this platform already keeps. Nothing in this module writes
        // to it — the approvals service still owns every write.
        TypeOrmModule.forFeature([AutonomyGrant, RailRefusal, WorkspacePause, AgentActionProposal]),
    ],
    providers: [
        AutonomyGrantRepository,
        AutonomyGrantService,
        RailRefusalRepository,
        RailRefusalService,
        WorkspacePauseRepository,
        WorkspacePauseService,
        SafetyStateCache,
        SafetyReadinessService,
        SafetyGateService,
        { provide: SAFETY_GATE, useExisting: SafetyGateService },
    ],
    exports: [
        AutonomyGrantRepository,
        AutonomyGrantService,
        RailRefusalRepository,
        RailRefusalService,
        WorkspacePauseRepository,
        WorkspacePauseService,
        SafetyStateCache,
        SafetyReadinessService,
        SafetyGateService,
        SAFETY_GATE,
    ],
})
export class SafetyModule {}
