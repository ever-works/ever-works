import { Module } from '@nestjs/common';
import { AgentModule } from '@packages/agent/services';
import { LocalAgentController } from './local-agent.controller';

@Module({
    imports: [AgentModule],
    controllers: [LocalAgentController],
})
export class LocalAgentModule {}
