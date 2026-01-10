import { DirectoryImportPayload } from './directory-import.types';

export interface DirectoryImportDispatcher {
    /**
     * Dispatches a directory import task.
     * @returns The trigger run ID if successful, or null if failed/not triggered.
     */
    dispatchDirectoryImport(payload: DirectoryImportPayload): Promise<string | null>;
}

export const DIRECTORY_IMPORT_DISPATCHER = Symbol('DIRECTORY_IMPORT_DISPATCHER');
