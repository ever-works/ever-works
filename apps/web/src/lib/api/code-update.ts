import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { APIResponse } from './types';

export type WorkCodeUpdateStatus =
    | 'pending'
    | 'generating'
    | 'proposed'
    | 'applied'
    | 'rejected'
    | 'failed';

export type WorkCodeUpdateSource = 'manual' | 'scheduled' | 'onboarding';

export interface WorkCodeUpdateDiffEntry {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions?: number;
    deletions?: number;
}

export interface WorkCodeUpdate {
    id: string;
    workId: string;
    requestedByUserId?: string | null;
    prompt: string;
    title?: string;
    aiModel?: string;
    templateId?: string;
    source: WorkCodeUpdateSource;
    status: WorkCodeUpdateStatus;
    branch?: string;
    prNumber?: number;
    prUrl?: string;
    diff?: WorkCodeUpdateDiffEntry[];
    summary?: string;
    lastError?: string | null;
    previewDeploymentId?: string | null;
    appliedAt?: string;
    rejectedAt?: string;
    createdAt: string;
    updatedAt: string;
}

export interface CreateCodeUpdateDto {
    prompt: string;
    title?: string;
    aiModel?: string;
}

export type CodeUpdateResponse = APIResponse<{ codeUpdate: WorkCodeUpdate | null }>;
export type CodeUpdateListResponse = APIResponse<{ codeUpdates: WorkCodeUpdate[] }>;

export const codeUpdateAPI = {
    list: (workId: string) =>
        serverFetch<CodeUpdateListResponse>(`/works/${workId}/code-updates`),

    create: (workId: string, data: CreateCodeUpdateDto) =>
        serverMutation<CodeUpdateResponse>({
            endpoint: `/works/${workId}/code-updates`,
            data,
            method: 'POST',
            wrapInData: false,
        }),

    apply: (workId: string, codeUpdateId: string) =>
        serverMutation<CodeUpdateResponse>({
            endpoint: `/works/${workId}/code-updates/${codeUpdateId}/apply`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),

    reject: (workId: string, codeUpdateId: string) =>
        serverMutation<CodeUpdateResponse>({
            endpoint: `/works/${workId}/code-updates/${codeUpdateId}/reject`,
            data: {},
            method: 'POST',
            wrapInData: false,
        }),
};
