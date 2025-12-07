import { DirectoryGenerationPayload } from './directory-generation.types';

export interface DirectoryGenerationDispatcher {
    dispatchDirectoryGeneration(payload: DirectoryGenerationPayload): Promise<boolean>;
}

export const DIRECTORY_GENERATION_DISPATCHER = Symbol('DIRECTORY_GENERATION_DISPATCHER');
