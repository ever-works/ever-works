import { Module } from '@nestjs/common';
import { AgentModule } from '@packages/agent/services';
import { DirectoriesController } from './directories.controller';
import { DeployModule } from '@packages/agent/deploy';

@Module({
    imports: [AgentModule, DeployModule],
    controllers: [DirectoriesController],
})
export class DirectoriesModule {}
