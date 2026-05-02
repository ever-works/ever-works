import { WorkImportPayload } from './work-import.types';

export interface WorkImportDispatcher {
    /**
     * Dispatches a work import task.
     * @returns The trigger run ID if successful, or null if failed/not triggered.
     */
    dispatchWorkImport(payload: WorkImportPayload): Promise<string | null>;
}

export const WORK_IMPORT_DISPATCHER = Symbol('WORK_IMPORT_DISPATCHER');
