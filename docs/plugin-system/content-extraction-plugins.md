---
id: content-extraction-plugins
title: Content Extraction Plugins
sidebar_label: Content Extraction
sidebar_position: 10
---

# Content Extraction Plugins

Content extraction plugins retrieve and clean web page content for use during work generation. They implement the `IContentExtractorPlugin` interface and transform raw HTML into structured text, markdown, images, links, and metadata.

## IContentExtractorPlugin Interface

```typescript
interface IContentExtractorPlugin extends IPlugin {
	readonly providerName: string;

	extract(options: ContentExtractionOptions): Promise<ContentExtractionResult>;
	isAvailable(): Promise<boolean>;

	// Optional
	extractBatch?(urls: string[], options?: Partial<ContentExtractionOptions>): Promise<ContentExtractionResult[]>;
	canExtract?(url: string): Promise<boolean>;
	getSupportedFormats?(): readonly ('text' | 'html' | 'markdown')[];
}
```

## Extraction Options

```typescript
interface ContentExtractionOptions {
	url: string; // URL to extract from
	includeImages?: boolean; // Extract image references
	includeLinks?: boolean; // Extract link references
	includeMetadata?: boolean; // Extract page metadata (OG, Twitter cards)
	maxLength?: number; // Maximum content length
	timeout?: number; // Timeout in ms
	waitForJs?: boolean; // Wait for JavaScript rendering
	waitForSelector?: string; // Wait for a specific DOM selector
	headers?: Record<string, string>;
	userAgent?: string;
	selectors?: string[]; // Extract specific CSS selectors
	removeSelectors?: string[]; // Remove specific elements before extraction
	settings?: PluginSettings; // Resolved plugin settings
}
```

## Extraction Result

```typescript
interface ContentExtractionResult {
	success: boolean;
	url: string;
	finalUrl?: string; // URL after redirects
	title?: string;
	content?: string; // Plain text
	html?: string; // Raw HTML
	markdown?: string; // Markdown conversion
	images?: ExtractedImage[];
	links?: ExtractedLink[];
	metadata?: PageMetadata; // Title, description, OG tags, Twitter cards
	error?: string;
	duration?: number; // Extraction time in ms
	wordCount?: number;
	readingTime?: number; // Estimated minutes
}
```

## Available Plugins

### Local Content Extractor

| Property             | Value                                                   |
| -------------------- | ------------------------------------------------------- |
| Package              | `@ever-works/local-content-extractor-plugin`            |
| Dependencies         | `@mozilla/readability`, `axios`, `linkedom`, `turndown` |
| API Key Required     | No                                                      |
| JavaScript Rendering | No                                                      |
| Output Formats       | text, markdown                                          |

The local content extractor is a **system plugin** that requires no external API. It fetches pages with `axios`, parses HTML with `linkedom`, extracts readable content using Mozilla's Readability algorithm, and converts to markdown with Turndown.

**When to use:** Default extraction for most web pages. No API key required, no rate limits. Works well for article-style content, blog posts, and documentation pages.

**Limitations:** Cannot render JavaScript-heavy single-page applications. Does not handle pages behind authentication or CAPTCHAs.

**Settings:**

| Setting         | Type | Default | Description          |
| --------------- | ---- | ------- | -------------------- |
| (none required) | --   | --      | Works out of the box |

### Jina

| Property             | Value                         |
| -------------------- | ----------------------------- |
| Package              | `@ever-works/jina-plugin`     |
| Capabilities         | `search`, `content-extractor` |
| API Key Required     | Yes                           |
| JavaScript Rendering | Yes                           |
| Output Formats       | text, markdown                |

Jina AI provides both web search and content extraction through its Reader API. It renders JavaScript and returns clean content from any URL.

**When to use:** Pages that require JavaScript rendering, complex layouts, or when you need high-quality markdown output.

**Settings:**

| Setting  | Type            | Default | Description  |
| -------- | --------------- | ------- | ------------ |
| `apiKey` | string (secret) | --      | Jina API key |

### Firecrawl

| Property             | Value                          |
| -------------------- | ------------------------------ |
| Package              | `@ever-works/firecrawl-plugin` |
| Capabilities         | `search`, `content-extractor`  |
| SDK                  | `@mendable/firecrawl-js`       |
| API Key Required     | Yes                            |
| JavaScript Rendering | Yes                            |
| Output Formats       | text, html, markdown           |

Firecrawl provides advanced web scraping with JavaScript rendering, content extraction, and search capabilities. It handles dynamic pages, anti-bot challenges, and returns structured content.

