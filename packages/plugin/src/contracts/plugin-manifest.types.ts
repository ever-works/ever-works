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
export type PluginIconType = 'svg' | 'url' | 'base64' | 'lucide' | 'emoji';

/**
 * Plugin icon definition supporting multiple formats
 */
export interface PluginIcon {
	/** Icon type determines how to render */
	readonly type: PluginIconType;
	/**
	 * Icon value based on type:
	 * - svg: Raw SVG string
	 * - url: URL to image file
	 * - base64: Base64-encoded image data
	 * - lucide: Lucide icon name (e.g., "github", "cloud")
	 * - emoji: Emoji character
	 */
	readonly value: string;
	/** Optional dark mode variant */
	readonly darkValue?: string;
	/** Optional background color for icon container */
	readonly backgroundColor?: string;
	/** Optional foreground/stroke color for SVG/Lucide icons */
	readonly color?: string;
}

/**
 * Create a Lucide icon reference
 * @param name - Lucide icon name (e.g., "github", "cloud", "settings")
 * @param color - Optional foreground color
 */
export function lucideIcon(name: string, color?: string): PluginIcon {
	return { type: 'lucide', value: name, color };
}

/**
 * Create an SVG icon
 * @param svg - Raw SVG string
 * @param color - Optional foreground/stroke color
 */
export function svgIcon(svg: string, color?: string): PluginIcon {
	return { type: 'svg', value: svg, color };
}

/**
 * Create a URL icon
 * @param url - URL to image file (PNG, JPG, SVG, etc.)
 */
export function urlIcon(url: string): PluginIcon {
	return { type: 'url', value: url };
}

/**
 * Create a base64 icon
 * @param data - Base64-encoded image data (with or without data URI prefix)
 */
export function base64Icon(data: string): PluginIcon {
	return { type: 'base64', value: data };
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
