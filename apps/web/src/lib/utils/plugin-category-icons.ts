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
    type LucideIcon,
} from 'lucide-react';

/**
 * Mapping of plugin categories to Lucide icons
 */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
    'ai-provider': Brain,
    deployment: Rocket,
    search: Search,
    screenshot: Camera,
    'content-extractor': FileText,
    'data-source': Database,
    'git-provider': GitBranch,
    pipeline: Workflow,
};

/**
 * Mapping of plugin categories to human-readable labels
 */
export const CATEGORY_LABELS: Record<string, string> = {
    'ai-provider': 'AI Providers',
    deployment: 'Deployment',
    search: 'Search',
    screenshot: 'Screenshots',
    'content-extractor': 'Content Extractors',
    'data-source': 'Data Sources',
    'git-provider': 'Git Providers',
    pipeline: 'Pipeline',
};

/**
 * Get the icon component for a plugin category
 * Returns a default Plug icon for unknown categories
 */
export function getCategoryIcon(category: string): LucideIcon {
    return CATEGORY_ICONS[category] || Plug;
}

/**
 * Get the human-readable label for a plugin category
 * Formats unknown categories by splitting on hyphens and capitalizing
 */
export function getCategoryLabel(category: string): string {
    if (CATEGORY_LABELS[category]) {
        return CATEGORY_LABELS[category];
    }
    // Format unknown category: split by hyphen and capitalize each word
    return category
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}
