import type { WorkScheduleCadence } from './schedule.enum.js';
import type { WorkScheduleAllowedCadence } from './work-schedule.dto.js';

export interface UpdateSourceValidationPayload {
	enabled: boolean;
	cadence?: WorkScheduleCadence;
}

export interface SourceValidationSettingsDto {
	enabled: boolean;
	cadence: WorkScheduleCadence | null;
	nextRunAt: string | null;
	lastRunAt: string | null;
	allowedCadences: WorkScheduleAllowedCadence[];
}
