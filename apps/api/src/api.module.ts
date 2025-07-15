import { Module } from '@nestjs/common';
import { AgentHTTPModule } from '@packages/agent/http';

@Module({
    imports: [AgentHTTPModule],
})
export class ApiModule {}
