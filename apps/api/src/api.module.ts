import { Module } from '@nestjs/common';
import { AgentHTTPModule } from '@packages/agent';

@Module({
    imports: [AgentHTTPModule],
})
export class ApiModule {}
