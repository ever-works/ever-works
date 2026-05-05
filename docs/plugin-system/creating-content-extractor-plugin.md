---
id: creating-content-extractor-plugin
title: 'Creating a Content Extractor Plugin'
sidebar_label: 'Content Extractor Plugin'
sidebar_position: 8
---

# Creating a Content Extractor Plugin

Content extractor plugins retrieve text, HTML, and Markdown from web pages so the AI pipeline can use that content as source material during work generation. They integrate into the pipeline at the **content-retrieval** step and are consumed through the `IContentExtractorFacade`.

This guide covers everything you need to build one from scratch, register it with the platform, and test it thoroughly.

## Two Types of Content Extractors

Before you start, decide which type you are building:

|                    | General-Purpose                                                     | Additive (URL-Specific)                                           |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Handles**        | Any HTTP/HTTPS URL                                                  | Only URLs matching a specific domain or pattern                   |
| **`canExtract()`** | Returns `true` for all valid HTTP(S) URLs                           | Returns `true` only for matching URLs (e.g., `notion.so`)         |
| **`systemPlugin`** | Usually `true`                                                      | Usually `false`                                                   |
| **`autoEnable`**   | Often `true` (acts as fallback)                                     | `false` (user opts in)                                            |
| **Examples**       | Local Content Extractor, Jina, Firecrawl                            | Notion Extractor, PDF Extractor                                   |
| **Routing**        | Facade falls back to this when no additive extractor claims the URL | Facade routes matching URLs here automatically via `canExtract()` |

:::tip
**URL-based auto-routing**: When the content extractor facade receives a URL, it first asks every enabled additive extractor whether it `canExtract()` that URL. The first one that returns `true` handles the request. If none claim the URL, the general-purpose (system/default) extractor handles it.
:::

## Prerequisites

- Node.js >= 20
- pnpm (never npm or yarn)
- Familiarity with the [Creating a Plugin](./creating-a-plugin) guide
- The monorepo cloned and dependencies installed (`pnpm install`)

## The `IContentExtractorPlugin` Interface

Every content extractor plugin implements both `IPlugin` and `IContentExtractorPlugin`. Here is the full interface from `@ever-works/plugin`:

```typescript
export interface IContentExtractorPlugin extends IPlugin {
	/** Provider name (e.g., 'firecrawl', 'jina', 'readability') */
	readonly providerName: string;

	/** Extract content from a single URL */
	extract(options: ContentExtractionOptions): Promise<ContentExtractionResult>;

	/** Extract content from multiple URLs (optional) */
	extractBatch?(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]>;

	/** Check if the service is available */
	isAvailable(): Promise<boolean>;

	/** Check if a URL can be extracted by this plugin (optional) */
	canExtract?(url: string): Promise<boolean>;

	/** Get supported output formats (optional) */
	getSupportedFormats?(): readonly ('text' | 'html' | 'markdown')[];
}
```

### `ContentExtractionOptions`

The options object passed to `extract()`:

```typescript
export interface ContentExtractionOptions {
	readonly url: string;
	readonly includeImages?: boolean;
	readonly includeLinks?: boolean;
	readonly includeMetadata?: boolean;
	readonly maxLength?: number;
	readonly timeout?: number;
	readonly waitForJs?: boolean;
	readonly waitForSelector?: string;
	readonly headers?: Record<string, string>;
	readonly userAgent?: string;
	readonly selectors?: readonly string[];
	readonly removeSelectors?: readonly string[];
	/** Resolved settings — use these instead of stored defaults */
	readonly settings?: PluginSettings;
}
```

### `ContentExtractionResult`

The result returned from `extract()`:

```typescript
export interface ContentExtractionResult {
	readonly success: boolean;
	readonly url: string;
	readonly finalUrl?: string; // After redirects
	readonly title?: string;
	readonly content?: string; // Plain text
	readonly html?: string; // Raw HTML
	readonly markdown?: string; // Converted Markdown
	readonly images?: readonly ExtractedImage[];
	readonly links?: readonly ExtractedLink[];
	readonly metadata?: PageMetadata;
	readonly error?: string; // Error message if success is false
	readonly duration?: number; // Extraction time in ms
	readonly wordCount?: number;
	readonly readingTime?: number; // Estimated minutes
}
```

