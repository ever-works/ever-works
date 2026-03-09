import {
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
    'content-extractor': 'Content Extractors',
    'data-source': 'Data Sources',
    'ai-provider': 'AI Providers',
    pipeline: 'Pipeline',
    form: 'Forms',
    integration: 'Integrations',
    utility: 'Utilities',
    theme: 'Themes',
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
export const HIDDEN_CAPABILITIES = new Set(['form-schema-provider', 'pipeline-modifier', 'oauth']);

/**
 * Mapping of plugin capabilities to human-readable labels
 */
export const CAPABILITY_LABELS: Record<string, string> = {
    'ai-provider': 'AI Provider',
    search: 'Search',
    screenshot: 'Screenshot',
    'content-extractor': 'Content Extractor',
    'data-source': 'Data Source',
    deployment: 'Deployment',
    'git-provider': 'Git',
    'oauth-provider': 'OAuth',
    pipeline: 'Pipeline',
    form: 'Form',
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
