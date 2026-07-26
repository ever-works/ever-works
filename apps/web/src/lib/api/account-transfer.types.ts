/**
 * Mirrors `ExportedProfile` in
 * `packages/agent/src/account-transfer/types.ts`. The onboarding answers
 * and account preferences are user-authored settings that must survive an
 * export/import round trip; every field is optional so pre-sweep payloads
 * still parse.
 */
export interface ExportedProfile {
    username: string;
    email: string;
    avatar?: string;
    onboarding?: {
        roles?: string[];
        teamSize?: string;
    };
    preferences?: {
        digestFrequency?: string;
        emailAgentAlerts?: boolean;
        emailTaskNotifications?: boolean;
        emailBudgetAlerts?: boolean;
        userResearchOptOut?: boolean;
    };
}

export interface AccountExportPayload {
    version: number;
    exportedAt: string;
    includesSecrets: boolean;
    data: {
        profile: ExportedProfile;
        works: any[];
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
    hasMaskedSecrets: boolean;
    profile: ExportedProfile;
    workCount: number;
    totalItemCount: number;
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
    worksCreated: number;
    worksUpdated: number;
    worksSkipped: number;
    userPluginsImported: number;
    /** True when the payload's onboarding answers / preferences were applied. */
    profileImported?: boolean;
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