### Supporting Types

```typescript
export interface ExtractedImage {
	readonly src: string;
	readonly alt?: string;
	readonly title?: string;
	readonly width?: number;
	readonly height?: number;
}

export interface ExtractedLink {
	readonly href: string;
	readonly text?: string;
	readonly title?: string;
	readonly rel?: string;
	readonly isExternal: boolean;
}

export interface PageMetadata {
	readonly title?: string;
	readonly description?: string;
	readonly author?: string;
	readonly publishedDate?: string;
	readonly modifiedDate?: string;
	readonly language?: string;
	readonly keywords?: readonly string[];
	readonly ogTitle?: string;
	readonly ogDescription?: string;
	readonly ogImage?: string;
	readonly ogType?: string;
	readonly twitterCard?: string;
	readonly twitterTitle?: string;
	readonly twitterDescription?: string;
	readonly twitterImage?: string;
	readonly canonicalUrl?: string;
	readonly favicon?: string;
}
```

## Project Scaffolding

Create the following structure under `packages/plugins/`:

```
packages/plugins/my-extractor/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts
    ├── my-extractor.plugin.ts
    └── __tests__/
        └── my-extractor.plugin.spec.ts
```

### `package.json`

```json
{
	"name": "@ever-works/my-extractor-plugin",
	"version": "1.0.0",
	"description": "My custom content extractor plugin",
	"private": true,
	"type": "module",
	"main": "./dist/index.cjs",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js",
			"require": "./dist/index.cjs"
		}
	},
	"scripts": {
		"build": "tsup",
		"dev": "tsup --watch",
		"type-check": "tsc --noEmit",
		"clean": "rm -rf dist",
		"test": "vitest run --passWithNoTests",
		"test:watch": "vitest",
		"test:coverage": "vitest run --coverage"
	},
	"dependencies": {
		"axios": "^1.13.4"
	},
	"peerDependencies": {
		"@ever-works/plugin": "workspace:*"
	},
	"devDependencies": {
		"@ever-works/plugin": "workspace:*",
		"tsup": "^8.4.0",
		"typescript": "^5.7.3",
		"vitest": "^3.0.0"
	},
	"everworks": {
		"plugin": {
			"id": "my-extractor",
			"name": "My Extractor",
			"version": "1.0.0",
			"category": "content-extractor",
			"capabilities": ["content-extractor"],
			"description": "Custom content extraction provider.",
			"author": {
				"name": "Your Name"
			},
			"license": "AGPL-3.0",
			"builtIn": true,
			"autoEnable": false
		}
	}
}
```

:::warning Key `everworks.plugin` fields

- **`category`** must be `"content-extractor"`
- **`capabilities`** must include `"content-extractor"`
- **`id`** must exactly match the `id` property in your plugin class
- Set **`systemPlugin: true`** and **`autoEnable: true`** only for general-purpose extractors that should be the fallback
  :::

### `tsup.config.ts`

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: true,
	splitting: false,
	treeshake: true
});
```

### `tsconfig.json`

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"declaration": true,
		"declarationMap": true,
		"sourceMap": true,
		"outDir": "./dist",
		"rootDir": "./src",
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"resolveJsonModule": true,
		"isolatedModules": true,
		"noEmit": true
	}
}
```

### `src/index.ts`

Always provide both named and default exports:

```typescript
export { MyExtractorPlugin } from './my-extractor.plugin.js';
export { MyExtractorPlugin as default } from './my-extractor.plugin.js';
```

:::warning
Use `.js` extensions in import paths, even though the source files are `.ts`. This is required for ESM module resolution.
:::

## Building a General-Purpose Extractor

A general-purpose extractor handles any HTTP/HTTPS URL. It is typically set as a system plugin and serves as the fallback when no additive extractor claims a URL.

Here is a complete implementation that fetches HTML via axios and converts it to Markdown:

