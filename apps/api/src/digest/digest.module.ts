import { Module } from '@nestjs/common';
import { DigestModule } from '@ever-works/agent/digest';
import { DigestController } from './digest.controller';

/**
 * Digest API module — thin owner-scoped READ over the agent-side
 * `DigestModule` (composition, windowing and rendering all live there).
 *
 * Named `DigestApiModule` to avoid colliding with the agent-side
 * `DigestModule` it wraps, matching `MergePolicyApiModule` /
 * `MeetingsApiModule` / `FleetApiModule` next door.
 *
 * No writes: cadence is a user PREFERENCE (`digestFrequency`) already
 * settable through the existing profile PATCH, and delivery is the
 * cron's job — extension of existing surfaces, not a parallel one.
 */
@Module({
    imports: [DigestModule],
    controllers: [DigestController],
    exports: [DigestModule],
})
export class DigestApiModule {}
