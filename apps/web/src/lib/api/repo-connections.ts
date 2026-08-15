import 'server-only';
import { serverFetch, serverMutation } from './server-api';

// Repository registry (Feature G) — Settings → Repositories +
// per-agent repo attachments. Mirrors `api/repo-connections` and
// `api/agents/:agentId/repos`.

export type RepoConnectionProvider = 'github' | 'git';
export type RepoConnectionCredentialMode = 'inherit' | 'github-app' | 'secret-ref';
export type RepoConnectionSourceType = 'manual' | 'work' | 'github-app';

export interface RepoConnectionEnvFileMetaDto {
    path: string;
    size: number;
}

export interface RepoConnectionEnvFileDto {
    path: string;
    content: string;
}

export interface RepoConnectionDto {
    id: string;
    name: string;
    url: string;
    provider: RepoConnectionProvider;
    defaultBranch: string | null;
    mountPath: string | null;
    mountDir: string;
    description: string | null;
    credentialMode: RepoConnectionCredentialMode;
    credentialRef: string | null;
    /** MASKED — paths + sizes only. Full contents via getEnvFiles. */
    envFiles: RepoConnectionEnvFileMetaDto[];
    availableInAllProjects: boolean;
    sourceType: RepoConnectionSourceType;
    sourceWorkId: string | null;
    sourceInstallationRepoId: string | null;
    enabled: boolean;
    readonly: boolean;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface AgentRepoDto extends RepoConnectionDto {
    attached: boolean;
    attachmentEnabled: boolean;
}

/**
 * `undefined` = leave the stored value alone; `null` = CLEAR it. The API
 * distinguishes the two (`@IsOptional()` accepts null, and the service
 * writes null through), which is the only way an edit can empty a field
 * the user had previously filled in.
 */
export interface SaveRepoConnectionInput {
    name: string;
    url: string;
    provider?: RepoConnectionProvider;
    defaultBranch?: string | null;
    mountPath?: string | null;
    description?: string | null;
    credentialMode?: RepoConnectionCredentialMode;
    credentialRef?: string | null;
    envFiles?: RepoConnectionEnvFileDto[];
    availableInAllProjects?: boolean;
    enabled?: boolean;
}

export const repoConnectionsAPI = {
    list: async (includeDerived = false) => {
        return serverFetch<RepoConnectionDto[]>(
            `/repo-connections${includeDerived ? '?includeDerived=true' : ''}`,
        );
    },

    get: async (id: string) => {
        return serverFetch<RepoConnectionDto>(`/repo-connections/${id}`);
    },

    create: async (input: SaveRepoConnectionInput) => {
        return serverMutation<RepoConnectionDto>({
            endpoint: '/repo-connections',
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    update: async (id: string, input: Partial<SaveRepoConnectionInput>) => {
        return serverMutation<RepoConnectionDto>({
            endpoint: `/repo-connections/${id}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    remove: async (id: string) => {
        return serverMutation<{ deleted: true }>({
            endpoint: `/repo-connections/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    /** Owner-gated reveal of FULL env-file contents. */
    getEnvFiles: async (id: string) => {
        return serverFetch<{ files: RepoConnectionEnvFileDto[] }>(
            `/repo-connections/${id}/env-files`,
        );
    },

    setEnvFiles: async (id: string, files: RepoConnectionEnvFileDto[]) => {
        return serverMutation<{ files: RepoConnectionEnvFileMetaDto[] }>({
            endpoint: `/repo-connections/${id}/env-files`,
            data: { files },
            method: 'PUT',
            wrapInData: false,
        });
    },

    importFromGithubApp: async (installationRepoId: string) => {
        return serverMutation<RepoConnectionDto>({
            endpoint: `/repo-connections/import/github-app/${installationRepoId}`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    listForAgent: async (agentId: string) => {
        return serverFetch<AgentRepoDto[]>(`/agents/${agentId}/repos`);
    },

    setAgentAttachment: async (agentId: string, repoConnectionId: string, enabled: boolean) => {
        return serverMutation<{ agentId: string; repoConnectionId: string; enabled: boolean }>({
            endpoint: `/agents/${agentId}/repos/${repoConnectionId}`,
            data: { enabled },
            method: 'PUT',
            wrapInData: false,
        });
    },

    removeAgentAttachment: async (agentId: string, repoConnectionId: string) => {
        return serverMutation<{ deleted: true }>({
            endpoint: `/agents/${agentId}/repos/${repoConnectionId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
