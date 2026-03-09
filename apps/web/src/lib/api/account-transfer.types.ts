export interface AccountExportPayload {
    version: number;
    exportedAt: string;
    includesSecrets: boolean;
    data: {
        profile: { username: string; email: string; avatar?: string };
        directories: any[];
        userPlugins: any[];
    };
}

export interface ImportConflict {
    slug: string;
    existingName: string;
    incomingName: string;
}

export interface ImportPreview {
    valid: boolean;
    errors: string[];
    version: number;
    includesSecrets: boolean;
    profile: { username: string; email: string; avatar?: string };
    directoryCount: number;
    userPluginCount: number;
    conflicts: ImportConflict[];
    missingPlugins: string[];
}

export interface ConflictResolution {
    slug: string;
    strategy: 'skip' | 'overwrite' | 'rename';
    newSlug?: string;
}

export interface ImportResult {
    success: boolean;
    directoriesCreated: number;
    directoriesUpdated: number;
    directoriesSkipped: number;
    userPluginsImported: number;
    errors: string[];
    warnings: string[];
}

export interface SyncStatus {
    configured: boolean;
    hasOAuth: boolean;
    repoOwner?: string;
    repoName?: string;
    lastPushAt?: string;
    lastPullAt?: string;
    lastSyncError?: string;
}