```typescript
import type {
	IPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ContentExtractionOptions,
	ContentExtractionResult,
	ExtractedImage,
	ExtractedLink,
	PageMetadata
} from '@ever-works/plugin';

import axios, { type AxiosError } from 'axios';

export class MyExtractorPlugin implements IPlugin, IContentExtractorPlugin {
	// ── IPlugin Properties ───────────────────────────────────
	readonly id = 'my-extractor';
	readonly name = 'My Extractor';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['content-extractor'];
	readonly providerName = 'My Extractor';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			timeout: {
				type: 'number',
				title: 'Request Timeout',
				description: 'HTTP request timeout in milliseconds',
				default: 15000,
				minimum: 1000,
				maximum: 60000,
				'x-hidden': true
			},
			userAgent: {
				type: 'string',
				title: 'User Agent',
				description: 'Custom user agent string for HTTP requests',
				default: 'Mozilla/5.0 (compatible; EverWorks/1.0)',
				'x-hidden': true
			}
		}
	};

	readonly systemPlugin = true;

	private context?: PluginContext;

	// ── IContentExtractorPlugin ──────────────────────────────

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();
		const { url, settings } = options;

		const timeout = (settings?.timeout as number) || 15000;
		const userAgent =
			(settings?.userAgent as string) || options.userAgent || 'Mozilla/5.0 (compatible; EverWorks/1.0)';

		try {
			const response = await axios.get(url, {
				headers: {
					Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'User-Agent': userAgent
				},
				timeout,
				maxRedirects: 5,
				validateStatus: (status) => status >= 200 && status < 400
			});

			const contentType = response.headers['content-type'] || '';
			if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
				return {
					success: false,
					url,
					error: `Unsupported content type: ${contentType}`,
					duration: Date.now() - startTime
				};
			}

			const html = response.data as string;
			const finalUrl = response.request?.res?.responseUrl || url;

			// --- Your extraction logic goes here ---
			// Parse HTML, extract content, convert to Markdown, etc.
			const content = this.extractTextFromHtml(html);
			const title = this.extractTitle(html);
			const metadata = this.extractMetadata(html, url);
			const images = options.includeImages !== false ? this.extractImages(html, finalUrl) : [];
			const links = options.includeLinks !== false ? this.extractLinks(html, finalUrl) : [];
			const wordCount = this.countWords(content);

			return {
				success: true,
				url,
				finalUrl: finalUrl !== url ? finalUrl : undefined,
				title,
				content,
				html,
				markdown: content, // Replace with actual Markdown conversion
				images,
				links,
				metadata,
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
			};
		} catch (error) {
			const axiosError = error as AxiosError;
			const errorMessage = axiosError.response?.status
				? `HTTP ${axiosError.response.status}: ${axiosError.message}`
				: axiosError.message || String(error);

			return {
				success: false,
				url,
				error: errorMessage,
				duration: Date.now() - startTime
			};
		}
	}

	async extractBatch(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]> {
		const batchSize = 5;
		const results: ContentExtractionResult[] = [];

		for (let i = 0; i < urls.length; i += batchSize) {
			const batch = urls.slice(i, i + batchSize);
			const batchResults = await Promise.all(batch.map((url) => this.extract({ url, ...options })));
			results.push(...batchResults);

			// Delay between batches to avoid overwhelming targets
			if (i + batchSize < urls.length) {
				await this.delay(100);
			}
		}

		return results;
	}

	async isAvailable(): Promise<boolean> {
		return true; // No external dependencies
	}

	async canExtract(url: string): Promise<boolean> {
		try {
			const parsed = new URL(url);
			return parsed.protocol === 'http:' || parsed.protocol === 'https:';
		} catch {
			return false;
		}
	}

	getSupportedFormats(): readonly ('text' | 'html' | 'markdown')[] {
		return ['text', 'html', 'markdown'];
	}

	// ── IPlugin Lifecycle ────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('My Extractor Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'My extractor is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Custom general-purpose content extractor',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Your Name' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'public',
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
			}
		};
	}

	// ── Private Helpers ──────────────────────────────────────

	private extractTextFromHtml(html: string): string {
		// Implement your text extraction logic
		// The built-in Local Content Extractor uses Readability + linkedom
		return html
			.replace(/<[^>]*>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	private extractTitle(html: string): string | undefined {
		const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		return match?.[1]?.trim();
	}

	private extractMetadata(html: string, baseUrl: string): PageMetadata {
		// Extract OG tags, Twitter cards, canonical URL, etc.
		return {
			title: this.extractTitle(html),
			canonicalUrl: baseUrl
		};
	}

	private extractImages(html: string, baseUrl: string): ExtractedImage[] {
		// Parse <img> tags from the HTML
		return [];
	}

	private extractLinks(html: string, baseUrl: string): ExtractedLink[] {
		// Parse <a> tags from the HTML
		return [];
	}

	private countWords(text: string): number {
		return text.split(/\s+/).filter((word) => word.length > 0).length;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export default MyExtractorPlugin;
```

