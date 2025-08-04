import { Module } from '@nestjs/common';
import { AgentHttpController } from './agent-http.controller';
import { AgentModule } from '@packages/agent/services';

@Module({
    imports: [AgentModule],
    controllers: [AgentHttpController],
})
export class AgentHttpModule {}
