# Multi-Provider Selection Design Document

> **Status:** Design complete. Addresses the core question: "How do facades handle multiple installed plugins?"
>
> This document explains the three-level provider selection system used across all capabilities.

---

## The Problem

Users may install multiple plugins of the same capability:

- **Git Providers**: GitHub, GitLab, Bitbucket
- **Deployment**: Vercel, Netlify, Railway
- **Screenshot**: ScreenshotOne, Playwright, Browserless
- **Search**: Tavily, Exa.ai, SerpAPI
- **AI Providers**: OpenAI, Anthropic, Google Gemini, Mistral

**How does the system decide which one to use?**

---

## The Solution: Three-Level Configuration

```
┌─────────────────────────────────────────────────────────────────────┐
│ LEVEL 1: USER LEVEL (Settings > Plugins)                            │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│  Install plugins and configure credentials.                          │
│  This does NOT select which provider to use - just makes them        │
│  available for selection at directory or generation level.           │
│                                                                      │
│  Storage: UserPlugin.settings                                        │
│                                                                      │
│  Example:                                                            │
│    User installs: GitHub, GitLab, OpenAI, Anthropic                 │
│    User configures: API keys, OAuth tokens for each                 │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│ LEVEL 2: DIRECTORY LEVEL (Directory > Apps)                         │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│  Select DEFAULT provider per capability for this directory.          │
│  This is the "sticky" default that applies to all generations       │
│  unless overridden.                                                  │
│                                                                      │
│  Storage: DirectoryPlugin.settings.defaults['capability']            │
│                                                                      │
│  Example:                                                            │
│    Directory A:                                                      │
│      - git-provider: 'github'                                        │
│      - ai-provider: 'openai'                                         │
│      - search: 'tavily'                                              │
│                                                                      │
│    Directory B:                                                      │
│      - git-provider: 'gitlab'                                        │
│      - ai-provider: 'anthropic'                                      │
│      - search: 'exa:search'                                          │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│ LEVEL 3: GENERATION LEVEL (Generator Form)                          │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│  Override provider selection for THIS generation only.               │
│  Does not change directory defaults.                                 │
│                                                                      │
│  Storage: GenerationOptions.providers.capability                     │
│                                                                      │
│  Example:                                                            │
│    "I normally use OpenAI for this directory, but for this          │
│     generation I want to try Anthropic Claude"                       │
│                                                                      │
│    GenerationOptions: {                                              │
│      providers: {                                                    │
│        ai: 'anthropic'  // Override just for this run               │
│      }                                                               │
│    }                                                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### UserPlugin (Level 1: Installation & Credentials)

```typescript
// User has GitHub installed with OAuth token
{
    userId: 'user-123',
    pluginId: 'github',
    settings: {
        accessToken: 'gho_xxxx...',
        username: 'octocat',
        // ...
    },
    enabled: true
}

// User has GitLab installed with OAuth token
{
    userId: 'user-123',
    pluginId: 'gitlab',
    settings: {
        accessToken: 'glpat-xxxx...',
        username: 'gitlabuser',
        // ...
    },
    enabled: true
}

// User has OpenAI installed
{
    userId: 'user-123',
    pluginId: 'openai',
    settings: {
        apiKey: 'sk-xxxx...',
    },
    enabled: true
}

// User has Anthropic installed
{
    userId: 'user-123',
    pluginId: 'anthropic',
    settings: {
        apiKey: 'sk-ant-xxxx...',
    },
    enabled: true
}
```

### DirectoryPlugin (Level 2: Per-Directory Defaults)

```typescript
// Directory A uses GitHub + OpenAI
{
    directoryId: 'dir-A',
    pluginId: 'directory-settings',  // Special plugin for defaults
    settings: {
        defaults: {
            'git-provider': 'github',
            'deployment': 'vercel',
            'screenshot': 'screenshotone',
            'search': 'tavily',
            'ai-provider': 'openai',
            'full-pipeline': null  // null = use standard pipeline
        }
    }
}