:::info How the built-in Local Content Extractor works
The platform ships with `local-content-extractor`, which uses a three-stage fallback strategy:

1. **Readability** (Mozilla) parses the DOM and extracts the main article content
2. **Meta description fallback** -- if Readability yields too little text, the OG/meta description is used
3. **Cleaned body fallback** -- unwanted elements (scripts, ads, nav, footer, sidebars) are stripped and body text is returned

It uses `linkedom` for DOM parsing (no browser required) and `Turndown` for HTML-to-Markdown conversion. Your general-purpose extractor can use the same libraries or any alternative approach.
:::

## Building an Additive (URL-Specific) Extractor

An additive extractor handles only URLs that match a specific pattern. The key difference is the `canExtract()` method, which acts as a URL filter. When the facade encounters a URL, additive extractors get first priority -- if one claims the URL, it handles the request.

Here is a complete example for a hypothetical "Dev Docs" service that extracts content from `docs.example.com`:

```typescript
import type {
	IPlugin,
	IContentExtractorPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ContentExtractionOptions,
	ContentExtractionResult
} from '@ever-works/plugin';

import axios from 'axios';

export class DevDocsExtractorPlugin implements IPlugin, IContentExtractorPlugin {
	readonly id = 'devdocs-extractor';
	readonly name = 'Dev Docs Extractor';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'content-extractor';
	readonly capabilities: readonly string[] = ['content-extractor'];
	readonly providerName = 'Dev Docs';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'Dev Docs API Key',
				description: 'Optional API key for authenticated access to private docs.',
				'x-secret': true,
				'x-scope': 'user'
			},
			timeout: {
				type: 'number',
				title: 'Request Timeout',
				description: 'HTTP request timeout in milliseconds',
				default: 30000,
				minimum: 5000,
				maximum: 120000
			}
		}
	};

	/** NOT a system plugin -- users must explicitly enable it */
	readonly systemPlugin = false;

	private context?: PluginContext;

	// ── The critical canExtract() method ─────────────────────

	/**
	 * Returns true ONLY for docs.example.com URLs.
	 * This is what makes the plugin additive -- all other URLs
	 * fall through to the default extractor.
	 */
	async canExtract(url: string): Promise<boolean> {
		try {
			const parsed = new URL(url);
			return /^([\w-]+\.)?docs\.example\.com$/.test(parsed.hostname);
		} catch {
			return false;
		}
	}

	// ── Extract ──────────────────────────────────────────────

	async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
		const startTime = Date.now();
		const { url, settings } = options;

		// Guard: verify this is actually our URL
		const canHandle = await this.canExtract(url);
		if (!canHandle) {
			return {
				success: false,
				url,
				error: 'Not a Dev Docs URL. This plugin only handles docs.example.com.',
				duration: Date.now() - startTime
			};
		}

		try {
			const apiKey = settings?.apiKey as string | undefined;
			const timeout = (settings?.timeout as number) || 30000;

			// Use the service's structured API for clean extraction
			const response = await axios.get(`https://api.docs.example.com/v1/extract`, {
				params: { url },
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
				timeout
			});

			const data = response.data;
			const wordCount = this.countWords(data.content || '');

			return {
				success: true,
				url,
				title: data.title,
				content: data.content,
				markdown: data.markdown,
				metadata: {
					author: data.author,
					publishedDate: data.publishedAt,
					language: data.language
				},
				duration: Date.now() - startTime,
				wordCount,
				readingTime: Math.ceil(wordCount / 200)
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Dev Docs extraction failed: ${errorMessage}`);

			return {
				success: false,
				url,
				error: errorMessage,
				duration: Date.now() - startTime
			};
		}
	}

	async extractBatch(
		urls: readonly string[],
		options?: Partial<ContentExtractionOptions>
	): Promise<readonly ContentExtractionResult[]> {
		const results: ContentExtractionResult[] = [];

		for (const url of urls) {
			const result = await this.extract({ url, ...options });
			results.push(result);

			// Delay between requests to respect rate limits
			if (urls.indexOf(url) < urls.length - 1) {
				await this.delay(200);
			}
		}

		return results;
	}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	getSupportedFormats(): readonly ('text' | 'html' | 'markdown')[] {
		return ['text', 'markdown'];
	}

	// ── Lifecycle ────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Dev Docs Extractor Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Dev Docs extractor is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Extract content from Dev Docs pages for use as source material',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Your Name' },
			license: 'AGPL-3.0',
			builtIn: false,
			systemPlugin: false,
			supplementary: true,
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M8 10h8"/><path d="M8 14h6"/></svg>'
			},
			readme: [
				'## What does the Dev Docs Extractor do?',
				'',
				'Extracts content from docs.example.com pages and converts it to clean Markdown.',
				'',
				'## Getting started',
				'',
				'1. Enable the Dev Docs Extractor plugin',
				'2. For public docs, no configuration is needed',
				'3. For private docs, enter your API key in settings',
				'4. Add docs.example.com URLs as source material when generating'
			].join('\n')
		};
	}

	// ── Helpers ──────────────────────────────────────────────

	private countWords(text: string): number {
		return text.split(/\s+/).filter((word) => word.length > 0).length;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export default DevDocsExtractorPlugin;
```

### Key differences from a general-purpose extractor

| Aspect                        | General-Purpose                     | Additive                                        |
| ----------------------------- | ----------------------------------- | ----------------------------------------------- |
| `systemPlugin`                | `true`                              | `false`                                         |
| `canExtract()`                | Returns `true` for all HTTP(S) URLs | Returns `true` only for matching domains        |
| `getManifest().supplementary` | Not set                             | `true`                                          |
| `getManifest().builtIn`       | `true`                              | `false`                                         |
| Guard in `extract()`          | Not needed                          | Should verify the URL matches before processing |
| `package.json` `autoEnable`   | `true`                              | Not set or `false`                              |

## Batch Extraction with Throttling

The `extractBatch()` method is optional but strongly recommended. The pipeline calls it when processing multiple source URLs simultaneously. Two common throttling patterns are used in the codebase:

### Pattern 1: Parallel batches with delay (general-purpose)

Process URLs in groups of N, with a delay between groups. Used by the Local Content Extractor and Jina:

```typescript
async extractBatch(
    urls: readonly string[],
    options?: Partial<ContentExtractionOptions>
): Promise<readonly ContentExtractionResult[]> {
    const batchSize = 5;
    const results: ContentExtractionResult[] = [];

    for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);

        // Process batch in parallel
        const batchResults = await Promise.all(
            batch.map((url) => this.extract({ url, ...options }))
        );
        results.push(...batchResults);

        // Delay between batches to avoid overwhelming targets
        if (i + batchSize < urls.length) {
            await this.delay(100);
        }
    }

    return results;
}
```

### Pattern 2: Sequential with delay (rate-limited APIs)

Process URLs one at a time with a delay between each. Used by the Notion Extractor:

```typescript
async extractBatch(
    urls: readonly string[],
    options?: Partial<ContentExtractionOptions>
): Promise<readonly ContentExtractionResult[]> {
    const results: ContentExtractionResult[] = [];

    for (const url of urls) {
        const result = await this.extract({ url, ...options });
        results.push(result);

        // Delay between requests to respect rate limits
        if (urls.indexOf(url) < urls.length - 1) {
            await this.delay(200);
        }
    }

    return results;
}
```

:::tip Choosing a batch strategy

- Use **parallel batches** when you control the HTTP requests directly (no external API rate limits)
- Use **sequential processing** when calling a third-party API with strict rate limits
- A batch size of **5** and delay of **100ms** is a good default for general-purpose extractors
  :::

## Metadata Extraction

Rich metadata improves how extracted content is used in the pipeline. The `PageMetadata` interface supports Open Graph tags, Twitter Cards, canonical URLs, and more.

Here is a reusable metadata extraction pattern based on the Local Content Extractor:

```typescript
private extractMetadata(document: Document, baseUrl: string): PageMetadata {
    const getMeta = (names: string[]): string | undefined => {
        for (const name of names) {
            const content =
                document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ||
                document.querySelector(`meta[property="${name}"]`)?.getAttribute('content');
            if (content) return content;
        }
        return undefined;
    };

    const favicon =
        document.querySelector('link[rel="icon"]')?.getAttribute('href') ||
        document.querySelector('link[rel="shortcut icon"]')?.getAttribute('href');

    return {
        title: document.querySelector('title')?.textContent || undefined,
        description: getMeta(['description', 'og:description']),
        author: getMeta(['author', 'article:author']),
        publishedDate: getMeta(['article:published_time', 'date', 'pubdate']),
        modifiedDate: getMeta(['article:modified_time', 'last-modified']),
        language: document.documentElement?.getAttribute('lang') || undefined,
        keywords: getMeta(['keywords'])
            ?.split(',')
            .map((k) => k.trim()),
        ogTitle: getMeta(['og:title']),
        ogDescription: getMeta(['og:description']),
        ogImage: getMeta(['og:image']),
        ogType: getMeta(['og:type']),
        twitterCard: getMeta(['twitter:card']),
        twitterTitle: getMeta(['twitter:title']),
        twitterDescription: getMeta(['twitter:description']),
        twitterImage: getMeta(['twitter:image']),
        canonicalUrl:
            document.querySelector('link[rel="canonical"]')?.getAttribute('href') || undefined,
        favicon: favicon ? this.resolveUrl(favicon, baseUrl) : undefined
    };
}
```

:::info
The `getMeta()` helper checks both `name` and `property` attributes, which handles the inconsistency between standard meta tags (`name="description"`) and Open Graph tags (`property="og:description"`).
:::

## Settings Schema Patterns

### API key with environment variable fallback

```typescript
readonly settingsSchema: JsonSchema = {
    type: 'object',
    properties: {
        apiKey: {
            type: 'string',
            title: 'API Key',
            description: 'Your service API key',
            'x-secret': true,
            'x-envVar': 'PLUGIN_MY_EXTRACTOR_API_KEY',
            'x-scope': 'user'
        }
    },
    required: ['apiKey']
};
```

### Hidden system settings

Settings that users should not modify directly can be hidden from the UI:

```typescript
timeout: {
    type: 'number',
    title: 'Request Timeout',
    default: 15000,
    'x-hidden': true
}
```

### Settings resolution

Settings are resolved at call time through a 4-level hierarchy: **Work > User > Admin > Environment variable**. Always read settings from `options.settings`, never from cached instance state:

```typescript
async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> {
    // Correct: read from options.settings
    const apiKey = options.settings?.apiKey as string;
    const timeout = (options.settings?.timeout as number) || 15000;

    // Wrong: do NOT cache settings on the instance
    // this.apiKey = options.settings?.apiKey; // Never do this
}
```

## Writing Tests

Content extractor plugins use **Vitest**. Place tests in `src/__tests__/`. Here is a complete test file covering the essential behaviors:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MyExtractorPlugin } from '../my-extractor.plugin.js';
import type { PluginContext } from '@ever-works/plugin';