**When to use:** Complex web pages, sites with anti-scraping protections, when you need both search and extraction from one provider.

**Settings:**

| Setting  | Type            | Default | Description       |
| -------- | --------------- | ------- | ----------------- |
| `apiKey` | string (secret) | --      | Firecrawl API key |

### Notion Extractor

| Property         | Value                                 |
| ---------------- | ------------------------------------- |
| Package          | `@ever-works/notion-extractor-plugin` |
| SDK              | `@notionhq/client`                    |
| API Key Required | Yes (Notion integration token)        |
| Supplementary    | Yes                                   |

The Notion extractor is a **supplementary plugin** -- it does not appear in the content extractor dropdown. Instead, it auto-activates when the platform encounters a `notion.so` URL through the `canExtract()` method.

It supports two extraction strategies:

1. **Notion API** -- uses an official integration token for authenticated access to private pages
2. **Splitbee** -- uses the public Notion API proxy for publicly shared pages

**When to use:** Automatically activated for Notion URLs. Configure with a Notion integration token for private page access.

**Settings:**

| Setting       | Type            | Default    | Description                              |
| ------------- | --------------- | ---------- | ---------------------------------------- |
| `notionToken` | string (secret) | --         | Notion integration token                 |
| `strategy`    | enum            | `splitbee` | Extraction strategy: `api` or `splitbee` |

### PDF Extractor

| Property         | Value                               |
| ---------------- | ----------------------------------- |
| Package          | `@ever-works/pdf-extractor-plugin`  |
| Dependencies     | `unpdf`, `axios`                    |
| API Key Required | Optional (Mistral for OCR fallback) |
| Supplementary    | Yes                                 |

The PDF extractor is another **supplementary plugin** that auto-activates for `.pdf` URLs. It downloads PDF files and extracts text content using the `unpdf` library. For scanned PDFs or image-based content, it falls back to OCR via Mistral AI's vision capabilities.

**When to use:** Automatically activated for PDF URLs. Handles both text-based and scanned PDFs.

**Settings:**

| Setting         | Type            | Default | Description                               |
| --------------- | --------------- | ------- | ----------------------------------------- |
| `mistralApiKey` | string (secret) | --      | Optional Mistral API key for OCR fallback |

## Plugin Comparison

| Feature                 | Local |    Jina     |  Firecrawl  |  Notion   |   PDF    |
| ----------------------- | :---: | :---------: | :---------: | :-------: | :------: |
| API key required        |  No   |     Yes     |     Yes     |    Yes    | Optional |
| JavaScript rendering    |  No   |     Yes     |     Yes     |    N/A    |   N/A    |
| Batch extraction        |  No   |     Yes     |     Yes     |    No     |    No    |
| Auto-activates for URLs |  No   |     No      |     No      | notion.so |   .pdf   |
| Anti-bot handling       |  No   |     Yes     |     Yes     |    N/A    |   N/A    |
| Output: text            |  Yes  |     Yes     |     Yes     |    Yes    |   Yes    |
| Output: markdown        |  Yes  |     Yes     |     Yes     |    Yes    |    No    |
| Output: HTML            |  No   |     No      |     Yes     |    No     |    No    |
| Rate limiting           | None  |  API-based  |  API-based  | API-based |   None   |
| Cost                    | Free  | Pay per use | Pay per use |   Free    | Free/Pay |

## URL-Based Auto-Routing

The content extraction facade uses the `canExtract()` method to automatically route URLs to the appropriate plugin:

1. Check supplementary plugins first (Notion for `notion.so`, PDF for `.pdf`)
2. If no supplementary plugin matches, use the user-selected content extractor
3. Fall back to the local content extractor if nothing else is configured

This means the Notion and PDF extractors work transparently -- when a work item has a Notion page or PDF as its source URL, the correct extractor is used automatically without user intervention.

## Metadata Extraction

All content extractors can optionally return rich page metadata:

```typescript
interface PageMetadata {
	title?: string;
	description?: string;
	author?: string;
	publishedDate?: string;
	modifiedDate?: string;
	language?: string;
	keywords?: string[];
	ogTitle?: string;
	ogDescription?: string;
	ogImage?: string;
	ogType?: string;
	twitterCard?: string;
	twitterTitle?: string;
	twitterDescription?: string;
	twitterImage?: string;
	canonicalUrl?: string;
	favicon?: string;
}
```

This metadata enriches work items with SEO-relevant information, Open Graph data, and publication dates.
