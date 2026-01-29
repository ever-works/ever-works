# Ever Works Plugin Architecture Guide

## Table of Contents

1. [Introduction](#introduction)
2. [Core Concepts](#core-concepts)
3. [Type Safety](#type-safety) ⚠️
4. [How Plugins Work](#how-plugins-work)
5. [Plugin Categories](#plugin-categories)
6. [Plugin Discovery Process](#plugin-discovery-process)
7. [Plugin Lifecycle](#plugin-lifecycle)
8. [Configuration Hierarchy](#configuration-hierarchy)
9. [Pipeline Architecture](#pipeline-architecture)
10. [Multi-Capability Plugins](#multi-capability-plugins)
11. [User Experience Flow](#user-experience-flow)
12. [Security Model](#security-model)
13. [What's NOT Part of the Plugin System](#whats-not-part-of-the-plugin-system)
14. [Testing Plugins](#testing-plugins)
15. [Glossary](#glossary)

---

## Introduction

### What Problem Does This Solve?

The Ever Works platform currently has many hardcoded integrations:

- GitHub is the only supported git provider
- Vercel is the only deployment target
- ScreenshotOne is the only screenshot service
- AI providers are managed through switch statements

This tight coupling creates several problems:

- Adding new providers requires modifying core code
- Users cannot choose alternative services
- Testing is difficult due to concrete dependencies
- The system cannot be extended by third parties

### The Solution: Plugin Architecture

The plugin system transforms Ever Works into a modular, extensible platform where:

- Every external integration is provided by a plugin
- Users install and configure plugins through the UI
- Plugins can be swapped without code changes
- Third-party developers can create custom plugins
- The core system remains stable while capabilities expand

---

## Core Concepts

### What is a Plugin?

A plugin is a self-contained package that provides specific capabilities to the Ever Works platform. Think of plugins like apps on a smartphone - they extend what the system can do without modifying the core operating system.

Each plugin:

- Lives in its own folder with its own dependencies
- Implements one or more capability interfaces
- Provides a settings form for user configuration
- Can be installed, enabled, disabled, and uninstalled independently

### What is a Capability?

A capability is a type of functionality that plugins can provide. For example:

- **Git Provider** - Creating repositories, pushing code, making pull requests
- **Deployment** - Deploying websites to hosting platforms
- **Screenshot** - Capturing images of web pages
- **Search** - Finding information on the web
- **AI Provider** - Generating text with language models

Multiple plugins can provide the same capability. For instance, both GitHub and GitLab plugins provide the "git provider" capability, giving users a choice.

### What is the Plugin Registry?

The Plugin Registry is the central hub that:

- Keeps track of all discovered plugins
- Knows which plugins each user has installed
- Knows which plugins are enabled for each directory
- Provides the right plugin when a capability is needed

When the system needs to perform a git operation, it asks the registry "give me the git provider plugin for this directory" rather than directly calling GitHub code.

### What is a Facade?

A facade is a simple wrapper that hides the complexity of the plugin system from the rest of the application. Instead of every service knowing about plugins and registries, they just call the facade.

For example, the `GitFacade` provides methods like `createRepository()` and `push()`. Internally, it asks the plugin registry for the appropriate git plugin and delegates the work. The calling code doesn't know or care whether GitHub, GitLab, or some other provider is being used.

> **Implementation Status:** The `GitFacade` design is complete (see `docs/plugin/designs/git-facade-design.md`). Implementation is pending Story 2 (Plugin Runtime), which will provide the required `PluginRegistryService` and `PluginSettingsService` dependencies.

---

## Type Safety

**Type safety is non-negotiable in the Ever Works plugin system.** All plugin interfaces, step IDs, data keys, and data flow between steps are strongly typed and validated at compile time.

### Why Type Safety Matters

The plugin system involves many moving parts:

- 14 built-in pipeline steps
- Data flowing between steps
- Plugin step injections and replacements
- Configuration and settings

Without strong typing, typos and misconfigurations would only be discovered at runtime, leading to mysterious failures. With strong typing, errors are caught immediately during development.

### What's Type-Safe?

| Component                 | Type                                  | Purpose                                              |
| ------------------------- | ------------------------------------- | ---------------------------------------------------- |
| **Step IDs**              | `BuiltInStepId` union type            | Ensures only valid step IDs are used in dependencies |
| **Data Keys**             | `StepDataKey` union type              | Ensures steps produce/consume known data keys        |
| **Step Results**          | `StepDataTypes` mapped interface      | Maps each data key to its TypeScript type            |
| **Context Access**        | Generic `getStepResult<K>()`          | Returns correctly typed data based on key            |
| **Capability Interfaces** | `IPlugin`, `IGitProviderPlugin`, etc. | Strict contracts for plugin implementation           |

### Example: Type-Safe Pipeline Step

```typescript
// ❌ WITHOUT TYPE SAFETY - Runtime errors
const step = {
	id: 'my-step',
	dependencies: ['item-extration'], // Typo - found at runtime!
	provides: ['my-data']
};
const items = context.get('extrcted-items'); // Typo - returns undefined!

// ✅ WITH TYPE SAFETY - Compile-time errors
const step: PipelineStepDefinition = {
	id: 'my-plugin:my-step',
	dependencies: ['item-extraction'], // ✓ Valid BuiltInStepId
	provides: ['extracted-items'] // ✓ Valid StepDataKey
};
const items = context.getStepResult('extracted-items'); // ✓ Type: ExtractedItem[]
```

### Key Type Definitions

```typescript
// All valid built-in step IDs
type BuiltInStepId =
	| 'prompt-comparison'
	| 'prompt-processing'
	| 'domain-detection'
	| 'search-query-generation'
	| 'ai-item-generation'
	| 'web-page-retrieval'
	| 'content-filtering'
	| 'item-extraction'
	| 'data-aggregation'
	| 'category-processing'
	| 'source-validation'
	| 'badge-processing'
	| 'image-capture'
	| 'markdown-generation';

// All valid data keys with their types
interface StepDataTypes {
	'extracted-items': ExtractedItem[];
	'search-queries': string[];
	'final-markdown': string;
	// ... all other step outputs
}

// Type-safe context access
interface GenerationContext {
	getStepResult<K extends StepDataKey>(key: K): StepDataTypes[K] | undefined;
	setStepResult<K extends StepDataKey>(key: K, value: StepDataTypes[K]): void;
}
```

For detailed type definitions, see:

- [PLUGIN_SYSTEM_RFC.md](./PLUGIN_SYSTEM_RFC.md#type-safety-is-non-negotiable) - Design principles
- [PLUGIN_SYSTEM_JIRA_TICKETS.md](./PLUGIN_SYSTEM_JIRA_TICKETS.md#task-111-ipipelinestepplugin-interface) - Implementation details

---

## How Plugins Work

### The Big Picture

```
┌─────────────────────────────────────────────────────────────────┐
│                        EVER WORKS CORE                          │
│                                                                 │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    │
│   │  Git    │    │ Deploy  │    │Screenshot│    │   AI    │    │
│   │ Facade  │    │ Facade  │    │ Facade   │    │ Facade  │    │
│   └────┬────┘    └────┬────┘    └────┬─────┘    └────┬────┘    │
│        │              │              │               │          │
│        └──────────────┴──────────────┴───────────────┘          │
│                              │                                   │
│                    ┌─────────┴─────────┐                        │
│                    │  Plugin Registry  │                        │
│                    └─────────┬─────────┘                        │
└──────────────────────────────┼──────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────┴────┐           ┌─────┴─────┐          ┌────┴────┐
   │ GitHub  │           │  Vercel   │          │ OpenAI  │
   │ Plugin  │           │  Plugin   │          │ Plugin  │
   └─────────┘           └───────────┘          └─────────┘
```

### Information Flow

1. **Request arrives** - A user wants to deploy their directory
2. **Facade receives call** - The deploy controller calls the Deploy Facade
3. **Registry lookup** - The facade asks the registry for the user's deployment plugin
4. **Plugin execution** - The registry returns the Vercel plugin (or whichever the user configured)
5. **Result returns** - The plugin performs the deployment and returns the result
6. **Response sent** - The facade passes the result back to the controller

This indirection means the controller never knows which specific deployment service is being used. If the user switches to Netlify tomorrow, the controller code doesn't change at all.

---

## Plugin Categories

Plugins are organized into categories based on what type of functionality they provide.

### Git Providers

**Purpose:** Manage source code repositories

**What they do:**

- Create new repositories
- Clone existing repositories
- Push code changes
- Create branches and pull requests
- Manage repository settings

**Examples:** GitHub, GitLab, Bitbucket, Gitea

### Deployment Providers

**Purpose:** Deploy websites and applications to hosting platforms

**What they do:**

- Deploy directory contents to hosting
- Check deployment status
- Retrieve deployment URLs
- Manage custom domains
- List available teams/organizations

**Examples:** Vercel, Netlify, Railway, Render, AWS Amplify

### Screenshot Providers

**Purpose:** Capture images of web pages

**What they do:**

- Take screenshots of URLs
- Support various viewport sizes
- Handle bulk screenshot requests
- Provide different output formats

**Examples:** ScreenshotOne, Playwright, Puppeteer, Browserless

### Search Providers

**Purpose:** Find information on the web

**What they do:**

- Execute search queries
- Return structured results
- Support different search depths
- Provide relevance scoring

**Examples:** Tavily, Exa, SerpAPI, Google Custom Search

### Content Extractors

**Purpose:** Extract content from web pages

**What they do:**

- Scrape web page content
- Parse HTML into structured data
- Handle JavaScript-rendered pages
- Extract specific data fields

**Examples:** Local scraper, Firecrawl, Apify

### Data Sources

**Purpose:** Import data from external systems

**What they do:**

- Connect to external platforms
- Fetch items/records
- Transform data to standard format
- Support incremental updates

**Examples:** Notion, Airtable, RSS feeds, CSV files

### AI Providers

**Purpose:** Provide language model capabilities

**What they do:**

- Generate text completions
- Support chat conversations
- Create embeddings
- List available models

**Examples:** OpenAI, Anthropic, Google Gemini, Mistral, Ollama

### Pipeline Plugins

**Purpose:** Modify or replace the content generation pipeline

**What they do:**

- Inject new processing steps
- Replace existing steps
- Disable unwanted steps
- Provide complete alternative pipelines

**Examples:** Content enrichment, spam filtering, translation, Exa Websets

### Git OAuth Providers

**Purpose:** Connect user accounts to git providers for repository access

**What they do:**

- Generate OAuth authorization URLs for git providers
- Handle OAuth callbacks to obtain access tokens
- Manage user access tokens for repository operations
- Define required permission scopes (repo access, etc.)

This is **NOT** for app authentication (logging into Ever Works). App authentication is hardcoded in the platform. Git OAuth is specifically for connecting a user's git provider account so the platform can create repositories, push code, and create pull requests on their behalf.

**Why OAuth instead of access tokens?**
Most Ever Works users are not technical and shouldn't need to manually create and paste access tokens. OAuth provides a familiar "Connect with GitHub" flow that non-technical users understand.

**Examples:** GitHub OAuth, GitLab OAuth, Bitbucket OAuth

---

## Plugin Discovery Process

### How the System Finds Plugins

When the application starts, it needs to find all available plugins. This happens through a multi-step discovery process.

### Step 1: Scan Plugin Directories

The system is configured with paths where plugins live, typically `packages/plugins/*`. It scans these directories looking for potential plugins.

### Step 2: Check for Package Definition

For each directory found, the system checks if it contains a `package.json` file. This file is standard in JavaScript/TypeScript projects and contains metadata about the package. If there's no package.json, the directory is skipped.

### Step 3: Validate Plugin Manifest

Inside the package.json, the system looks for a special `everworks.plugin` field. This field contains the plugin manifest - metadata that identifies this package as an Ever Works plugin and describes its capabilities.

Required manifest fields:

- **id** - Unique identifier (e.g., "github", "vercel")
- **name** - Human-readable display name
- **version** - Semantic version number
- **category** - Primary category (git, deployment, screenshot, etc.)

Optional manifest fields:

- **capabilities** - Additional capabilities beyond the primary category
- **description** - Short description for the UI
- **author** - Plugin author name
- **icon** - Icon for display in the UI
- **minContractsVersion** - Minimum compatible plugin contracts version
- **autoInstall** - If true, plugin is automatically installed for all users
- **systemPlugin** - If true, users cannot uninstall the plugin
- **envVars** - List of platform-level environment variables the plugin needs

### Auto-Installed vs User-Installed Plugins

Not all plugins require manual installation. Some are essential and installed automatically:

| Plugin Type  | `autoInstall` | `systemPlugin` | User Action      | Example                              |
| ------------ | ------------- | -------------- | ---------------- | ------------------------------------ |
| **System**   | `true`        | `true`         | Cannot uninstall | GitHub (core git provider)           |
| **Default**  | `true`        | `false`        | Can uninstall    | ScreenshotOne (default but optional) |
| **Optional** | `false`       | `false`        | Must install     | Notion import, Apify                 |

**How auto-install works:**

- On first app startup, all `autoInstall: true` plugins are automatically installed for existing users
- New users get auto-install plugins immediately
- System plugins (`systemPlugin: true`) cannot be disabled or uninstalled - they are core to the platform

### Step 4: Version Compatibility Check

If the plugin specifies minimum or maximum compatible versions, the system verifies that the current plugin contracts package version is compatible. Incompatible plugins are skipped with a warning.

### Step 5: Load Plugin Entry Point

The system loads the JavaScript file specified in the package.json's `main` field. This file must export the plugin class as its default export.

### Step 6: Validate Plugin Class

The loaded class is checked to ensure it properly implements the required plugin interface. It must have:

- Required metadata properties (id, name, version, category)
- Lifecycle methods (onLoad, onEnable, onDisable, onUnload)
- Settings validation method
- Settings schema for form generation

### Step 7: Register Plugin

If all validations pass, the plugin is registered in the Plugin Registry and becomes available for users to install.

### Discovery Diagram

```
Directory Scan
      │
      ▼
Has package.json? ──No──► Skip
      │
     Yes
      ▼
Has everworks.plugin? ──No──► Skip (not a plugin)
      │
     Yes
      ▼
Valid manifest? ──No──► Log warning, Skip
      │
     Yes
      ▼
Version compatible? ──No──► Log warning, Skip
      │
     Yes
      ▼
Load entry point ──Error──► Log error, Skip
      │
     OK
      ▼
Valid plugin class? ──No──► Log error, Skip
      │
     Yes
      ▼
Register in Registry ✓
```

---

## Plugin Lifecycle

Plugins go through several states during their lifetime. Understanding these states helps explain when plugins can be used and what happens during transitions.

### Plugin States

#### Discovered

The plugin has been found in the filesystem and its manifest has been validated. At this point, the plugin code hasn't been executed yet - it's just recognized as a valid plugin that could be loaded.

#### Loaded

The plugin's entry point has been loaded into memory and the `onLoad()` lifecycle hook has been called. The plugin can now initialize itself, but it's not yet active for any user or directory.

During loading, the plugin receives a context object that provides:

- Database access for storing plugin-specific data
- Access to core services (read-only)
- Event system for subscribing to platform events
- Logging utilities
- Cache for performance optimization

#### Enabled

A user has enabled this plugin for a specific directory. The `onEnable()` hook is called with the directory context. The plugin is now active and will be used when operations requiring its capability are performed on that directory.

#### Disabled

The user has disabled the plugin for a directory. The `onDisable()` hook is called, allowing the plugin to clean up any directory-specific resources. The plugin remains loaded and can be re-enabled.

#### Unloaded

The plugin is being removed from the system entirely. The `onUnload()` hook is called, allowing the plugin to clean up all resources. After unloading, the plugin returns to the Discovered state if its files still exist.

### State Transitions

```
DISCOVERED ───onLoad()───► LOADED ───onEnable()───► ENABLED
                             │                         │
                             │                         │
                         onUnload()               onDisable()
                             │                         │
                             ▼                         ▼
                         UNLOADED                  DISABLED
```

### Lifecycle Hooks Explained

**onLoad(context)**
Called once when the plugin is first loaded. Use this to:

- Initialize plugin-wide resources
- Register event listeners
- Set up database tables if needed
- Register custom capabilities for other plugins to use

**onEnable(context)**
Called each time a user enables the plugin for a directory. Use this to:

- Validate directory-specific settings
- Set up directory-specific resources
- Start any background processes for this directory

**onDisable(context)**
Called when a user disables the plugin for a directory. Use this to:

- Clean up directory-specific resources
- Stop background processes
- Save any pending state

**onUnload()**
Called when the plugin is being completely removed. Use this to:

- Clean up all resources
- Close database connections
- Unregister event listeners
- Unregister custom capabilities

---

## Configuration Hierarchy

Plugin settings follow a **four-level hierarchy**, with behavior controlled by the plugin's `configurationMode`.

### Level 1: Plugin Defaults

Every plugin defines default settings in its code. These are the baseline values that apply when no other configuration exists. For example, a screenshot plugin might default to PNG format and 1280x720 viewport.

### Level 2: Admin Settings

Platform administrators can configure plugin settings via the Admin UI. These settings are stored in the `AdminPlugin` entity and provide platform-wide defaults. Use cases include:

- **Shared API keys** - Platform provides API access for all users
- **Default configurations** - Sensible defaults for the entire platform
- **Admin-only plugins** - Some plugins only admins should configure

### Level 3: User Settings

When a user installs a plugin, they can provide their own settings - typically API keys and personal preferences. These settings are stored encrypted in the database and override admin defaults (unless the plugin is `admin-only`).

User settings apply across all of that user's directories unless overridden at the directory level.

### Level 4: Directory Settings

For specific directories, users can override their global settings. This allows different configurations for different projects. For example, a user might want higher resolution screenshots for their portfolio directory but standard resolution for others.

### Configuration Mode

Each plugin declares its `configurationMode` to control who can configure it:

| Mode               | Description                                     | Typical Use                       |
| ------------------ | ----------------------------------------------- | --------------------------------- |
| `admin-only`       | Only admins configure; users get admin settings | Platform-provided shared API keys |
| `user-required`    | Users must provide settings; no admin fallback  | Personal API keys (user BYOK)     |
| `hybrid` (default) | Admin provides defaults; users can override     | Flexible plugins                  |

### Resolution Process

When the system needs plugin settings, it merges levels based on `configurationMode`:

**For `hybrid` plugins (most common):**

1. Start with plugin defaults
2. Overlay admin settings (overriding matching keys)
3. Overlay user settings (overriding matching keys)
4. Overlay directory settings (overriding matching keys)
5. Return the merged result

**For `admin-only` plugins:**

1. Start with plugin defaults
2. Overlay admin settings
3. Return (user/directory settings ignored)

**For `user-required` plugins:**

1. Start with plugin defaults
2. Overlay user settings (admin settings skipped)
3. Overlay directory settings
4. Return the merged result

### Important: Two Types of Configuration

The plugin system distinguishes between two types of configuration:

#### User Settings (Per-User, Per-Directory)

These are settings that individual users enter through the UI:

- **API Keys** - User's own API keys for services (ScreenshotOne, Tavily, etc.)
- **Preferences** - User-specific preferences (viewport size, output format)
- **Credentials** - User's own tokens and secrets

User settings are:

- Stored encrypted in the database
- Configured through the UI
- Can be overridden per directory
- Resolved at runtime: Plugin Defaults → User Settings → Directory Settings

**Example:** A user's ScreenshotOne API key that they obtained from their own ScreenshotOne account.

#### Platform Environment Variables (Admin-Level)

These are server-level configurations set by platform administrators:

- **OAuth Client IDs/Secrets** - For OAuth flows with git providers (GitHub, GitLab)
- **Callback URLs** - OAuth callback endpoints
- **Platform API Keys** - Keys the platform uses globally (not per-user)

Platform environment variables are:

- Set in server environment (`.env` file, container env vars)
- Declared in the plugin's `envVars` manifest field
- Validated at startup (required vars must be present)
- Accessed via `context.env` (NEVER `process.env` directly)

**Example:** The GitHub OAuth Client ID/Secret that the platform administrator configured to enable "Connect with GitHub" for all users.

#### Why The Separation?

| Aspect             | User Settings                    | Platform Env Vars               |
| ------------------ | -------------------------------- | ------------------------------- |
| **Who configures** | Each user                        | Platform admin                  |
| **Where stored**   | Encrypted in database            | Server environment              |
| **Scope**          | Per-user, can vary per directory | Platform-wide                   |
| **Example**        | User's Tavily API key            | GitHub OAuth Client ID          |
| **Entry method**   | UI form                          | `.env` file / deployment config |

This separation ensures:

1. Users don't need server access to configure their own integrations
2. Sensitive OAuth credentials stay server-side
3. Platform admins control what integrations are available
4. Testing is easier (mock `context.env` in tests)

---

## Pipeline Architecture

The content generation pipeline is the heart of Ever Works. The plugin system makes it fully customizable.

### What is the Pipeline?

The pipeline is a series of steps that transform a user's prompt into a complete directory of items. Each step performs a specific task and passes its results to the next step.

### The Default Pipeline Plugin (System Plugin)

The standard 14-step pipeline is provided by the **Default Pipeline Plugin**. This is a **system plugin** with special characteristics:

| Property       | Value  | Meaning                                                   |
| -------------- | ------ | --------------------------------------------------------- |
| `autoInstall`  | `true` | Automatically installed for all users                     |
| `systemPlugin` | `true` | Cannot be uninstalled, **NOT visible in user plugins UI** |

**Why is it hidden from users?**

1. **Core Infrastructure** - The standard pipeline is foundational; it cannot be removed
2. **Indirect Interaction** - Users configure _providers_ (Search, Screenshot, AI), not the pipeline itself
3. **Prevents Accidents** - Users cannot accidentally break their directory generation
4. **Always Loaded** - Even when other pipeline plugins modify steps, they reference this base

**How users interact with the pipeline:**

- In the generator form, users select providers (e.g., "Tavily" for search, "ScreenshotOne" for screenshots)
- These provider selections are applied to the appropriate pipeline steps
- Users choose between "Standard Pipeline" and "Full Pipeline" modes (e.g., Exa Websets)
- Individual steps are managed automatically - users never see or configure them directly

### Standard Pipeline Steps

The standard pipeline has 14 built-in steps:

1. **Prompt Comparison** - Compare with previous prompts for incremental generation
2. **Prompt Processing** - Extract intent and parameters from the prompt
3. **Domain Detection** - Identify the type of directory (software, restaurants, etc.)
4. **Search Query Generation** - Create search queries based on the prompt
5. **AI Item Generation** - Generate initial items using AI (runs parallel with search)
6. **Web Page Retrieval** - Fetch web pages from search results
7. **Content Filtering** - Remove irrelevant content
8. **Item Extraction** - Extract structured items from content
9. **Data Aggregation** - Combine and deduplicate items from all sources
10. **Category Processing** - Organize items into categories
11. **Source Validation** - Verify item source URLs are valid
12. **Badge Processing** - Add badges to items (optional)
13. **Image Capture** - Take screenshots for items
14. **Markdown Generation** - Generate final markdown content

### How Plugins Modify the Pipeline

Plugins can modify the pipeline in four ways:

#### 1. Full Pipeline Replacement

Some plugins provide a complete alternative pipeline. When selected, the standard pipeline is bypassed entirely, and the plugin's own pipeline runs instead.

Example: Exa Websets provides an AI-powered directory generation system with its own steps for research, curation, and enrichment.

#### 2. Step Replacement

Plugins can replace specific steps with their own implementation. The step runs at the same point in the pipeline but uses different logic.

Example: The Exa Search plugin can replace the "Search Query Generation" step with its neural search implementation.

#### 3. Step Injection

Plugins can add new steps at specific points in the pipeline - before or after existing steps.

Example: A Content Enrichment plugin might inject steps after "Item Extraction" to add social media metrics and pricing data.

#### 4. Step Disabling

Plugins can disable steps that aren't needed for a particular use case.

Example: A plugin might disable "Badge Processing" for directories that don't use badges.

### Pipeline Execution Flow

```
User Request
      │
      ▼
Is Full Pipeline selected? ───Yes───► Run Full Pipeline Plugin's steps
      │
      No
      │
      ▼
Build Standard Pipeline:
  • Start with 14 built-in steps
  • Apply plugin step replacements
  • Apply plugin step injections
  • Remove disabled steps
  • Sort by dependencies
  • Identify parallel groups
      │
      ▼
Execute Pipeline:
  • Run steps in order
  • Run parallel groups concurrently
  • Handle errors for optional steps
  • Save checkpoints
      │
      ▼
Return Results
```

### Step Dependencies

Each step declares what it depends on (inputs) and what it provides (outputs). This allows the system to:

- Automatically determine the correct execution order
- Identify steps that can run in parallel
- Skip steps when their output is already available
- Validate that all dependencies are satisfied

For example, "Item Extraction" depends on "Content Filtering" and provides "extracted-items". "Data Aggregation" depends on both "Item Extraction" and "AI Item Generation" (it needs items from both sources).

---

## Multi-Capability Plugins

Some plugins provide multiple capabilities that users might want to use independently. The plugin system supports this through sub-providers.

### What is a Sub-Provider?

A sub-provider is a specific capability offering within a larger plugin. One plugin can have multiple sub-providers that appear in different places in the UI.

### Example: Exa Plugin

The Exa.ai plugin provides two distinct capabilities:

1. **Exa Websets** - A complete pipeline replacement that handles the entire generation process
2. **Exa Search** - A search provider that can replace just the search step in the standard pipeline

These are both provided by the same Exa plugin, but they appear in different dropdowns:

- Exa Websets appears in the "Pipeline Mode" selection
- Exa Search appears in the "Search Provider" selection

### Why Sub-Providers?

Without sub-providers, we would need separate plugins for each capability:

- `@ever-works/plugin-exa-websets`
- `@ever-works/plugin-exa-search`

This creates problems:

- Duplicated code for authentication and API client
- Harder to maintain consistency
- More confusing for users who just want "Exa"

Sub-providers keep related functionality together while letting users choose specific capabilities.

### Config Field Handling

When a sub-provider handles certain aspects of generation, it can declare which configuration fields it manages. The UI then grays out those fields and shows a tooltip explaining that the selected provider handles them.

For example, when Exa Websets is selected, it might handle all search-related fields itself, so those fields are grayed out in the configuration form.

---

## User Experience Flow

### Installing a Plugin

1. User navigates to Settings → Plugins
2. User sees a list of available plugins (discovered from the plugins directory)
3. User clicks "Install" on a plugin they want
4. A configuration form appears, generated from the plugin's settings schema
5. User enters required information (API keys, preferences)
6. The plugin validates the settings (e.g., tests the API key)
7. If valid, the plugin is installed and settings are saved encrypted
8. The plugin appears in the user's installed plugins list

### Enabling a Plugin for a Directory

1. User navigates to a directory's settings
2. User goes to the "Apps" or "Plugins" tab
3. User sees their installed plugins
4. User toggles a plugin on for this directory
5. If the plugin has directory-specific settings, a form appears
6. User configures any directory-specific overrides
7. The plugin is now active for this directory

### Using Plugins During Generation

1. User opens the generator form for a directory
2. The form shows provider dropdowns populated with installed plugins
3. Each category (Search, Screenshot, AI) shows available options
4. User selects their preferred providers for this generation
5. If a Full Pipeline is selected, standard pipeline options may be grayed out
6. User fills in any plugin-specific options that appear dynamically
7. Generation runs using the selected plugins

### Switching Providers

Because providers implement standard interfaces, switching is seamless:

1. User installs a new deployment plugin (e.g., Netlify)
2. User enables Netlify for their directory
3. User selects Netlify in the deployment settings
4. Future deployments use Netlify instead of Vercel
5. No code changes required, no data migration needed

---

## Security Model

### Settings Encryption

Plugin settings that contain sensitive data are encrypted before storage in the database. **Plugins define which fields are sensitive** using security markers in their settings schema:

```typescript
// In plugin's settingsSchema
accessKey: {
    type: 'string',
    secret: true,       // Encrypt at rest in database
    masked: true,       // Show "********" in UI
    writeOnly: true,    // Never return via API
}
```

| Marker      | Effect                                                               |
| ----------- | -------------------------------------------------------------------- |
| `secret`    | Field is encrypted in database, decrypted only for internal use      |
| `masked`    | Field displays as "**\*\*\*\***" in UI (editable, just not readable) |
| `writeOnly` | Field is omitted from API responses entirely                         |

This approach ensures:

- Plugins control their own security requirements
- Platform doesn't guess which fields are sensitive
- Consistent handling across all plugins

See [PLUGIN_SYSTEM_RFC.md](./PLUGIN_SYSTEM_RFC.md#settings-schema-with-security-markers) for complete type definitions.

### Plugin Isolation

Plugins run in the same process as the core application but have limited access:

- They receive a controlled context object, not direct access to internals
- Database access is scoped to their own tables
- They cannot access other plugins' settings
- They cannot modify core services, only read from them

### Validation

Plugin settings are validated at multiple points:

1. **On installation** - The plugin's `validateSettings()` method is called
2. **On enable** - Settings are re-validated in the directory context
3. **On use** - Settings are validated before each operation

### Error Boundaries

Plugin errors are caught and handled gracefully:

- A failing plugin doesn't crash the entire application
- Errors are logged with context for debugging
- Users see helpful error messages, not stack traces
- The system can fall back to alternatives when available

### No Arbitrary Code Execution

Plugins must be installed in the plugins directory by someone with server access. Users cannot upload arbitrary plugin code through the UI. This prevents malicious code injection while still allowing extensibility.

---

## What's NOT Part of the Plugin System

Some functionality remains hardcoded in the platform and is NOT extensible through plugins:

### App Authentication

How users log into Ever Works (email/password, social login with Google, etc.) is hardcoded. This is intentional:

- Users must authenticate before they can access the plugin system
- App authentication is a core security concern
- Changing authentication providers requires careful security review

**Important distinction:**

- **App Authentication** = How users log into Ever Works → Hardcoded
- **Git OAuth** = How users connect their GitHub/GitLab accounts → Plugin-based

### Core Database Schema

The main database tables (users, directories, items, etc.) are not extensible through plugins. Plugins can create their own tables for plugin-specific data, but cannot modify core tables.

### UI Framework

The web application's core framework (Next.js, React) is not pluggable. Plugins can provide form field definitions and settings schemas, but cannot inject arbitrary UI components.

---

## Testing Plugins

The plugin system is designed for easy testing. Since plugins are standalone packages (not NestJS modules), they can be tested with simple unit tests using Jest.

### Testing Principles

1. **Environment vars via context** - Plugins access env vars through `context.env`, NEVER `process.env` directly. This makes testing easy.
2. **Mock factories provided** - The `@ever-works/plugin-test-utils` package provides mock factories for all core types.
3. **Contract tests** - Every plugin should run base contract tests that validate IPlugin compliance.
4. **Minimum 80% coverage** - All plugin code should have at least 80% test coverage.

### How to Test a Plugin

```typescript
// Example: Testing a ScreenshotOne plugin
import { ScreenshotOnePlugin } from '../screenshotone.plugin';
import { createMockPluginContext, createMockPluginEnvironment } from '@ever-works/plugin-test-utils';

describe('ScreenshotOnePlugin', () => {
	let plugin: ScreenshotOnePlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new ScreenshotOnePlugin();

		// Create mock context with mock environment variables
		mockContext = createMockPluginContext({
			// Mock user settings (from database)
			settings: { accessKey: 'user-key', secretKey: 'user-secret' },

			// Mock platform environment variables
			env: createMockPluginEnvironment({
				SCREENSHOTONE_DEFAULT_KEY: 'platform-default-key'
			})
		});
	});

	it('should load without errors', async () => {
		await expect(plugin.onLoad(mockContext)).resolves.not.toThrow();
	});

	it('should validate settings correctly', async () => {
		const result = await plugin.validateSettings({
			accessKey: 'valid-key'
		});
		expect(result.valid).toBe(true);
	});

	it('should capture screenshots', async () => {
		// Mock external API
		jest.spyOn(plugin as any, 'callApi').mockResolvedValue({
			url: 'https://cdn.example.com/screenshot.png'
		});

		const result = await plugin.capture('https://example.com', {});
		expect(result.url).toBeDefined();
	});
});
```

### Mock Plugin Environment

The mock environment allows you to test how your plugin handles different environment configurations:

```typescript
// Testing with required env vars present
const mockEnv = createMockPluginEnvironment({
	GH_CLIENT_ID: 'test-client-id',
	GH_CLIENT_SECRET: 'test-secret'
});

// Testing missing required env var
const emptyEnv = createMockPluginEnvironment({});
expect(() => emptyEnv.getRequired('GH_CLIENT_ID')).toThrow('Missing required env var');
```

### Why context.env Instead of process.env?

```typescript
// ❌ BAD: Hard to test
class MyPlugin {
	async connect() {
		const clientId = process.env.MY_CLIENT_ID; // Can't mock!
	}
}

// ✅ GOOD: Easy to test
class MyPlugin {
	async connect(context: PluginContext) {
		const clientId = context.env.get('MY_CLIENT_ID'); // Mockable!
	}
}
```

By accessing environment variables through `context.env`, you can easily provide different values in tests without modifying the actual environment.

---

## Glossary

**Capability** - A type of functionality that plugins can provide (git, deployment, screenshot, etc.)

**Capability Interface** - The contract that plugins must implement to provide a specific capability

**Custom Capability** - A capability defined by a plugin for plugin-to-plugin communication, not used by the core system

**Directory Plugin** - The association between a plugin and a specific directory, including directory-specific settings

**Facade** - A simple wrapper that hides plugin system complexity from the rest of the application

**Full Pipeline** - A plugin that provides a complete alternative to the standard generation pipeline

**Git OAuth** - OAuth authentication flow used by git provider plugins (GitHub, GitLab, Bitbucket) to connect user accounts for repository access. This is different from app authentication.

**Lifecycle Hook** - A method called at specific points in a plugin's lifetime (load, enable, disable, unload)

**Manifest** - The metadata in a plugin's package.json that identifies it as an Ever Works plugin

**Pipeline** - The series of steps that transform a prompt into generated content

**Pipeline Step** - A single unit of work in the pipeline that takes input and produces output

**Plugin** - A self-contained package that provides capabilities to the Ever Works platform

**Plugin Context** - The object passed to plugins giving them access to platform services

**Plugin Contracts** - The package containing all interfaces and types that plugins must implement

**Plugin Registry** - The central service that tracks all plugins and their states

**Provider** - Another term for a plugin that provides a specific capability

**Settings Schema** - A JSON Schema definition that describes what settings a plugin accepts, including security markers (`secret`, `masked`, `writeOnly`) for sensitive fields

**Step Injection** - Adding a new step to the pipeline at a specific position

**Step Replacement** - Substituting a built-in pipeline step with a plugin's implementation

**Sub-Provider** - A specific capability offering within a multi-capability plugin

**User Plugin** - The association between a plugin and a user, including the user's settings for that plugin
