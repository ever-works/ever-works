/**
 * Plugin categories for organization and discovery
 */
export type PluginCategory =
	| 'git-provider'
	| 'deployment'
	| 'screenshot'
	| 'search'
	| 'content-extractor'
	| 'data-source'
	| 'ai-provider'
	| 'pipeline'
	| 'form'
	| 'integration'
	| 'utility'
	| 'theme';

/**
 * Icon types for plugin display
 */
export type PluginIconType = 'url' | 'svg' | 'emoji' | 'lucide';

/**
 * Plugin icon definition
 */
export interface PluginIcon {
	/** Icon type */
	readonly type: PluginIconType;
	/** Icon value (URL, SVG string, emoji, or Lucide icon name) */
	readonly value: string;
	/** Optional dark mode variant */
	readonly darkValue?: string;
}

/**
 * Plugin author information
 */
export interface PluginAuthor {
	readonly name: string;
	readonly email?: string;
	readonly url?: string;
}

/**
 * Plugin repository information
 */
export interface PluginRepository {
	readonly type: 'git' | 'npm' | 'local';
	readonly url: string;
}

/**
 * Plugin manifest containing metadata
 */
export interface PluginManifest {
	/** Unique plugin identifier (e.g., 'github-provider', 'vercel-deploy') */
	readonly id: string;
	/** Display name */
	readonly name: string;
	/** Plugin version (semver) */
	readonly version: string;
	/** Short description */
	readonly description: string;
	/** Long description or documentation (markdown) */
	readonly readme?: string;
	/** Plugin category */
	readonly category: PluginCategory;
	/** Plugin capabilities */
	readonly capabilities: readonly string[];
	/** Plugin icon */
	readonly icon?: PluginIcon;
	/** Author information */
	readonly author?: PluginAuthor;
	/** Repository information */
	readonly repository?: PluginRepository;
	/** Homepage URL */
	readonly homepage?: string;
	/** License identifier */
	readonly license?: string;
	/** Keywords for search */
	readonly keywords?: readonly string[];
	/** Minimum platform version required */
	readonly minPlatformVersion?: string;
	/** Maximum platform version supported */
	readonly maxPlatformVersion?: string;
	/** Plugin dependencies */
	readonly dependencies?: Record<string, string>;
	/** Whether plugin is built-in */
	readonly builtIn?: boolean;
	/** Whether plugin is deprecated */
	readonly deprecated?: boolean;
	/** Deprecation message */
	readonly deprecationMessage?: string;
}
