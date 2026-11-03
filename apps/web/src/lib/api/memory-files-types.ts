/**
 * Client-safe types for the /memory Files area — mirrors the API's
 * unified row + folder tree shapes (`/api/memory/files`).
 */

export type MemoryFileSource = 'upload' | 'kb-upload';

export interface MemoryFileProvenance {
    workId?: string;
    taskId?: string;
    missionId?: string;
    ideaId?: string;
    agentId?: string;
    chat?: boolean;
}

export interface MemoryFileRow {
    id: string;
    source: MemoryFileSource;
    filename: string;
    mime: string | null;
    size: number | null;
    folderId: string | null;
    ownerAgentId: string | null;
    provenance: MemoryFileProvenance;
    updatedAt: string;
    sha256?: string;
}

export interface MemoryFolderSyncRepo {
    repoUrl?: string;
    owner?: string;
    repo?: string;
    branch?: string;
    dirPrefix?: string;
}

export interface MemoryFolderNode {
    id: string;
    name: string;
    parentId: string | null;
    path: string;
    ownerAgentId: string | null;
    syncRepo: MemoryFolderSyncRepo | null;
    fileCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface MemoryFilesListResponse {
    files: MemoryFileRow[];
}

export interface MemoryFolderTreeResponse {
    folders: MemoryFolderNode[];
}

export interface MemoryFolderSyncResult {
    id: string;
    source: MemoryFileSource;
    filename: string;
    repoPath?: string;
    status: 'committed' | 'skipped-too-large' | 'failed';
    reason?: string;
}

export interface MemoryFolderSyncReport {
    folderId: string;
    commitSha: string | null;
    results: MemoryFolderSyncResult[];
}