// Directory B uses GitLab + Anthropic
{
    directoryId: 'dir-B',
    pluginId: 'directory-settings',
    settings: {
        defaults: {
            'git-provider': 'gitlab',
            'deployment': 'netlify',
            'screenshot': 'playwright',
            'search': 'exa:search',
            'ai-provider': 'anthropic',
            'full-pipeline': null
        }
    }
}
```

### GenerationOptions (Level 3: Per-Generation Override)

```typescript
interface GenerationOptions {
	// ... existing fields (name, prompt, config, etc.) ...

	// Provider overrides (null = use directory default)
	providers?: {
		git?: string | null;
		deployment?: string | null;
		screenshot?: string | null;
		search?: string | null;
		ai?: string | null;
		pipeline?: string | null; // If set, uses full pipeline provider
	};

	// Plugin-specific options for this generation
	pluginOptions?: Record<string, unknown>;
}
```

---

## Facade Resolution Flow

All facades follow the same resolution pattern:

```typescript
async getPlugin(
    directoryId: string,
    providerOverride?: string  // From GenerationOptions.providers.X
): Promise<IPlugin> {
    // 1. Check for generation-level override
    if (providerOverride) {
        return this.registry.getByCapability(capability, providerOverride);
    }

    // 2. Check for directory-level default
    const directoryDefault = await this.settingsService.getDirectoryProvider(
        directoryId,
        capability
    );
    if (directoryDefault) {
        return this.registry.getByCapability(capability, directoryDefault);
    }

    // 3. Fall back to platform default
    const platformDefault = await this.settingsService.getPlatformDefault(capability);
    if (platformDefault) {
        return this.registry.getByCapability(capability, platformDefault);
    }

    throw new ProviderNotFoundError(`No ${capability} provider configured`);
}
```

---

## Generator Form UI

The generator form shows provider selection dropdowns:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      GENERATOR FORM                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Name:   [_________________________________________________]        │
│  Prompt: [_________________________________________________]        │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  PIPELINE MODE                                                      │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  ● Standard Pipeline (step-by-step)                                 │
│  ○ Full Pipeline Provider: [Exa Websets ▼]                          │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  PROVIDER SELECTION                                                 │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  Git Provider:        [🔗 GitHub ▼]         (directory default)     │
│  Search Provider:     [🔍 Tavily ▼]         (directory default)     │
│  Screenshot Provider: [📷 ScreenshotOne ▼]                          │
│  AI Provider:         [🤖 OpenAI GPT-4 ▼]                           │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  PLUGIN OPTIONS (dynamic, based on selected providers)              │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  [Tavily options when selected]                                     │
│  │ Search depth: [● Basic  ○ Advanced]                              │
│                                                                     │
│  [ScreenshotOne options when selected]                              │
│  │ Viewport: [1280] x [800]                                         │
│  │ Block ads: [✓]                                                   │
│                                                                     │
│                                          [Generate]                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## API: Get Generator Form Schema

```typescript
// GET /directories/:id/generator-form
interface GeneratorFormSchema {
	// Available providers per capability (with icons!)
	providers: {
		git: SubProviderOption[];
		deployment: SubProviderOption[];
		screenshot: SubProviderOption[];
		search: SubProviderOption[]; // Includes "Exa Search", "Tavily"
		ai: SubProviderOption[];
		fullPipeline: SubProviderOption[]; // Includes "Exa Websets"
	};

	// Directory defaults (what's currently selected)
	defaults: {
		git: string; // "github"
		deployment: string; // "vercel"
		screenshot: string; // "screenshotone"
		search: string; // "tavily"
		ai: string; // "openai"
		pipeline: string | null; // null = standard, "exa:websets" = full
	};

	// Dynamic form fields keyed by provider ID
	pluginFields: Record<string, FormFieldDefinition[]>;

	// Which ConfigDto fields are handled by each provider
	handledConfigFields: Record<string, string[]>;
}

