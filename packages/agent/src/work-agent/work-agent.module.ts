import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkAgentGoal } from '../entities/work-agent-goal.entity';
import { WorkAgentPreference } from '../entities/work-agent-preference.entity';
import { WorkAgentRun } from '../entities/work-agent-run.entity';
import { WorkAgentRunLog } from '../entities/work-agent-run-log.entity';
import { DatabaseModule } from '../database/database.module';
import { WorkAgentService } from './work-agent.service';

@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            WorkAgentPreference,
            WorkAgentGoal,
            WorkAgentRun,
            WorkAgentRunLog,
        ]),
    ],
    providers: [WorkAgentService],
    exports: [WorkAgentService],
})
export class WorkAgentModule {}