describe('MyExtractorPlugin', () => {
	let plugin: MyExtractorPlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new MyExtractorPlugin();
		mockContext = {
			logger: {
				log: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn()
			},
			events: {
				emit: vi.fn(),
				on: vi.fn(),
				off: vi.fn()
			},
			settings: {}
		} as unknown as PluginContext;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// ── Plugin Metadata ──────────────────────────────────────

	describe('Plugin Metadata', () => {
		it('should have correct plugin id', () => {
			expect(plugin.id).toBe('my-extractor');
		});

		it('should have content-extractor category', () => {
			expect(plugin.category).toBe('content-extractor');
		});

		it('should declare content-extractor capability', () => {
			expect(plugin.capabilities).toContain('content-extractor');
		});

		it('should have a provider name', () => {
			expect(plugin.providerName).toBeDefined();
			expect(typeof plugin.providerName).toBe('string');
		});

		it('should have a valid settings schema', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');
		});
	});

	// ── canExtract ───────────────────────────────────────────

	describe('canExtract', () => {
		it('should return true for valid HTTP URLs', async () => {
			expect(await plugin.canExtract('https://example.com')).toBe(true);
			expect(await plugin.canExtract('http://example.com/page')).toBe(true);
		});

		it('should return false for invalid URLs', async () => {
			expect(await plugin.canExtract('not-a-url')).toBe(false);
			expect(await plugin.canExtract('')).toBe(false);
		});

		it('should return false for non-HTTP protocols', async () => {
			expect(await plugin.canExtract('ftp://example.com')).toBe(false);
			expect(await plugin.canExtract('file:///local')).toBe(false);
		});
	});

	// ── Lifecycle ────────────────────────────────────────────

	describe('Lifecycle', () => {
		it('should log on load', async () => {
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalled();
		});

		it('should clean up on unload', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onUnload();
			// Verify internal state is cleaned up
		});
	});

	// ── healthCheck ──────────────────────────────────────────

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const result = await plugin.healthCheck();
			expect(result.status).toBe('healthy');
			expect(result.checkedAt).toBeDefined();
		});
	});

	// ── getManifest ──────────────────────────────────────────

	describe('getManifest', () => {
		it('should return manifest with matching id', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe(plugin.id);
		});

		it('should include content-extractor capability', () => {
			const manifest = plugin.getManifest();
			expect(manifest.capabilities).toContain('content-extractor');
		});

		it('should include an icon', () => {
			const manifest = plugin.getManifest();
			expect(manifest.icon).toBeDefined();
		});
	});

	// ── isAvailable ──────────────────────────────────────────

	describe('isAvailable', () => {
		it('should return true when no external deps are needed', async () => {
			expect(await plugin.isAvailable()).toBe(true);
		});
	});

	// ── getSupportedFormats ──────────────────────────────────

	describe('getSupportedFormats', () => {
		it('should return at least one format', () => {
			const formats = plugin.getSupportedFormats();
			expect(formats.length).toBeGreaterThan(0);
		});

		it('should only contain valid format strings', () => {
			const validFormats = ['text', 'html', 'markdown'];
			for (const format of plugin.getSupportedFormats()) {
				expect(validFormats).toContain(format);
			}
		});
	});

	// ── extract ──────────────────────────────────────────────

	describe('extract', () => {
		it('should return a result with success boolean', async () => {
			// Mock the HTTP call for unit tests
			vi.spyOn(plugin as any, 'extractTextFromHtml').mockReturnValue('Test content');

			const result = await plugin.extract({
				url: 'https://example.com'
			});

			expect(typeof result.success).toBe('boolean');
			expect(result.url).toBe('https://example.com');
			expect(result.duration).toBeDefined();
		});

		it('should include word count and reading time on success', async () => {
			// Provide a mock successful extraction
			vi.spyOn(plugin as any, 'extractTextFromHtml').mockReturnValue('This is test content with several words');

			const result = await plugin.extract({
				url: 'https://example.com'
			});

			if (result.success) {
				expect(result.wordCount).toBeDefined();
				expect(result.readingTime).toBeDefined();
			}
		});
	});
});
```

### Test for additive extractors

For additive (URL-specific) extractors, also test the URL filtering:

```typescript
describe('canExtract (additive)', () => {
	it('should return true for matching domain URLs', async () => {
		expect(await plugin.canExtract('https://docs.example.com/page-123')).toBe(true);
		expect(await plugin.canExtract('https://www.docs.example.com/guide')).toBe(true);
	});

	it('should return false for non-matching URLs', async () => {
		expect(await plugin.canExtract('https://example.com')).toBe(false);
		expect(await plugin.canExtract('https://github.com/docs')).toBe(false);
		expect(await plugin.canExtract('https://notdocs.example.com')).toBe(false);
	});

	it('should return false for invalid URLs', async () => {
		expect(await plugin.canExtract('not-a-url')).toBe(false);
		expect(await plugin.canExtract('')).toBe(false);
	});
});
```

Run tests:

```bash
# Run your plugin's tests
cd packages/plugins/my-extractor && pnpm test

