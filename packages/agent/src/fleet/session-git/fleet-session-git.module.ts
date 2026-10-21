import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { Agent } from '../../entities/agent.entity';
import { AgentRunLog } from '../../entities/agent-run-log.entity';
import { FleetAudit } from '../../entities/fleet-audit.entity';
import { User } from '../../entities/user.entity';
import { PolicyModule } from '../../policy/policy.module';
import { FleetCheckoutsModule } from '../checkouts/fleet-checkouts.module';
import { FleetModule } from '../fleet.module';
import { FleetSessionsModule } from '../sessions/fleet-sessions.module';
import { FleetSessionActionService } from './fleet-session-action.service';
import { FleetSessionGitService } from './fleet-session-git.service';

/**
 * Session git & actions (FL-06) — the agent-side module composing FL-04's
 * sessions and FL-14's checkouts: the branch rule for a session's worktree
 * (P1), the action prompts and their ledger (P2). It owns no table
 * (CONTRACTS §13 has no FL-06 slot): the pull request lives on the
 * checkout's git line, an Agent session's ledger on its Run's log, an owner
 * session's in `fleet_audit` (R-38).
 *
 * The provider-facing half (pull-request enrichment and opening through the
 * GitHub App) is the API's (`apps/api/src/fleet/session-git/`): it needs the
 * installation credentials, which this package does not hold.
 */
@Module({
    imports: [
        FleetModule,
        FleetSessionsModule,
        FleetCheckoutsModule,
        // P2: the merge policy's protected branches (a leaf module), the ledger
        // rows of an Agent session's Run, and an owner session's audit rows.
        PolicyModule,
        TypeOrmModule.forFeature([Agent, User, AgentRunLog, FleetAudit]),
    ],
    providers: [FleetSessionGitService, FleetSessionActionService, AgentRepository],
    exports: [FleetSessionGitService, FleetSessionActionService],
})
export class FleetSessionGitModule {}
