import { Module } from '@nestjs/common';
import { AgentModule } from '@packages/agent/services';
import { LocalAgentController } from './local-agent.controller';
import { DeployModule } from '@packages/agent/deploy';

@Module({
    imports: [AgentModule, DeployModule],
    controllers: [LocalAgentController],
})
export class LocalAgentModule {}
