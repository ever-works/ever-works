import { ScheduleModule } from '@nestjs/schedule';
import { Module } from '@nestjs/common';
import { DirectoryModule } from '@packages/agent/services';
import { DeployModule } from '@packages/agent/deploy';
import { DatabaseModule } from '@packages/agent/database';
import { AuthModule } from '@src/auth';
import { AiModule } from '@packages/agent/ai';
import { CacheFactory, CacheEntryRepository } from '@packages/agent/cache';

// Controllers
import { DirectoriesController } from './directories.controller';
import { DeployController } from './deploy.controller';

// Tasks
import { DirectoryCleanupService } from './tasks/directory-cleanup.service';
import { VercelDeploymentVerifierService } from './tasks/vercel-deployment-verifier.service';

@Module({
    imports: [
        DirectoryModule,
        DeployModule,
        DatabaseModule,
        AuthModule,
        AiModule,
        ScheduleModule.forRoot(),
        CacheFactory.TypeORM(),
    ],
    providers: [CacheEntryRepository, DirectoryCleanupService, VercelDeploymentVerifierService],
    controllers: [DirectoriesController, DeployController],
})
export class DirectoriesModule {}
