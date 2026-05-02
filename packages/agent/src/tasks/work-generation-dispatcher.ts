import { WorkGenerationPayload } from './work-generation.types';

export interface WorkGenerationDispatcher {
    /**
     * Dispatches a work generation task.
     * @returns The trigger run ID if successful, or null if failed/not triggered.
     */
    dispatchWorkGeneration(payload: WorkGenerationPayload): Promise<string | null>;

    /**
     * Requests cancellation of a dispatched work generation task.
     * @returns True when the cancellation request was accepted.
     */
    cancelWorkGeneration(runId: string): Promise<boolean>;
}

export const WORK_GENERATION_DISPATCHER = Symbol('WORK_GENERATION_DISPATCHER');
