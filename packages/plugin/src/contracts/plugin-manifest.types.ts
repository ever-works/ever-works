/**
 * All valid plugin categories as a readonly tuple.
 * This is the single source of truth for plugin categories.
 */
export const PLUGIN_CATEGORIES = [
	'git-provider',
	'deployment',
	'screenshot',
	'search',
	'content-extractor',
	'data-source',
	'ai-provider',
	'pipeline',
	'form',
	'integration',
	'utility',
	'theme'
] as const;

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export function isPluginCategory(value: string): value is PluginCategory {
	return PLUGIN_CATEGORIES.includes(value as PluginCategory);
}

/**
 * Icon types for plugin display
 */
export type PluginIconType = 'svg' | 'url' | 'base64' | 'lucide' | 'emoji';

/**
 * Plugin visibility determines how the plugin is displayed in the UI.
 * - 'public': Shown to all users (default)
 * - 'hidden': Never shown in plugin UI (internal infrastructure plugins)
 * - 'user-only': Shown in user plugins list, but NOT in directory plugins list
 */
export type PluginVisibility = 'public' | 'hidden' | 'user-only';

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

/** UI behavior hints declared by a plugin. Drives plugin-specific UI without hardcoding IDs. */
export interface PluginUiHints {
	/** Plugin has a multi-step setup wizard shown inside its settings page. */
	onboardingWizard?: boolean;
	/** Hide all settings fields behind a reveal button until the user opts in. */
	byok?: {
		/** Reveal button label. Defaults to "Bring your own key". */
		buttonLabel?: string;
		/** Field name whose presence auto-opens the form (user already has a key saved). */
		triggerField?: string;
	};
	/** Show an external setup link (e.g. "Get API Token") inside the settings form. */
	setupLink?: {
		url: string;
		label: string;
		/** Button label. Defaults to the value of `label`. */
		buttonLabel?: string;
		/** Only show the button when ALL listed fields are empty. */
		showWhenEmpty?: string[];
	};
	/** Show an org/team management panel inside the plugin settings page. */
	organizationSettings?: boolean;
	/** Include this plugin as a step in the first-time onboarding wizard. */
	includeInOnboarding?: boolean;
	/** Step position in the onboarding wizard (lower = earlier). */
	onboardingPriority?: number;
	/**
	 * Fields that must all be non-empty for the plugin to be considered "connected".
	 * Falls back to OAuth connection status when absent and the plugin has 'oauth' capability.
	 */
	completionFields?: string[];
	/** User-friendly step description shown in the onboarding wizard (separate from the plugin description). */
	onboardingDescription?: string;
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
	/** Whether this is a system plugin that cannot be disabled by users */
	readonly systemPlugin?: boolean;
	/** Whether plugin should be auto-enabled for all directories when installed */
	readonly autoEnable?: boolean;
	/** UI visibility: 'public' (default), 'hidden', or 'user-only' */
	readonly visibility?: PluginVisibility;
	/**
	 * Capabilities this plugin should be the default provider for.
	 * Must be a subset of the plugin's capabilities array.
	 *
	 * @example
	 * // Plugin with multiple capabilities, default for only one
	 * capabilities: ['search', 'content-extractor'],
	 * defaultForCapabilities: ['search']
	 */
	readonly defaultForCapabilities?: readonly string[];
	/** Whether plugin is deprecated */
	readonly deprecated?: boolean;
	/** Deprecation message */
	readonly deprecationMessage?: string;
	/**
	 * When true, this plugin is excluded from manual provider selection UI (e.g., GeneratorForm
	 * dropdowns). It still declares its capability and auto-activates via canExtract() URL routing
	 * in the facade. Use for narrow-scope extractors like notion-extractor or pdf-extractor.
	 */
	readonly supplementary?: boolean;
	/**
	 * Which provider categories this pipeline wants shown in the generator form.
	 * e.g. ['ai-provider', 'search', 'screenshot', 'content-extractor']
	 * If omitted, shows all individual provider selectors (backward compatible).
	 * Only relevant for pipeline plugins.
	 */
	readonly selectableProviderCategories?: readonly string[];
	/**
	 * For pipeline-modifier plugins: which pipeline(s) they target.
	 * e.g. ['standard-pipeline'] or ['*'] for all engine-orchestratable pipelines.
	 */
	readonly targetPipelines?: readonly string[];
	/** UI behavior hints for the frontend. Drives plugin-specific UI without hardcoding IDs. */
	readonly uiHints?: PluginUiHints;
}
