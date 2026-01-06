import { DirectoryGenerationPayload } from './directory-generation.types';

export interface DirectoryGenerationDispatcher {
    /**
     * Dispatches a directory generation task.
     * @returns The trigger run ID if successful, or null if failed/not triggered.
     */
    dispatchDirectoryGeneration(payload: DirectoryGenerationPayload): Promise<string | null>;
}

export const DIRECTORY_GENERATION_DISPATCHER = Symbol('DIRECTORY_GENERATION_DISPATCHER');
