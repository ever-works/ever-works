import { Module } from '@nestjs/common';
import { AgentHttpController } from './agent-http.controller';
import { AgentModule } from '@packages/agent/services';
import { DeployController } from './deploy.controller';
import { DeployModule } from '@packages/agent/deploy';
import { DatabaseModule } from '@packages/agent/database';
import { AuthModule } from '@src/auth';

@Module({
    imports: [AgentModule, DeployModule, DatabaseModule, AuthModule],
    controllers: [AgentHttpController, DeployController],
})
export class AgentHttpModule {}
