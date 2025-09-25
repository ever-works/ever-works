import { Module } from '@nestjs/common';
import { DirectoriesController } from './directories.controller';
import { AgentModule } from '@packages/agent/services';
import { DeployController } from './deploy.controller';
import { DeployModule } from '@packages/agent/deploy';
import { DatabaseModule } from '@packages/agent/database';
import { AuthModule } from '@src/auth';
import { AiModule } from '@packages/agent/ai';
import { CacheFactory } from '@packages/agent/cache';

@Module({
    imports: [
        AgentModule,
        DeployModule,
        DatabaseModule,
        AuthModule,
        AiModule,
        CacheFactory.TypeORM(),
    ],
    controllers: [DirectoriesController, DeployController],
})
export class DirectoriesModule {}
