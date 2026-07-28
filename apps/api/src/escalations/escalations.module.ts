import { Module } from '@nestjs/common';
import { AgentsModule } from '@ever-works/agent/agents';
import { AuthModule } from '../auth/auth.module';
import { EscalationsController } from './escalations.controller';

/**
 * Judgment layer G3/G10 — api-side module exposing `/api/escalations`.
 *
 * Thin by construction: composition, scoring and the owner-scoped
 * queries all live in the agent-side {@link AgentsModule}
 * (`AgentEscalationService`). This module only mounts the controller,
 * exactly like `DigestApiModule` / `MergePolicyApiModule` next door.
 *
 * Named `EscalationsApiModule` to avoid colliding with the agent-side
 * naming, same convention as its siblings.
 *
 * Additive: the pre-existing Task-scoped escalation routes on
 * `TasksController` are untouched — this adds the cross-Task queue read
 * they never provided.
 */
@Module({
    imports: [AgentsModule, AuthModule],
    controllers: [EscalationsController],
})
export class EscalationsApiModule {}
