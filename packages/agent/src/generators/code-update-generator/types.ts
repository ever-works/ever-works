import type { WorkCodeUpdateSource } from '../../entities';

export interface CodeUpdateRequest {
    prompt: string;
    title?: string;
    aiModel?: string;
    source?: WorkCodeUpdateSource;
}
