import { WorkScheduleBillingMode } from '@src/entities/types';

export type OperationTriggerContext = {
    triggeredBy: 'user' | 'schedule' | 'api';
    scheduleId?: string;
};

export type GenerationTriggerContext = OperationTriggerContext & {
    billingMode?: WorkScheduleBillingMode;
};

export const DEFAULT_TRIGGER_CONTEXT: OperationTriggerContext = { triggeredBy: 'user' };

export type ScheduleRunOutcome =
    | { status: 'completed'; historyId?: string }
    | { status: 'failed'; reason?: string }
    | { status: 'skipped'; reason: string };
