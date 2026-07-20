import {
    Gauge,
    Brain,
    Rocket,
    Search,
    Camera,
    FileText,
    Database,
    GitBranch,
    Workflow,
    Plug,
    FormInput,
    Puzzle,
    Wrench,
    Palette,
    HardDrive,
    Mail,
    Bell,
    Boxes,
    Globe,
    Cog,
    KeyRound,
    Library,
    Network,
    type LucideIcon,
} from 'lucide-react';
import { PluginCategory, PLUGIN_CATEGORIES } from '@ever-works/plugin';

/**
 * Mapping of plugin categories to Lucide icons
 * Uses PluginCategory type from @ever-works/plugin for type safety
 */
export const CATEGORY_ICONS: Record<PluginCategory, LucideIcon> = {
    'git-provider': GitBranch,
    deployment: Rocket,
    screenshot: Camera,
    search: Search,
    'content-extractor': FileText,
    'data-source': Database,
    'ai-provider': Brain,
    pipeline: Workflow,
    form: FormInput,
    integration: Puzzle,
    utility: Wrench,
    theme: Palette,
    // EW-637 — object storage backends (local-fs, S3, MinIO, GitHub blob)
    storage: HardDrive,
    // EW-650 / EW-663 — Notifications v2 surfaces
    'email-provider': Mail,
    'notification-channel': Bell,
    // EW-724 — vector store backends (pgvector, Qdrant, …) for KB embeddings
    'vector-store': Boxes,
    // EW-735 — DNS plugin category (Cloudflare et al.)
    dns: Globe,
    // EW-742 P3.2 — pluggable secret-store-resolver backends
    // (Vault, K8s, Infisical, Doppler, AWS-SM, GCP-SM, Azure-KV).
    'secret-store-resolver': KeyRound,
    // EW-685 / EW-742 — pluggable job-runtime providers (BullMQ,
    // pg-boss, Temporal, Inngest, Trigger.dev).
    'job-runtime': Cog,
    // Org-wide Memory (Cortex P2) — pluggable org memory frameworks +
    // multi-doc-type RAG pipelines.
    memory: Library,
    rag: Network,
    // First-party bidirectional connectors (Slack, Discord, …).
    connector: Plug,
    // Domain-model evolution PR-7 — metrics-provider backends
    // (Stripe, PostHog, Google Analytics, custom HTTP) for Goals.
    metrics: Gauge,
};

/**
 * Mapping of plugin categories to human-readable labels
 * Uses PluginCategory type from @ever-works/plugin for type safety
 */
export const CATEGORY_LABELS: Record<PluginCategory, string> = {
    'git-provider': 'Git Providers',
    deployment: 'Deployment',
    screenshot: 'Screenshots',
    search: 'Search',
    'content-extractor': 'Content Processors',
    'data-source': 'Data Sources',
    'ai-provider': 'AI Providers',
    pipeline: 'Pipeline',
    form: 'Forms',
    integration: 'Integrations',
    utility: 'Utilities',
    theme: 'Themes',
    storage: 'Storage',
    'email-provider': 'Email Providers',
    'notification-channel': 'Notification Channels',
    'vector-store': 'Vector Stores',
    dns: 'DNS Providers',
    'secret-store-resolver': 'Secret Stores',
    'job-runtime': 'Job Runtimes',
    memory: 'Memory Frameworks',
    rag: 'RAG Pipelines',
    connector: 'Connectors',
    metrics: 'Metrics',
};

// Type-safe assertion that all categories are covered
// This will cause a compile error if a category is missing
const _assertAllCategoriesHaveIcons: Record<PluginCategory, LucideIcon> = CATEGORY_ICONS;
const _assertAllCategoriesHaveLabels: Record<PluginCategory, string> = CATEGORY_LABELS;

/**
 * Get the icon component for a plugin category
 * Returns a default Plug icon for unknown categories
 */
export function getCategoryIcon(category: string): LucideIcon {
    return CATEGORY_ICONS[category as PluginCategory] || Plug;
}

/**
 * Get the human-readable label for a plugin category
 * Formats unknown categories by splitting on hyphens and capitalizing
 */
export function getCategoryLabel(category: string): string {
    if (CATEGORY_LABELS[category as PluginCategory]) {
        return CATEGORY_LABELS[category as PluginCategory];
    }
    // Format unknown category: split by hyphen and capitalize each word
    return category
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Capabilities that are internal implementation contracts and should not be
 * shown to users as selectable providers or displayed as capability badges.
 */
export const HIDDEN_CAPABILITIES = new Set([
    'form-schema-provider',
    'pipeline-modifier',
    'oauth',
    'device-auth',
]);

/**
 * Mapping of plugin capabilities to human-readable labels
 */
export const CAPABILITY_LABELS: Record<string, string> = {
    'ai-provider': 'AI Provider',
    search: 'Search',
    screenshot: 'Screenshot',
    'content-extractor': 'Content Processor',
    'data-source': 'Data Source',
    deployment: 'Deployment',
    'git-provider': 'Git',
    'oauth-provider': 'OAuth',
    pipeline: 'Pipeline',
    form: 'Form',
    // EW-637 — storage capabilities
    storage: 'Storage',
    'put-object': 'Put Object',
    'get-object': 'Get Object',
    'presigned-put': 'Presigned Upload',
};

/**
 * Get the human-readable label for a plugin capability
 * Formats unknown capabilities by splitting on hyphens and capitalizing
 */
export function getCapabilityLabel(capability: string): string {
    return (
        CAPABILITY_LABELS[capability] ??
        capability
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ')
    );
}

/**
 * Display order for plugin categories.
 * Type-safe: compiler will error if a value is not a valid PluginCategory.
 */
export const CATEGORY_DISPLAY_ORDER: readonly PluginCategory[] = [
    'pipeline',
    'ai-provider',
    'search',
    'content-extractor',
    'screenshot',
    'git-provider',
    'deployment',
    'data-source',
    'storage',
    'vector-store',
    'dns',
    'email-provider',
    'notification-channel',
    'job-runtime',
    'secret-store-resolver',
    'form',
    'integration',
    'utility',
    'theme',
];

/**
 * Sort comparator for plugin categories by display order.
 * Categories not in CATEGORY_DISPLAY_ORDER are placed at the end.
 */
export function compareCategoryOrder(a: string, b: string): number {
    const ai = CATEGORY_DISPLAY_ORDER.indexOf(a as PluginCategory);
    const bi = CATEGORY_DISPLAY_ORDER.indexOf(b as PluginCategory);
    return (
        (ai === -1 ? CATEGORY_DISPLAY_ORDER.length : ai) -
        (bi === -1 ? CATEGORY_DISPLAY_ORDER.length : bi)
    );
}

/**
 * Get all available plugin categories
 * Re-exports from @ever-works/plugin for convenience
 */
export { PLUGIN_CATEGORIES };
