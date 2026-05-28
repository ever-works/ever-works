import { Module } from '@nestjs/common';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '../../auth/auth.module';
import { WorkModule } from '@ever-works/agent/services';
import { AgentMemoryController } from './agent-memory.controller';

/**
 * REST surface for the `agent-memory` capability. Mounted from
 * `api.module.ts` alongside the other plugins-capabilities modules.
 */
@Module({
    imports: [FacadesModule, AuthModule, WorkModule],
    controllers: [AgentMemoryController],
})
export class AgentMemoryApiModule {}
