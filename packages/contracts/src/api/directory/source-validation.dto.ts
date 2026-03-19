import type { DirectoryScheduleCadence } from './schedule.enum.js';
import type { DirectoryScheduleAllowedCadence } from './directory-schedule.dto.js';

export interface UpdateSourceValidationPayload {
	enabled: boolean;
	cadence?: DirectoryScheduleCadence;
}

export interface SourceValidationSettingsDto {
	enabled: boolean;
	cadence: DirectoryScheduleCadence | null;
	nextRunAt: string | null;
	lastRunAt: string | null;
	allowedCadences: DirectoryScheduleAllowedCadence[];
}
