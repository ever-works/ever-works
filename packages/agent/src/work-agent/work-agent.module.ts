import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkAgentGoal, WorkAgentPreference, WorkAgentRun, WorkAgentRunLog } from '../entities';
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
