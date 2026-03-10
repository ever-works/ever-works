/**
 * Account transfer types for import/export and GitHub sync.
 */

// ─── Export Types ────────────────────────────────────────────────

export interface ExportedProfile {
    username: string;
    email: string;
    avatar?: string;
}

export interface ExportedDirectoryMember {
    userId: string;
    role: string;
}

export interface ExportedCustomDomain {
    domain: string;
    environment: string;
    verified: boolean;
    provider?: string;
}

export interface ExportedDirectoryPlugin {
    pluginId: string;
    enabled: boolean;
    activeCapability?: string;
    settings: Record<string, unknown>;
    secretSettings?: Record<string, unknown>;
    priority: number;
}

export interface ExportedDirectoryItem {
    name: string;
    description: string;
    featured?: boolean;
    order?: number;
    source_url: string;
    category: string | readonly string[];
    slug?: string;
    tags: readonly string[] | readonly { id: string; name: string }[];
    collection?: string;
    markdown?: string;
    badges?: Record<string, unknown>;
    brand?: string | { id: string; name: string; logo_url?: string; website?: string };
    brand_logo_url?: string | null;
    images?: readonly string[];
}

export interface ExportedDirectoryCategory {
    id: string;
    name: string;
    description?: string;
    icon_url?: string;
    priority?: number;
}

export interface ExportedDirectoryTag {
    id: string;
    name: string;
}

export interface ExportedDirectoryCollection {
    id: string;
    name: string;
    description?: string;
    icon_url?: string;
    priority?: number;
}

export interface ExportedAdvancedPrompts {
    relevanceAssessment?: string | null;
    itemGeneration?: string | null;
    itemExtraction?: string | null;
    searchQuery?: string | null;
    categorization?: string | null;
    deduplication?: string | null;
    sourceValidation?: string | null;
}

export interface ExportedDirectory {
    name: string;
    slug: string;
    description: string;
    owner?: string;
    gitProvider: string;
    deployProvider?: string;
    readmeConfig?: any;
    domainType?: string;
    repoVisibility?: any;
    scheduledUpdatesEnabled: boolean;
    scheduledCadence?: string | null;
    communityPrEnabled: boolean;
    communityPrAutoClose: boolean;
    comparisonsEnabled: boolean;
    members: ExportedDirectoryMember[];
    customDomains: ExportedCustomDomain[];
    directoryPlugins: ExportedDirectoryPlugin[];
    advancedPrompts?: ExportedAdvancedPrompts;
    items?: ExportedDirectoryItem[];
    categories?: ExportedDirectoryCategory[];
    tags?: ExportedDirectoryTag[];
    collections?: ExportedDirectoryCollection[];
}

export interface ExportedUserPlugin {
    pluginId: string;
    enabled: boolean;
    autoEnableForDirectories: boolean;
    settings: Record<string, unknown>;
    secretSettings?: Record<string, unknown>;
}

export interface AccountExportPayload {
    version: 1;
    exportedAt: string;
    includesSecrets: boolean;
    data: {
        profile: ExportedProfile;
        directories: ExportedDirectory[];
        userPlugins: ExportedUserPlugin[];
    };
}

// ─── Import Types ────────────────────────────────────────────────

export type ConflictStrategy = 'skip' | 'overwrite' | 'rename';

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
    profile: ExportedProfile;
    directoryCount: number;
    totalItemCount: number;
    userPluginCount: number;
    conflicts: ImportConflict[];
    missingPlugins: string[];
}

export interface ConflictResolution {
    slug: string;
    strategy: ConflictStrategy;
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

export interface ImportOptions {
    includeSecrets?: boolean;
}

export interface ExportOptions {
    includeSecrets?: boolean;
}

// ─── GitHub Sync Types ───────────────────────────────────────────

export interface SyncStatus {
    configured: boolean;
    hasOAuth: boolean;
    repoOwner?: string;
    repoName?: string;
    lastPushAt?: string;
    lastPullAt?: string;
    lastSyncError?: string;
}

export interface ConfigureSyncDto {
    repoFullName?: string;
    createNew?: boolean;
}

export interface SyncPushOptions {
    includeSecrets?: boolean;
}
