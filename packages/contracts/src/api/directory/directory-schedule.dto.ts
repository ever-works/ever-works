import { DirectoryScheduleCadence, DirectoryScheduleStatus, DirectoryScheduleBillingMode } from './schedule.enum.js';
import { GenerateStatusType } from './generate-status.enum.js';
import type { ProvidersDto } from '../generator/providers.dto.js';

/**
 * Allowed cadence configuration for a directory
 */
export interface DirectoryScheduleAllowedCadence {
	/** The cadence option */
	cadence: DirectoryScheduleCadence;
	/** Reason if not allowed */
	reason?: string;
	/** Whether this cadence uses pay-per-use billing */
	payPerUse?: boolean;
	/** Whether this cadence is allowed */
	allowed: boolean;
}

/**
 * Directory schedule configuration and status
 */
export interface DirectoryScheduleDto {
	/** Current schedule status */
	status: DirectoryScheduleStatus;
	/** Selected cadence (null if disabled) */
	cadence: DirectoryScheduleCadence | null;
	/** Selected source validation cadence (null if disabled) */
	sourceValidationCadence: DirectoryScheduleCadence | null;
	/** Billing mode */
	billingMode: DirectoryScheduleBillingMode;
	/** Next scheduled run time (ISO string) */
	nextRunAt: string | null;
	/** Next scheduled source validation run time (ISO string) */
	sourceValidationNextRunAt: string | null;
	/** Last run time (ISO string) */
	lastRunAt: string | null;
	/** Last source validation run time (ISO string) */
	sourceValidationLastRunAt: string | null;
	/** Status of last run */
	lastRunStatus: GenerateStatusType | null;
	/** Number of consecutive failures */
	failureCount: number;
	/** Max failures before auto-pause */
	maxFailureBeforePause: number;
	/** Whether to always create pull request */
	alwaysCreatePullRequest: boolean;
	/** Available cadence options */
	allowedCadences: DirectoryScheduleAllowedCadence[];
	/** User's plan code */
	planCode?: string;
	/** Whether subscriptions are enabled */
	subscriptionsEnabled: boolean;
	/** Provider overrides for scheduled runs (pipeline, ai, search, etc.) */
	providerOverrides?: ProvidersDto | null;
}

/**
 * Payload for updating directory schedule
 */
export interface UpdateDirectorySchedulePayload {
	/** Enable or disable schedule */
	enable?: boolean;
	/** Schedule cadence */
	cadence?: DirectoryScheduleCadence;
	/** Source validation cadence */
	sourceValidationCadence?: DirectoryScheduleCadence;
	/** Billing mode */
	billingMode?: DirectoryScheduleBillingMode;
	/** Max failures before auto-pause */
	maxFailureBeforePause?: number;
	/** Always create pull request */
	alwaysCreatePullRequest?: boolean;
	/** Provider overrides for scheduled runs (pipeline, ai, search, etc.) */
	providerOverrides?: ProvidersDto | null;
}
