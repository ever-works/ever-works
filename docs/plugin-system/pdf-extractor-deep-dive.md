---
id: pdf-extractor-deep-dive
title: PDF Extractor Plugin Deep Dive
sidebar_label: PDF Extractor
sidebar_position: 64
---

# PDF Extractor Plugin Deep Dive

## Overview

The PDF Extractor plugin (`@ever-works/plugins/pdf-extractor`) is a content extraction plugin that extracts text content from PDF files. It uses a hybrid approach: first attempting text-layer extraction via the `unpdf` library, then falling back to OCR via the Mistral AI API when the text layer is insufficient.

This plugin is marked as `supplementary: true`, meaning it extends the content extraction capabilities of the platform rather than serving as a primary content source. It integrates with the `ContentExtractorFacade` to handle PDF URLs encountered during directory generation.

- **Plugin ID**: `pdf-extractor`
- **Category**: `content-extraction`
- **Capabilities**: `content-extraction`
- **Configuration Mode**: `hybrid`
- **Source**: `packages/plugins/pdf-extractor/src/`

## Architecture

### Extraction Strategy

The plugin follows a two-tier extraction approach:

```
URL with .pdf extension
  │
  ├─ 1. Text-Layer Extraction (unpdf)
  │     ├─ Parse PDF binary
  │     ├─ Extract text from all pages
  │     ├─ Calculate text density
  │     └─ If density >= threshold → Return text content
  │
  └─ 2. OCR Fallback (Mistral AI)
        ├─ Only if text density < threshold
        ├─ Only if Mistral API key is configured
        ├─ Send PDF to Mistral OCR API
        └─ Return markdown content from OCR
```

### Text Density Calculation

The `calculateTextDensity()` method determines whether the text-layer extraction produced meaningful content:

```
textDensity = meaningfulCharacters / numberOfPages
```

Where "meaningful characters" are non-whitespace characters in the extracted text. If the density falls below the `textDensityThreshold` setting (default: 100 chars/page), the plugin considers the text layer insufficient and falls back to OCR.

### Component Structure

- **`PdfExtractorPlugin`** - Main plugin class implementing `IPlugin` and `IContentExtractorPlugin`
- **`PdfTextExtractor`** - Handles text-layer extraction using `unpdf` library
- **`MistralOcrService`** - Handles OCR extraction using Mistral AI's OCR API

## Configuration

### Settings Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mistralApiKey` | `string` | - | Mistral AI API key for OCR fallback (`x-secret`, `x-envVar: PLUGIN_PDF_EXTRACTOR_MISTRAL_API_KEY`) |
| `ocrModel` | `string` | `'mistral-ocr-latest'` | Mistral OCR model name |
| `textDensityThreshold` | `number` | `100` | Minimum chars/page for text extraction to be considered sufficient |
| `maxPages` | `number` | `50` | Maximum pages to process |
| `timeout` | `number` | `60000` | Request timeout in milliseconds |

### Environment Variables

| Variable | Maps To |
|----------|---------|
| `PLUGIN_PDF_EXTRACTOR_MISTRAL_API_KEY` | `mistralApiKey` |

## Capabilities

### Content Extraction Interface

The plugin implements `IContentExtractorPlugin` with two key methods:

- **`canExtract(url)`** - Returns `true` if the URL ends with `.pdf` (case-insensitive)
- **`extract(url, options)`** - Extracts text content from the PDF at the given URL

### Supported Content

- PDF files accessible via HTTP/HTTPS URLs
- Text-layer PDFs (native digital documents)
- Image-based PDFs (scanned documents) via OCR fallback
- Multi-page documents up to `maxPages` limit

## API Reference

### Plugin Class

```typescript
class PdfExtractorPlugin implements IPlugin, IContentExtractorPlugin {
    readonly id = 'pdf-extractor';
    readonly name = 'PDF Extractor';
    readonly version = '1.0.0';
    readonly category: PluginCategory = 'content-extraction';
    readonly capabilities = ['content-extraction'];

    canExtract(url: string): boolean;

    async extract(
        url: string,
        options?: ContentExtractionOptions
    ): Promise<ContentExtractionResult>;

    async onLoad(context: PluginContext): Promise<void>;
    async onUnload(): Promise<void>;
    async healthCheck(): Promise<PluginHealthCheck>;
    getManifest(): PluginManifest;
}
```

### PdfTextExtractor

```typescript
class PdfTextExtractor {
    async extractText(
        pdfBuffer: Buffer
    ): Promise<PdfTextResult>;
}

interface PdfTextResult {
    text: string;
    numPages: number;
    metadata?: Record<string, unknown>;
}
```

### MistralOcrService

```typescript
class MistralOcrService {
    constructor(apiKey: string, model?: string);

    async extractFromUrl(
        url: string,
        maxPages?: number
    ): Promise<string>;
}
```

### Types

