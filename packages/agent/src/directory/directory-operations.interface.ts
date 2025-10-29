import { Directory } from '@src/entities/directory.entity';

export interface DirectoryOperations {
    updateDirectory(id: string, updateData: Partial<Directory>): Promise<void>;
    updateGenerateStatus(id: string, status: Directory['generateStatus']): Promise<void>;
    updateLastPullRequest(
        id: string,
        payload: Directory['lastPullRequest'],
    ): Promise<void>;
    recordGenerationStartTime(id: string, startedAt: Date): Promise<void>;
    recordGenerationFinishTime(id: string, finishedAt: Date): Promise<void>;
    emitGenerationCompleted(directory: Directory): Promise<void>;
}

export const DIRECTORY_OPERATIONS = Symbol('DIRECTORY_OPERATIONS');
