import { ScheduleModule } from '@nestjs/schedule';
import { Module } from '@nestjs/common';
import { DirectoryModule } from '@packages/agent/services';
import { DeployModule } from '@packages/agent/deploy';
import { DatabaseModule } from '@packages/agent/database';
import { AuthModule } from '@src/auth';
import { AiModule } from '@packages/agent/ai';
import { CacheEntryRepository } from '@packages/agent/cache';
import { TriggerModule as TasksTriggerModule } from '@packages/tasks';
import { WebsiteGeneratorModule } from '@packages/agent/website-generator';
import { FacadesModule } from '@packages/agent/facades';

// Controllers
import { DirectoriesController } from './directories.controller';
import { DeployController } from './deploy.controller';
import { MembersController } from './members.controller';

// Tasks
import { DirectoryCleanupService } from './tasks/directory-cleanup.service';
import { VercelDeploymentVerifierService } from './tasks/vercel-deployment-verifier.service';
import { WebsiteTemplateSchedulerService } from './tasks/website-template-scheduler.service';

@Module({
    imports: [
        DirectoryModule,
        DeployModule,
        DatabaseModule,
        AuthModule,
        AiModule,
        TasksTriggerModule,
        WebsiteGeneratorModule,
        FacadesModule,
        ScheduleModule.forRoot(),
    ],
    providers: [
        CacheEntryRepository,
        DirectoryCleanupService,
        VercelDeploymentVerifierService,
        WebsiteTemplateSchedulerService,
    ],
    controllers: [DirectoriesController, DeployController, MembersController],
})
export class DirectoriesModule {}
