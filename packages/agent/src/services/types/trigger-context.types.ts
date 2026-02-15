import { DirectoryScheduleBillingMode } from '@src/entities/types';

export type OperationTriggerContext = {
    triggeredBy: 'user' | 'schedule' | 'api';
    scheduleId?: string;
};

export type GenerationTriggerContext = OperationTriggerContext & {
    billingMode?: DirectoryScheduleBillingMode;
};

export const DEFAULT_TRIGGER_CONTEXT: OperationTriggerContext = { triggeredBy: 'user' };
