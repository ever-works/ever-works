import { Module } from '@nestjs/common';
import { ZeroFrictionFunnelService } from '@ever-works/agent/services';
import { TelemetryController } from './telemetry.controller';

/**
 * EW-617 G8 — module wiring for the public `/api/telemetry/funnel`
 * endpoint. Declares its own `ZeroFrictionFunnelService` provider rather
 * than importing `WorkModule` to keep this module dependency-light. The
 * service is a stateless logger wrapper, so a duplicate singleton is
 * harmless. Same pattern as `AuthModule`.
 */
@Module({
    controllers: [TelemetryController],
    providers: [ZeroFrictionFunnelService],
})
export class TelemetryModule {}
