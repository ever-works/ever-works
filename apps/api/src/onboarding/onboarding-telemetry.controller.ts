import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from '@ever-works/monitoring';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { OnboardingTelemetryBodyDto } from './dto/onboarding-telemetry.dto';

const WIZARD_VERSION = 'v2';

/**
 * Server-side relay for the onboarding wizard's telemetry. Keeps PostHog
 * (and therefore the `posthog-js` client bundle) out of the browser by
 * accepting `{ event, properties }` from the web app's server action and
 * forwarding to the existing AnalyticsService.
 *
 * Event names are allow-listed in `OnboardingTelemetryBodyDto`.
 */
@ApiTags('onboarding')
@Controller('api/onboarding')
export class OnboardingTelemetryController {
    private readonly logger = new Logger(OnboardingTelemetryController.name);

    constructor(private readonly analytics: AnalyticsService) {}

    @Post('telemetry')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Relay an onboarding wizard telemetry event' })
    @ApiResponse({ status: 204, description: 'Event accepted' })
    track(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: OnboardingTelemetryBodyDto,
    ): void {
        try {
            this.analytics.track(auth.userId, body.event, {
                ...(body.properties ?? {}),
                wizardVersion: WIZARD_VERSION,
            });
        } catch (cause) {
            // Telemetry failures must never block the wizard. Log + drop.
            this.logger.warn(
                `Failed to relay onboarding telemetry ${body.event}: ${(cause as Error).message}`,
            );
        }
    }
}
