import type { WorkCodeUpdateDiffEntry, WorkCodeUpdateSource } from '../../entities';

export interface CodeUpdateRequest {
    prompt: string;
    title?: string;
    aiModel?: string;
    source?: WorkCodeUpdateSource;
}

export interface AiCodeEditResult {
    summary: string;
    diff: WorkCodeUpdateDiffEntry[];
}
