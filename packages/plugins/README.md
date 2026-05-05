# Ever Works Plugins

First-party plugins that ship with the Ever Works platform. Each plugin lives in its own ESM package, builds with [`tsup`](https://tsup.egoist.dev), tests with [`vitest`](https://vitest.dev), and declares its capabilities, settings schema, and metadata via the [`@ever-works/plugin`](../plugin/README.md) contracts.

## What is a plugin?

A plugin is a self-contained TypeScript package that:

- Declares metadata in its `package.json` under `everworks.plugin` (id, name, category, capabilities)
- Implements one or more capability interfaces from `@ever-works/plugin/contracts` (e.g. `IAiProviderPlugin`, `ISearchPlugin`, `IPipelinePlugin`)
- Defines a settings schema using JSON Schema with custom Ever Works extensions (`x-widget`, `x-secret`, `x-envVar`, `x-scope`)
- Returns a `PluginManifest` from `getManifest()` that describes the plugin to the platform UI

See [`packages/plugin/README.md`](../plugin/README.md) for the full contract.

## Plugins by category

### AI providers (`ai-provider`)

LLM backends used for content generation, chat, and embeddings.

| Plugin                                            | Description                                            |
| ------------------------------------------------- | ------------------------------------------------------ |
| [anthropic](anthropic/README.md)                  | Anthropic Claude — Haiku, Sonnet, Opus                 |
| [openai](openai/README.md)                        | OpenAI GPT models + embeddings                         |
| [google](google/README.md)                        | Google Gemini API                                      |
| [groq](groq/README.md)                            | Groq's fast LPU inference                              |
| [ollama](ollama/README.md)                        | Local Ollama instance for self-hosted models           |
| [mistral](mistral/README.md)                      | Mistral AI hosted models                               |

### AI gateways (`ai-gateway`)

Multi-provider routers that fan out to many AI providers behind one API.

| Plugin                                                  | Description                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| [openrouter](openrouter/README.md)                      | OpenRouter — default AI gateway                             |
| [vercel-ai-gateway](vercel-ai-gateway/README.md)        | Vercel AI Gateway                                           |

### Search (`search`)

Web search providers used by pipelines for grounded research.

| Plugin                                          | Description                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [tavily](tavily/README.md)                      | Tavily — default search + content extractor                                                  |
| [brave](brave/README.md)                        | Brave Search API                                                                             |
| [exa](exa/README.md)                            | Exa neural / keyword search                                                                  |
| [serpapi](serpapi/README.md)                    | SerpAPI (Google, Bing, Yahoo, DuckDuckGo, Baidu, Yandex)                                     |
| [perplexity](perplexity/README.md)              | Perplexity Sonar search                                                                      |
| [brightdata](brightdata/README.md)              | Bright Data SERP + Web Scraper                                                               |
| [firecrawl](firecrawl/README.md)                | Firecrawl — search + clean markdown                                                          |
| [valyu](valyu/README.md)                        | Valyu AI-native multi-source search                                                          |
| [linkup](linkup/README.md)                      | Linkup grounding search                                                                      |

### Content extractors (`content-extractor`)

Turn URLs and documents into structured text for downstream generation.

| Plugin                                                              | Description                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| [local-content-extractor](local-content-extractor/README.md)        | Default in-process extractor — no API key required         |
| [notion-extractor](notion-extractor/README.md)                      | Pull pages and databases from Notion                       |
| [pdf-extractor](pdf-extractor/README.md)                            | OCR + text extraction for PDFs (Mistral OCR)               |
| [scrapfly](scrapfly/README.md)                                      | Scrapfly — content extraction + screenshot                 |
| [jina](jina/README.md)                                              | Jina AI Reader (`r.jina.ai`)                               |

### Screenshots (`screenshot`)

Capture page screenshots for items and previews.

| Plugin                                          | Description                                  |
| ----------------------------------------------- | -------------------------------------------- |
| [screenshotone](screenshotone/README.md)        | ScreenshotOne                                |
| [urlbox](urlbox/README.md)                      | Urlbox                                       |
| [scrapfly](scrapfly/README.md)                  | Scrapfly (also a content-extractor)          |

### Git providers (`git-provider`)

Manage repositories, branches, and pull requests.

| Plugin                                | Description                                                          |
| ------------------------------------- | -------------------------------------------------------------------- |
| [github](github/README.md)            | GitHub — repos, PRs, branches + OAuth login (default git provider)   |

### Deployment (`deployment`)

Publish a generated work as a live website.

| Plugin                                | Description                                  |
| ------------------------------------- | -------------------------------------------- |
| [vercel](vercel/README.md)            | Vercel hosting (default deployment provider) |

### Data sources (`data-source`)

Pull existing item data from external systems instead of generating from scratch.

| Plugin                              | Description                              |
| ----------------------------------- | ---------------------------------------- |
| [apify](apify/README.md)            | Apify dataset / actor results            |

### Pipelines (`pipeline`)

End-to-end work generation engines. One pipeline plugin is active per work.

| Plugin                                                              | Description                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [standard-pipeline](standard-pipeline/README.md)                    | Default 15-step / 6-phase research + generation pipeline               |
| [agent-pipeline](agent-pipeline/README.md)                          | Autonomous agent pipeline using the Vercel AI SDK                      |
| [hermes-agent](hermes-agent/README.md)                              | Use a self-hosted Hermes Agent install                                 |
| [claude-code](claude-code/README.md)                                | Run the full pipeline through the Claude Code CLI                      |
| [claude-managed-agent](claude-managed-agent/README.md)              | Anthropic Managed Agents (beta)                                        |
| [codex](codex/README.md)                                            | Run the full pipeline through the OpenAI Codex CLI                     |
| [gemini](gemini/README.md)                                          | Run the full pipeline through the Gemini CLI (≠ `google` AI provider)  |
| [opencode](opencode/README.md)                                      | Run the full pipeline through the opencode CLI                         |
| [activepieces](activepieces/README.md)                              | Delegate generation to an Activepieces flow                            |
| [make](make/README.md)                                              | Delegate generation to a Make.com scenario                             |
| [sim-ai](sim-ai/README.md)                                          | Delegate generation to a Sim AI workflow                               |
| [zapier](zapier/README.md)                                          | Delegate generation to a Zapier action                                 |

### Prompt providers (`prompt-provider`)

Externalise prompt templates so they can be edited and versioned outside the codebase.

| Plugin                                  | Description                                                              |
| --------------------------------------- | ------------------------------------------------------------------------ |
| [langfuse](langfuse/README.md)          | Langfuse prompt management with versioning, labels, and observability    |

### Utilities

Helpers and modifiers that don't fit into a single capability bucket.

| Plugin                                                          | Description                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| [comparison-generator](comparison-generator/README.md)          | Generate side-by-side A-vs-B comparison content for items  |

## Building & testing a plugin

From the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/<plugin-package-name> build
pnpm --filter @ever-works/<plugin-package-name> test
```

The full plugin set can be built with:

```bash
pnpm build:plugins
```

## Authoring a new plugin

1. Read [`@ever-works/plugin`](../plugin/README.md) for the contracts.
2. Copy an existing plugin in the matching category as a starting point (e.g. copy `tavily` for a search plugin, `anthropic` for an AI provider).
3. Update `package.json` (`name`, `everworks.plugin.id`, `category`, `capabilities`).
4. Implement `getManifest()` with a meaningful `readme:` field — that text is rendered inside the platform UI.
5. Add a `README.md` that follows the same shape as the others in this directory.

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Repository](https://github.com/ever-works/ever-works)
- [Plugin system contracts](../plugin/README.md)
