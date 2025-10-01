import { Module } from '@nestjs/common';
import { AgentModule } from '@packages/agent/services';
import { DeployModule } from '@packages/agent/deploy';
import { DatabaseModule } from '@packages/agent/database';
import { AuthModule } from '@src/auth';
import { AiModule } from '@packages/agent/ai';
import { CacheFactory, CacheRepository } from '@packages/agent/cache';
import { ScheduleModule } from '@nestjs/schedule';

// Controllers
import { DirectoriesController } from './directories.controller';
import { DeployController } from './deploy.controller';

// Tasks
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
    providers: [CacheRepository, DirectoryCleanupService, VercelDeploymentVerifierService],
    controllers: [DirectoriesController, DeployController],
})
export class DirectoriesModule {}
