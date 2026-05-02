import { WorkScheduleCadence, WorkScheduleStatus, WorkScheduleBillingMode } from './schedule.enum.js';
import { GenerateStatusType } from './generate-status.enum.js';
import type { ProvidersDto } from '../generator/providers.dto.js';

/**
 * Allowed cadence configuration for a work
 */
export interface WorkScheduleAllowedCadence {
	/** The cadence option */
	cadence: WorkScheduleCadence;
	/** Reason if not allowed */
	reason?: string;
	/** Whether this cadence uses pay-per-use billing */
	payPerUse?: boolean;
	/** Whether this cadence is allowed */
	allowed: boolean;
}

/**
 * Work schedule configuration and status
 */
export interface WorkScheduleDto {
	/** Current schedule status */
	status: WorkScheduleStatus;
	/** Whether the scheduled updates feature is currently available */
	featureEnabled: boolean;
	/** Whether this work is currently eligible to enable scheduled updates */
	canEnable: boolean;
	/** Machine-readable reason the schedule cannot currently be enabled */
	blockingCode?:
		| 'SCHEDULED_UPDATES_DISABLED'
		| 'INITIAL_WORK_SETUP_REQUIRED'
		| 'SOURCE_SYNC_UNSUPPORTED'
		| 'CONFIG_UNAVAILABLE';
	/** Human-readable reason the schedule cannot currently be enabled */
	blockingReason?: string;
	/** Selected cadence (null if disabled) */
	cadence: WorkScheduleCadence | null;
	/** Billing mode */
	billingMode: WorkScheduleBillingMode;
	/** Next scheduled run time (ISO string) */
	nextRunAt: string | null;
	/** Last run time (ISO string) */
	lastRunAt: string | null;
	/** Status of last run */
	lastRunStatus: GenerateStatusType | null;
	/** Number of consecutive failures */
	failureCount: number;
	/** Max failures before auto-pause */
	maxFailureBeforePause: number;
	/** Whether to always create pull request */
	alwaysCreatePullRequest: boolean;
	/** Available cadence options */
	allowedCadences: WorkScheduleAllowedCadence[];
	/** User's plan code */
	planCode?: string;
	/** Whether subscriptions are enabled */
	subscriptionsEnabled: boolean;
	/** Provider overrides for scheduled runs (pipeline, ai, search, etc.) */
	providerOverrides?: ProvidersDto | null;
}

/**
 * Payload for updating work schedule
 */
export interface UpdateWorkSchedulePayload {
	/** Enable or disable schedule */
	enable?: boolean;
	/** Trigger an immediate run after saving the active schedule */
	runImmediately?: boolean;
	/** Schedule cadence */
	cadence?: WorkScheduleCadence;
	/** Billing mode */
	billingMode?: WorkScheduleBillingMode;
	/** Max failures before auto-pause */
	maxFailureBeforePause?: number;
	/** Always create pull request */
	alwaysCreatePullRequest?: boolean;
	/** Provider overrides for scheduled runs (pipeline, ai, search, etc.) */
	providerOverrides?: ProvidersDto | null;
}
