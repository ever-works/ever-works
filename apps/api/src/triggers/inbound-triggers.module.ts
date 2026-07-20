import { Module } from '@nestjs/common';
import { InboundTriggersModule as AgentInboundTriggersModule } from '@ever-works/agent/triggers';
import { InboundTriggersController } from './inbound-triggers.controller';

/**
 * Inbound Triggers ("Trigger Schedules") — API module.
 *
 * Thin HTTP surface over the agent-side `InboundTriggersService`
 * (management CRUD + rotate/pause/resume + the public HMAC-verified
 * fire endpoint). `ScopeContextService` is provided globally by
 * `ScopeModule`, so it needs no import.
 */
@Module({
    imports: [AgentInboundTriggersModule],
    controllers: [InboundTriggersController],
})
export class InboundTriggersModule {}
