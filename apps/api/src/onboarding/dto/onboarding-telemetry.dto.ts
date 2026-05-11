import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional } from 'class-validator';

/**
 * Allow-listed event names for the v2 onboarding wizard. Adding a new event
 * to the wizard requires extending this list — the API rejects anything
 * else with a 400 so PostHog never receives free-text from the browser.
 */
export const ONBOARDING_TELEMETRY_EVENTS = [
    'onboarding_opened',
    'onboarding_closed',
    'onboarding_completed',
    'onboarding_step_viewed',
    'onboarding_step_next',
    'onboarding_step_back',
    'onboarding_step_skipped',
    'onboarding_ai_choice_selected',
    'onboarding_storage_choice_selected',
    'onboarding_deploy_choice_selected',
    'onboarding_plugin_connected',
    'onboarding_plugin_refresh_clicked',
    'onboarding_planned_card_clicked',
    'onboarding_byok_skipped',
    'onboarding_plugins_step_expanded',
    'onboarding_plugins_step_skipped',
    'onboarding_plugins_step_advanced',
    'onboarding_ever_works_quota_blocked',
] as const;

export type OnboardingTelemetryEvent = (typeof ONBOARDING_TELEMETRY_EVENTS)[number];

export class OnboardingTelemetryBodyDto {
    @ApiProperty({ enum: ONBOARDING_TELEMETRY_EVENTS })
    @IsIn(ONBOARDING_TELEMETRY_EVENTS)
    event!: OnboardingTelemetryEvent;

    @ApiPropertyOptional({
        description: 'Free-form event props; do not include PII or secrets.',
    })
    @IsOptional()
    @IsObject()
    properties?: Record<string, unknown>;
}