# Run in watch mode during development
cd packages/plugins/my-extractor && pnpm test:watch

# Run with coverage
cd packages/plugins/my-extractor && pnpm test:coverage

# Run a single test file
cd packages/plugins/my-extractor && npx vitest run src/__tests__/my-extractor.plugin.spec.ts
```

## Build and Registration

### Build your plugin

```bash
# Install dependencies (from monorepo root)
pnpm install

# Build your plugin
pnpm build --filter=@ever-works/my-extractor-plugin

# Or build all plugins at once
pnpm build:plugins

# Type-check
pnpm type-check --filter=@ever-works/my-extractor-plugin
```

### Auto-discovery

Plugins placed in `packages/plugins/` with a valid `everworks.plugin` entry in `package.json` are **automatically discovered** when the API starts. No manual registration is needed.

```bash
# Start the API -- your plugin is auto-discovered
pnpm dev:api
```

### How the facade resolves extractors

The `IContentExtractorFacade` resolves which extractor handles a URL in this order:

1. **Explicit provider override** -- if the caller specifies `providerOverride`, that extractor is used
2. **Additive extractors** -- each enabled non-system extractor is asked `canExtract(url)`. The first to return `true` handles the request
3. **System/default extractor** -- `local-content-extractor` (or another system plugin) handles everything else

```typescript
// Pipeline step usage (for reference):
// Uses default resolution (prefers non-system extractors)
const content = await extractor.extractContent('https://example.com', undefined, facadeOptions);

