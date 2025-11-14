import { Directory } from '@src/entities/directory.entity';
import { GenerationHistoryUpdateInput } from '@src/directory-operations';

export enum DirectoryCommandAction {
    UPDATE = 'update',
    UPDATE_GENERATE_STATUS = 'updateGenerateStatus',
    UPDATE_LAST_PULL_REQUEST = 'updateLastPullRequest',
    RECORD_GENERATION_START = 'recordGenerationStartTime',
    RECORD_GENERATION_FINISH = 'recordGenerationFinishTime',
    EMIT_GENERATION_COMPLETED = 'emitGenerationCompleted',
    UPDATE_GENERATION_HISTORY = 'updateGenerationHistory',
}

export type DirectoryCommandPayloads = {
    [DirectoryCommandAction.UPDATE]: { data: Partial<Directory> };
    [DirectoryCommandAction.UPDATE_GENERATE_STATUS]: {
        status: Directory['generateStatus'];
    };
    [DirectoryCommandAction.UPDATE_LAST_PULL_REQUEST]: {
        lastPullRequest: Directory['lastPullRequest'];
    };
    [DirectoryCommandAction.RECORD_GENERATION_START]: {
        startedAt: string;
    };
    [DirectoryCommandAction.RECORD_GENERATION_FINISH]: {
        finishedAt: string;
    };
    [DirectoryCommandAction.EMIT_GENERATION_COMPLETED]: Record<string, never>;
    [DirectoryCommandAction.UPDATE_GENERATION_HISTORY]: {
        historyId: string;
        updates: GenerationHistoryUpdateInput;
    };
};

export type DirectoryCommand<A extends DirectoryCommandAction = DirectoryCommandAction> = {
    action: A;
    payload: DirectoryCommandPayloads[A];
};
