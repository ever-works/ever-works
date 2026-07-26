import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { GoalsModule } from '../goals/goals.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { WorkModule } from '../services/work.module';
import { CampaignActivationService } from './campaign-activation.service';

/**
 * Campaign activation (roadmap 14.1 / audit G20).
 *
 * A pure composition module: it owns exactly one service and imports the
 * four modules that already own the artifacts a campaign is made of —
 * Works (+ the plugin-operations provider that pins the pipeline), Goals,
 * Agents (templates) and Tasks. Nothing new is provided here, so any
 * consumer that imports this module gets campaign activation without
 * re-declaring a single existing provider.
 */
@Module({
    imports: [WorkModule, GoalsModule, AgentsModule, TasksDomainModule],
    providers: [CampaignActivationService],
    exports: [CampaignActivationService],
})
export class CampaignsModule {}
