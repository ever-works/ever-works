/**
 * Account transfer types for import/export and GitHub sync.
 * Supports versioned JSON export (v1) with full directory data including
 * items, comparisons, site config, schedules, and advanced prompts.
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
    activeCapabilities?: string[];
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

export interface ExportedSchedule {
    cadence?: string | null;
    status: string;
    billingMode: string;
    alwaysCreatePullRequest: boolean;
    maxFailureBeforePause: number;
    providerOverrides?: Record<string, any> | null;
}

export interface ExportedComparisonSource {
    title: string;
    url: string;
    note?: string;
}

export interface ExportedComparison {
    id: string;
    slug: string;
    title: string;
    item_a_slug: string;
    item_b_slug: string;
    item_a_name: string;
    item_b_name: string;
    category: string;
    summary: string;
    verdict: string;
    verdict_winner?: 'item_a' | 'item_b' | 'tie';
    dimensions: readonly {
        name: string;
        item_a_summary: string;
        item_b_summary: string;
        item_a_score?: number;
        item_b_score?: number;
        winner?: 'item_a' | 'item_b' | 'tie';
    }[];
    sources: readonly ExportedComparisonSource[];
    generated_at: string;
    markdown?: string;
}

export interface ExportedMarkdownTemplate {
    header: string;
    footer: string;
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
    schedule?: ExportedSchedule;
    siteConfig?: Record<string, any>;
    markdownTemplate?: ExportedMarkdownTemplate;
    items?: ExportedDirectoryItem[];
    categories?: ExportedDirectoryCategory[];
    tags?: ExportedDirectoryTag[];
    collections?: ExportedDirectoryCollection[];
    comparisons?: ExportedComparison[];
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
    hasMaskedSecrets: boolean;
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

// ─── Secret Masking ─────────────────────────────────────────────

/**
 * Prefix used to identify masked secret values in export payloads.
 * Real secret values are NEVER exported — only masked representations.
 */
export const MASKED_SECRET_PREFIX = 'MASKED:';

/**
 * Masks a single secret string value for export.
 * Shows first 3 and last 4 characters for identification, rest is hidden.
 * Short values are fully masked.
 */
export function maskSecretValue(value: unknown): string {
    if (typeof value !== 'string' || !value) {
        return `${MASKED_SECRET_PREFIX}********`;
    }
    if (value.length <= 8) {
        return `${MASKED_SECRET_PREFIX}********`;
    }
    return `${MASKED_SECRET_PREFIX}${value.slice(0, 3)}***${value.slice(-4)}`;
}

/**
 * Masks all values in a secret settings record for safe export.
 * The original keys are preserved but values are replaced with masked strings.
 */
export function maskSecretSettings(
    settings: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
    if (!settings || typeof settings !== 'object') return {};
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings)) {
        masked[key] = maskSecretValue(value);
    }
    return masked;
}

/**
 * Checks if a secret settings record contains any masked values.
 * Used during import to detect and warn about masked secrets that need replacing.
 */
export function containsMaskedSecrets(
    settings: Record<string, unknown> | undefined | null,
): boolean {
    if (!settings || typeof settings !== 'object') return false;
    return Object.values(settings).some(
        (v) => typeof v === 'string' && v.startsWith(MASKED_SECRET_PREFIX),
    );
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
