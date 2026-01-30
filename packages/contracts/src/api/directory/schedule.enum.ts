/**
 * Cadence options for directory scheduled updates
 */
export enum DirectoryScheduleCadence {
	HOURLY = 'hourly',
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