interface SubProviderOption {
	id: string; // "exa:search", "tavily", "github"
	pluginId: string; // "exa", "tavily", "github" (parent plugin)
	name: string; // "Exa Search", "Tavily", "GitHub"
	icon: PluginIcon; // Icon for dropdown display
	description?: string;
	isDefault?: boolean; // Mark if this is the directory default
	isInstalled: boolean; // User has configured the parent plugin
}
```

---

## Multi-Capability Plugins (Sub-Providers)

Some plugins like Exa.ai have multiple capabilities:

```typescript
class ExaPlugin implements IPlugin, IFullPipelinePlugin, ISearchPlugin {
	readonly id = 'exa';
	readonly name = 'Exa.ai';
	readonly capabilities = ['full-pipeline', 'search', 'form-fields'];

	// Sub-providers appear as separate options in dropdowns
	readonly subProviders: PluginSubProvider[] = [
		{
			id: 'exa:websets',
			name: 'Exa Websets',
			description: 'AI-powered web research replacing entire pipeline',
			capability: 'full-pipeline',
			handledConfigFields: ['*'] // Handles ALL config
		},
		{
			id: 'exa:search',
			name: 'Exa Search',
			description: 'Neural search API for the search step',
			capability: 'search',
			handledConfigFields: ['max_search_queries', 'max_results_per_query']
		}
	];
}
```

In the UI:

- **Full Pipeline dropdown** shows "Exa Websets" (from `exa:websets`)
- **Search dropdown** shows "Exa Search" (from `exa:search`) alongside "Tavily", "SerpAPI", etc.

---

## Example Scenarios

### Scenario 1: Directory defaults, no override

```
User has: GitHub, GitLab, OpenAI, Anthropic installed
Directory A defaults: git=github, ai=openai

Generation request: { name: "Test", prompt: "..." }
                    // No providers override

Result:
  - GitFacade uses: github (directory default)
  - AiFacade uses: openai (directory default)
```

### Scenario 2: Generation-level override

```
User has: GitHub, GitLab, OpenAI, Anthropic installed
Directory A defaults: git=github, ai=openai

Generation request: {
    name: "Test",
    prompt: "...",
    providers: {
        ai: "anthropic"  // Override AI only
    }
}

Result:
  - GitFacade uses: github (directory default, no override)
  - AiFacade uses: anthropic (generation override)
```

### Scenario 3: Full pipeline vs Standard

```
User has: Tavily, Exa.ai installed

Generation request A: {
    providers: { pipeline: null }  // Standard pipeline
}
  - Pipeline uses: StepPipelineExecutor
  - Search step uses: Tavily (directory default)

Generation request B: {
    providers: { pipeline: "exa:websets" }  // Full pipeline
}
  - Pipeline uses: FullPipelineExecutor
  - Exa Websets handles everything
  - Search/Screenshot/AI dropdowns are hidden
```

---

## Settings Resolution Within Provider

Once a provider is selected, its settings are resolved with 4-level hierarchy:

```
1. Plugin.defaultSettings        // Hardcoded in plugin code
        ↓ merge
2. AdminPlugin.settings          // Platform-wide admin settings
        ↓ merge
3. UserPlugin.settings           // User's configured values
        ↓ merge
4. DirectoryPlugin.settings      // Directory-specific overrides
```

Example for ScreenshotOne:

```typescript
// 1. Plugin defaults
{ viewport: { width: 1280, height: 720 }, blockAds: false }

// 2. Admin settings (platform-wide)
{ cacheEnabled: true }

// 3. User settings
{ accessKey: 'xxx', secretKey: 'yyy', viewport: { width: 1920, height: 1080 } }

// 4. Directory settings
{ blockAds: true }

// Final resolved settings:
{
    accessKey: 'xxx',           // From user
    secretKey: 'yyy',           // From user
    viewport: { width: 1920, height: 1080 },  // User override
    blockAds: true,             // Directory override
    cacheEnabled: true          // From admin
}
```

---

## Related Documentation

- [facade-architecture.md](./facade-architecture.md)
- [PLUGIN_SYSTEM_RFC.md - Generator Form Architecture](../PLUGIN_SYSTEM_RFC.md#generator-form-architecture)
- [PLUGIN_SYSTEM_RFC.md - Settings Resolution](../PLUGIN_SYSTEM_RFC.md#settings-resolution)
- Individual facade design docs for capability-specific details