// Force a specific extractor
const content = await extractor.extractContent(
	'https://example.com',
	{
		providerOverride: 'my-extractor'
	},
	facadeOptions
);
```

## Checklist

Before submitting your content extractor plugin, verify the following:

- [ ] **`id`** in the plugin class matches `everworks.plugin.id` in `package.json`
- [ ] **`category`** is `"content-extractor"` and **`capabilities`** includes `"content-extractor"`
- [ ] Both **named and default exports** in `src/index.ts`
- [ ] **`.js` extensions** in all import paths (required for ESM)
- [ ] `extract()` always returns a `ContentExtractionResult` with `success`, `url`, and `duration`
- [ ] `extract()` never throws -- errors are returned as `{ success: false, error: "..." }`
- [ ] `canExtract()` returns `true` only for URLs your plugin actually handles
- [ ] `canExtract()` returns `false` for invalid URLs without throwing
- [ ] `isAvailable()` checks whether the plugin can operate (e.g., API key present)
- [ ] Settings are read from `options.settings`, not cached on the instance
- [ ] **`x-secret: true`** is set on all sensitive fields (API keys, tokens)
- [ ] **`x-envVar`** is set for environment variable fallbacks where applicable
- [ ] `getManifest()` returns complete metadata including `icon` and `description`
- [ ] `healthCheck()` returns a meaningful status
- [ ] `extractBatch()` implements throttling (batch parallelism or sequential delay)
- [ ] Error messages include enough context to diagnose failures
- [ ] For additive extractors: `systemPlugin` is `false` and `supplementary` is `true` in the manifest
- [ ] For additive extractors: `extract()` guards against non-matching URLs
- [ ] Tests cover metadata, `canExtract()`, lifecycle, `healthCheck()`, and `getManifest()`
- [ ] Plugin builds: `pnpm build --filter=@ever-works/my-extractor-plugin`
- [ ] Plugin passes type checking: `pnpm type-check --filter=@ever-works/my-extractor-plugin`
- [ ] Tests pass: `cd packages/plugins/my-extractor && pnpm test`
