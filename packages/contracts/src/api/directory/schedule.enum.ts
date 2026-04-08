/**
 * Cadence options for directory scheduled updates
 */
export enum DirectoryScheduleCadence {
	HOURLY = 'hourly',
	EVERY_3_HOURS = 'every_3_hours',
	EVERY_8_HOURS = 'every_8_hours',
	EVERY_12_HOURS = 'every_12_hours',
	DAILY = 'daily',
	WEEKLY = 'weekly',
	MONTHLY = 'monthly'
}

/**
 * Status options for directory schedule
 */
export enum DirectoryScheduleStatus {
	DISABLED = 'disabled',
	ACTIVE = 'active',
	PAUSED = 'paused',
	CANCELED = 'canceled'
}

/**
 * Billing mode options for scheduled updates
 */
export enum DirectoryScheduleBillingMode {
	SUBSCRIPTION = 'subscription',
	USAGE = 'usage'
}
