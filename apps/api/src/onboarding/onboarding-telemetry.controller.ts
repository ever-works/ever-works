import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from '@ever-works/monitoring';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { OnboardingTelemetryBodyDto } from './dto/onboarding-telemetry.dto';

const WIZARD_VERSION = 'v2';

// Security: PostHog special keys that could mutate user-profile properties on
// the platform's own PostHog actor. Stripping them prevents authenticated tenants
// from abusing the relay to overwrite platform-level profile fields.
const POSTHOG_BLOCKED_KEYS = new Set([
    '$set',
    '$unset',
    '$set_once',
    '$add',
    '$append',
    '$remove',
    '$union',
    '$identify',
    '$alias',
    '$group',
    '$groups',
    '$anon_distinct_id',
    '$distinct_id',
]);

// Security: maximum serialized byte size for the properties object to prevent
// analytics ingestion abuse and unexpected billing spikes.
const MAX_PROPERTIES_BYTES = 4096;

/**
 * Sanitizes caller-supplied telemetry properties before forwarding to PostHog:
 *  - Removes PostHog special/internal keys that could mutate platform profile data.
 *  - Drops values that are not primitives (string | number | boolean | null) to
 *    prevent deeply nested objects from inflating the payload.
 *  - Enforces a total serialized byte cap.
 */
function sanitizeTelemetryProperties(
    raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> {
    if (!raw) return {};

    const serialized = JSON.stringify(raw);
    if (serialized.length > MAX_PROPERTIES_BYTES) {
        return {};
    }

    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (POSTHOG_BLOCKED_KEYS.has(key)) continue;
        if (
            value === null ||
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ) {
            // The guard above narrows `value` to a primitive; the cast satisfies
            // the compiler where control-flow narrowing of `unknown` is not applied.
            result[key] = value as string | number | boolean | null;
        }
    }
    return result;
}

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
    track(@CurrentUser() auth: AuthenticatedUser, @Body() body: OnboardingTelemetryBodyDto): void {
        try {
            // Security: sanitize caller-supplied properties before forwarding to PostHog
            // to strip dangerous special keys and enforce a byte cap.
            this.analytics.track(auth.userId, body.event, {
                ...sanitizeTelemetryProperties(body.properties),
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
