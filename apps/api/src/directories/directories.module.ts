import { Module } from '@nestjs/common';
import { DirectoriesController } from './directories.controller';
import { AgentModule } from '@packages/agent/services';
import { DeployController } from './deploy.controller';
import { DeployModule } from '@packages/agent/deploy';
import { DatabaseModule } from '@packages/agent/database';
import { AuthModule } from '@src/auth';
import { AiModule } from '@packages/agent/ai';
import { CacheFactory } from '@packages/agent/cache';
import { ScheduleModule } from '@nestjs/schedule';
import { DirectoryCleanupService } from './tasks/directory-cleanup.service';
import { VercelDeploymentVerifierService } from './tasks/vercel-deployment-verifier.service';

@Module({
    imports: [
        AgentModule,
        DeployModule,
        DatabaseModule,
        AuthModule,
        AiModule,
        ScheduleModule.forRoot(),
        CacheFactory.TypeORM(),
    ],
    providers: [DirectoryCleanupService, VercelDeploymentVerifierService],
    controllers: [DirectoriesController, DeployController],
})
export class DirectoriesModule {}