```typescript
interface MistralOcrRequest {
    model: string;
    document: {
        type: 'document_url';
        document_url: string;
    };
}

interface MistralOcrPage {
    index: number;
    markdown: string;
    images: unknown[];
    dimensions: { width: number; height: number };
}

interface MistralOcrResponse {
    pages: MistralOcrPage[];
}
```

## Implementation Details

### Text-Layer Extraction (`PdfTextExtractor`)

Uses the `unpdf` library which provides:

- `getDocumentProxy()` - Parses PDF binary into a document object
- `extractText()` - Extracts text content from all pages
- `getMeta()` - Retrieves PDF metadata (title, author, etc.)

The extracted text is returned along with page count and metadata.

### OCR Extraction (`MistralOcrService`)

Calls the Mistral AI OCR API at `https://api.mistral.ai/v1/ocr`:

1. Sends the PDF URL directly (no download needed)
2. Receives per-page markdown content with OCR results
3. Combines pages using `---` (horizontal rule) separators
4. Returns concatenated markdown string

The service handles specific HTTP error codes:

| Status | Handling |
|--------|----------|
| 401 | Throws "Invalid Mistral API key" |
| 400 | Throws "Bad request" with detail message |
| 429 | Throws "Rate limit exceeded" |
| Other | Throws generic error with status code |

### Extraction Flow

```typescript
async extract(url: string, options?: ContentExtractionOptions) {
    // 1. Fetch PDF binary
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    const buffer = Buffer.from(await response.arrayBuffer());

    // 2. Try text-layer extraction
    const textResult = await this.textExtractor.extractText(buffer);

    // 3. Check text density
    const density = this.calculateTextDensity(textResult);

    if (density >= settings.textDensityThreshold) {
        return { rawContent: textResult.text, metadata: textResult.metadata };
    }

    // 4. Fall back to OCR if available
    if (settings.mistralApiKey) {
        const ocrService = new MistralOcrService(settings.mistralApiKey, settings.ocrModel);
        const ocrText = await ocrService.extractFromUrl(url, settings.maxPages);
        return { rawContent: ocrText };
    }

    // 5. Return whatever text was extracted
    return { rawContent: textResult.text, metadata: textResult.metadata };
}
```

## Usage Examples

### Automatic Content Extraction

The PDF Extractor is typically invoked automatically by the `ContentExtractorFacade` when a PDF URL is encountered during directory generation:

```typescript
// ContentExtractorFacade routes to PDF Extractor when URL ends in .pdf
const result = await contentExtractorFacade.extractContent(
    'https://example.com/whitepaper.pdf',
    undefined,
    facadeOptions
);
// result.rawContent contains the extracted text
```

### Direct Usage

```typescript
const plugin = new PdfExtractorPlugin();
await plugin.onLoad(context);

if (plugin.canExtract('https://example.com/report.pdf')) {
    const result = await plugin.extract('https://example.com/report.pdf');
    console.log(result.rawContent); // Extracted text content
}
```

## Error Handling

### Extraction Errors

| Error | Cause | Handling |
|-------|-------|----------|
| Fetch timeout | PDF download exceeds `timeout` | `AbortSignal.timeout` triggers, error propagated |
| Invalid PDF | Corrupted or non-PDF binary | `unpdf` parse error, logged and propagated |
| Empty text layer | PDF has no text (image-only) | Falls back to OCR if configured |
| OCR API failure | Mistral API error | Specific error messages for 401/400/429, falls back to text layer |
| OCR rate limit | Too many requests | Error propagated, text layer used as fallback |
| Max pages exceeded | PDF has more pages than limit | Only first `maxPages` pages processed |
| Buffer too large | Very large PDF | May cause memory issues, mitigated by `maxPages` |

### Graceful Degradation

The plugin degrades gracefully through multiple fallback layers:

1. **Best case**: Text-layer extraction succeeds with sufficient density
2. **Fallback 1**: Text density low, OCR available - use OCR
3. **Fallback 2**: Text density low, no OCR configured - return sparse text
4. **Fallback 3**: Text extraction fails entirely - error propagated to caller

### Health Check

The `healthCheck()` returns healthy status regardless of Mistral API key configuration, since text-layer extraction works without any external API. The manifest notes that OCR is optional.

## Related Plugins

- **[Local Content Extractor](./content-extraction-plugins.md)** - Primary content extraction plugin for web pages
- **[Notion Extractor](./content-extraction-plugins.md)** - Content extraction for Notion pages
- **[Standard Pipeline](./standard-pipeline-deep-dive.md)** - Uses ContentExtractorFacade which routes to this plugin for PDF URLs
- **[Agent Pipeline](./agent-pipeline-deep-dive.md)** - Uses ContentExtractorFacade via `processUrls` tool
- **[Mistral AI Provider](./mistral-plugin-deep-dive.md)** - Same Mistral API used for OCR fallback
