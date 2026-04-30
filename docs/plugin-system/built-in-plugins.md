---
id: built-in-plugins
title: Built-in Plugins
sidebar_label: Built-in Plugins
sidebar_position: 5
---

# Built-in Plugins

The platform ships with 39 plugins across the AI provider, search, content extraction, screenshot, git, deployment, pipeline, data source, and utility categories. This page documents each plugin, its configuration, and environment variables.

## AI Providers

AI provider plugins implement `ai-provider` capability and power all content generation, chat, and structured output features.

### OpenAI

Use OpenAI models (GPT-5.1, GPT-5-nano, GPT-4o-mini) for content generation and AI features.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `openai`        |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default                     | Description                        |
| -------------- | ------ | --------------------------- | ---------------------------------- |
| `apiKey`       | string | —                           | OpenAI API key (required, secret)  |
| `defaultModel` | string | `gpt-5.1`                   | Default model for all tasks        |
| `simpleModel`  | string | `gpt-5-nano`                | Model for tags, short descriptions |
| `mediumModel`  | string | `gpt-4o-mini`               | Model for summaries, reformatting  |
| `complexModel` | string | `gpt-5.1`                   | Model for full page generation     |
| `temperature`  | number | `0.7`                       | Response variability (0–2)         |
| `maxTokens`    | number | `4096`                      | Max response length                |
| `baseUrl`      | string | `https://api.openai.com/v1` | API endpoint                       |

### Anthropic

Use Anthropic Claude models for content generation.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `anthropic`     |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default                         | Description                          |
| -------------- | ------ | ------------------------------- | ------------------------------------ |
| `apiKey`       | string | —                               | Anthropic API key (required, secret) |
| `defaultModel` | string | `claude-sonnet-4-5-20250514`    | Default model                        |
| `simpleModel`  | string | `claude-haiku-4-5-20251001`     | Simple tasks model                   |
| `mediumModel`  | string | `claude-sonnet-4-5-20250929`    | Standard tasks model                 |
| `complexModel` | string | `claude-sonnet-4-5-20250514`    | Complex tasks model                  |
| `temperature`  | number | `0.7`                           | Response variability                 |
| `maxTokens`    | number | `4096`                          | Max response length                  |
| `baseUrl`      | string | `https://api.anthropic.com/v1/` | API endpoint                         |

### Google Gemini

Use Google Gemini models for content generation.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `google`        |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default                                                    | Description                       |
| -------------- | ------ | ---------------------------------------------------------- | --------------------------------- |
| `apiKey`       | string | —                                                          | Google API key (required, secret) |
| `defaultModel` | string | `models/gemini-2.5-flash`                                  | Default model                     |
| `simpleModel`  | string | `models/gemini-2.0-flash`                                  | Simple tasks model                |
| `mediumModel`  | string | `models/gemini-2.5-flash`                                  | Standard tasks model              |
| `complexModel` | string | `models/gemini-2.5-pro`                                    | Complex tasks model               |
| `temperature`  | number | `0.7`                                                      | Response variability              |
| `maxTokens`    | number | `4096`                                                     | Max response length               |
| `baseUrl`      | string | `https://generativelanguage.googleapis.com/v1beta/openai/` | API endpoint                      |

### Groq

Use Groq for fast AI inference with open-source models.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `groq`          |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default                                     | Description                     |
| -------------- | ------ | ------------------------------------------- | ------------------------------- |
| `apiKey`       | string | —                                           | Groq API key (required, secret) |
| `defaultModel` | string | `meta-llama/llama-4-scout-17b-16e-instruct` | Default model                   |
| `baseUrl`      | string | `https://api.groq.com/openai/v1`            | API endpoint                    |

### Ollama

Use locally running models via Ollama. No API key required.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `ollama`        |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default  | Description                                              |
| -------------- | ------ | -------- | -------------------------------------------------------- |
| `baseUrl`      | string | —        | Ollama URL (required, e.g., `http://localhost:11434/v1`) |
| `defaultModel` | string | `llama2` | Default model                                            |
| `apiKey`       | string | `ollama` | API key (optional, defaults to `ollama`)                 |

### Mistral

Use Mistral AI models for content generation.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `mistral`       |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default                     | Description                        |
| -------------- | ------ | --------------------------- | ---------------------------------- |
| `apiKey`       | string | —                           | Mistral API key (required, secret) |
| `defaultModel` | string | `mistral-small-latest`      | Default model for all tasks        |
| `simpleModel`  | string | `mistral-small-latest`      | Model for tags, short descriptions |
| `mediumModel`  | string | `mistral-medium-latest`     | Model for summaries, reformatting  |
| `complexModel` | string | `mistral-large-latest`      | Model for full page generation     |
| `temperature`  | number | `0.7`                       | Response variability (0–2)         |
| `maxTokens`    | number | `4096`                      | Max response length                |
| `baseUrl`      | string | `https://api.mistral.ai/v1` | API endpoint                       |

## AI Gateways

AI gateway plugins route requests through multi-provider services, giving access to many models through a single API key.

### OpenRouter

Access 400+ models from multiple providers through OpenRouter.

| Field              | Value         |
| ------------------ | ------------- |
| Plugin ID          | `openrouter`  |
| Configuration Mode | `hybrid`      |
| Auto Enable        | Yes           |
| Default For        | `ai-provider` |
| System Plugin      | Yes           |

**Environment Variables:**

| Variable                          | Required | Description                                            |
| --------------------------------- | -------- | ------------------------------------------------------ |
| `PLUGIN_OPENROUTER_API_KEY`       | Yes      | OpenRouter API key                                     |
| `PLUGIN_OPENROUTER_DEFAULT_MODEL` | No       | Override default model                                 |
| `PLUGIN_OPENROUTER_SIMPLE_MODEL`  | No       | Override simple tasks model                            |
| `PLUGIN_OPENROUTER_MEDIUM_MODEL`  | No       | Override medium tasks model                            |
| `PLUGIN_OPENROUTER_COMPLEX_MODEL` | No       | Override complex tasks model                           |
| `PLUGIN_OPENROUTER_BASE_URL`      | No       | API endpoint (default: `https://openrouter.ai/api/v1`) |

**Settings:**

| Setting        | Type   | Default             | Description                 |
| -------------- | ------ | ------------------- | --------------------------- |
| `apiKey`       | string | —                   | OpenRouter API key (secret) |
| `defaultModel` | string | `openai/gpt-5.1`    | Default model               |
| `simpleModel`  | string | `openai/gpt-5-nano` | Simple tasks model          |
| `mediumModel`  | string | `openai/gpt-4o`     | Standard tasks model        |
| `complexModel` | string | `openai/gpt-5.1`    | Complex tasks model         |

### Vercel AI Gateway

Route AI requests through Vercel's AI Gateway.

| Field              | Value               |
| ------------------ | ------------------- |
| Plugin ID          | `vercel-ai-gateway` |
| Configuration Mode | `hybrid`            |
| Auto Enable        | No                  |

**Environment Variables:**

| Variable                            | Required | Description                                           |
| ----------------------------------- | -------- | ----------------------------------------------------- |
| `PLUGIN_VERCEL_AI_GATEWAY_API_KEY`  | Yes      | API key                                               |
| `PLUGIN_VERCEL_AI_GATEWAY_BASE_URL` | No       | Endpoint (default: `https://ai-gateway.vercel.sh/v1`) |

## Search

Search plugins power web research during the generation pipeline.

### Tavily

Web search and content extraction optimized for AI applications. This is the **default search provider**.

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Plugin ID          | `tavily`                      |
| Configuration Mode | `hybrid`                      |
| Auto Enable        | Yes                           |
| Default For        | `search`                      |
| System Plugin      | Yes                           |
| Capabilities       | `search`, `content-extractor` |

**Environment Variables:**

| Variable                | Required | Description                                          |
| ----------------------- | -------- | ---------------------------------------------------- |
| `PLUGIN_TAVILY_API_KEY` | No       | Tavily API key (can be set in user settings instead) |

**Settings:**

| Setting  | Type   | Default | Description                       |
| -------- | ------ | ------- | --------------------------------- |
| `apiKey` | string | —       | Tavily API key (required, secret) |

### Brave Search

Web search using the Brave Search API.

| Field              | Value    |
| ------------------ | -------- |
| Plugin ID          | `brave`  |
| Configuration Mode | `hybrid` |
| Auto Enable        | No       |

**Environment Variables:**

| Variable               | Required | Description          |
| ---------------------- | -------- | -------------------- |
| `PLUGIN_BRAVE_API_KEY` | No       | Brave Search API key |

**Settings:**

| Setting      | Type   | Default | Description                      |
| ------------ | ------ | ------- | -------------------------------- |
| `apiKey`     | string | —       | Brave API key (required, secret) |
| `maxResults` | number | `10`    | Results per search (1–20)        |

### SerpAPI

Web search using SerpAPI with support for multiple search engines.

| Field              | Value     |
| ------------------ | --------- |
| Plugin ID          | `serpapi` |
| Configuration Mode | `hybrid`  |
| Auto Enable        | No        |

**Environment Variables:**

| Variable                 | Required | Description |
| ------------------------ | -------- | ----------- |
| `PLUGIN_SERPAPI_API_KEY` | No       | SerpAPI key |

**Settings:**

| Setting      | Type   | Default  | Description                                                               |
| ------------ | ------ | -------- | ------------------------------------------------------------------------- |
| `apiKey`     | string | —        | SerpAPI key (required, secret)                                            |
| `engine`     | string | `google` | Search engine: `google`, `bing`, `yahoo`, `duckduckgo`, `baidu`, `yandex` |
| `maxResults` | number | `10`     | Results per search (1–100)                                                |

### Exa

AI-native search with neural and keyword modes.

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Plugin ID          | `exa`                         |
| Configuration Mode | `hybrid`                      |
| Auto Enable        | No                            |
| Capabilities       | `search`, `content-extractor` |

**Environment Variables:**

| Variable             | Required | Description |
| -------------------- | -------- | ----------- |
| `PLUGIN_EXA_API_KEY` | No       | Exa API key |

**Settings:**

| Setting      | Type   | Default | Description                                                                                 |
| ------------ | ------ | ------- | ------------------------------------------------------------------------------------------- |
| `apiKey`     | string | —       | Exa API key (required, secret)                                                              |
| `searchType` | string | `auto`  | Search type: `auto`, `neural`, `keyword`                                                    |
| `maxResults` | number | `10`    | Results per search (1–100)                                                                  |
| `category`   | string | —       | Filter by category: `company`, `research paper`, `news`, `tweet`, `personal site`, `github` |

### Perplexity

AI-powered web search with citations via the Perplexity API.

| Field              | Value        |
| ------------------ | ------------ |
| Plugin ID          | `perplexity` |
| Configuration Mode | `hybrid`     |
| Auto Enable        | No           |

**Environment Variables:**

| Variable                    | Required | Description        |
| --------------------------- | -------- | ------------------ |
| `PLUGIN_PERPLEXITY_API_KEY` | No       | Perplexity API key |

**Settings:**

| Setting  | Type   | Default | Description                           |
| -------- | ------ | ------- | ------------------------------------- |
| `apiKey` | string | —       | Perplexity API key (required, secret) |

### Bright Data

Web search and content extraction via the Bright Data SERP API and Web Scraper.

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Plugin ID          | `brightdata`                  |
| Configuration Mode | `hybrid`                      |
| Auto Enable        | No                            |
| Capabilities       | `search`, `content-extractor` |

**Environment Variables:**

| Variable                    | Required | Description         |
| --------------------------- | -------- | ------------------- |
| `PLUGIN_BRIGHTDATA_API_KEY` | No       | Bright Data API key |

**Settings:**

| Setting  | Type   | Default | Description                            |
| -------- | ------ | ------- | -------------------------------------- |
| `apiKey` | string | —       | Bright Data API key (required, secret) |

### Firecrawl

Web search and markdown content extraction via the Firecrawl API.

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Plugin ID          | `firecrawl`                   |
| Configuration Mode | `hybrid`                      |
| Auto Enable        | No                            |
| Capabilities       | `search`, `content-extractor` |

**Environment Variables:**

| Variable                   | Required | Description       |
| -------------------------- | -------- | ----------------- |
| `PLUGIN_FIRECRAWL_API_KEY` | No       | Firecrawl API key |

**Settings:**

| Setting  | Type   | Default | Description                          |
| -------- | ------ | ------- | ------------------------------------ |
| `apiKey` | string | —       | Firecrawl API key (required, secret) |

### Valyu

AI-native multi-source search and content extraction via the Valyu API.

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Plugin ID          | `valyu`                       |
| Configuration Mode | `hybrid`                      |
| Auto Enable        | No                            |
| Capabilities       | `search`, `content-extractor` |

**Environment Variables:**

| Variable               | Required | Description   |
| ---------------------- | -------- | ------------- |
| `PLUGIN_VALYU_API_KEY` | No       | Valyu API key |

**Settings:**

| Setting          | Type   | Default  | Description                                                  |
| ---------------- | ------ | -------- | ------------------------------------------------------------ |
| `apiKey`         | string | —        | Valyu API key (required, secret)                             |
| `responseLength` | string | `medium` | Content volume per result: `short`, `medium`, `large`, `max` |

### Linkup

Web search and content extraction via the Linkup API. Optimized for AI-precision results and clean content extraction from any URL.

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Plugin ID          | `linkup`                      |
| Configuration Mode | `hybrid`                      |
| Auto Enable        | No                            |
| Capabilities       | `search`, `content-extractor` |

See [Linkup Plugin](./linkup-plugin.md) for setup. Refer to `packages/plugins/linkup/src/` for the current settings schema.

## Git Provider

### GitHub

Repository management, cloning, pushing, pull requests, and OAuth authentication. This is the **default git provider** and is always enabled.

| Field              | Value                   |
| ------------------ | ----------------------- |
| Plugin ID          | `github`                |
| Configuration Mode | `admin-only`            |
| Auto Enable        | Yes                     |
| Default For        | `git-provider`          |
| System Plugin      | Yes                     |
| Capabilities       | `git-provider`, `oauth` |

**Environment Variables:**

| Variable                      | Required | Description                    |
| ----------------------------- | -------- | ------------------------------ |
| `PLUGIN_GITHUB_CLIENT_ID`     | No       | GitHub OAuth App client ID     |
| `PLUGIN_GITHUB_CLIENT_SECRET` | No       | GitHub OAuth App client secret |

**Settings:**

| Setting        | Type   | Default                  | Description                         |
| -------------- | ------ | ------------------------ | ----------------------------------- |
| `clientId`     | string | —                        | GitHub OAuth client ID              |
| `clientSecret` | string | —                        | GitHub OAuth client secret (secret) |
| `apiBaseUrl`   | string | `https://api.github.com` | GitHub API endpoint                 |

## Deployment

### Vercel

Deploy directory websites to Vercel. This is the **default deployment provider** and is always enabled.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `vercel`        |
| Configuration Mode | `user-required` |
| Auto Enable        | Yes             |
| Default For        | `deployment`    |
| System Plugin      | Yes             |

**Settings:**

| Setting            | Type   | Default | Description                          |
| ------------------ | ------ | ------- | ------------------------------------ |
| `apiToken`         | string | —       | Vercel API token (required, secret)  |
| `defaultTeamScope` | string | —       | Default Vercel team scope (optional) |

## Screenshot

Screenshot plugins capture website images for directory item previews.

### ScreenshotOne

Website screenshots via the ScreenshotOne API.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `screenshotone` |
| Configuration Mode | `hybrid`        |
| Auto Enable        | No              |

**Environment Variables:**

| Variable                          | Required | Description              |
| --------------------------------- | -------- | ------------------------ |
| `PLUGIN_SCREENSHOTONE_ACCESS_KEY` | No       | ScreenshotOne access key |
| `PLUGIN_SCREENSHOTONE_SECRET_KEY` | No       | ScreenshotOne secret key |

**Settings:**

| Setting          | Type    | Default | Description                   |
| ---------------- | ------- | ------- | ----------------------------- |
| `accessKey`      | string  | —       | Access key (required, secret) |
| `secretKey`      | string  | —       | Secret key (secret)           |
| `viewportWidth`  | number  | `1280`  | Viewport width                |
| `viewportHeight` | number  | `1024`  | Viewport height               |
| `format`         | string  | `png`   | Image format                  |
| `blockAds`       | boolean | `true`  | Block ads                     |
| `blockTrackers`  | boolean | `true`  | Block trackers                |

### URLBox

Website screenshots via the URLBox API.

| Field              | Value    |
| ------------------ | -------- |
| Plugin ID          | `urlbox` |
| Configuration Mode | `hybrid` |
| Auto Enable        | No       |

**Environment Variables:**

| Variable                   | Required | Description       |
| -------------------------- | -------- | ----------------- |
| `PLUGIN_URLBOX_API_KEY`    | No       | URLBox API key    |
| `PLUGIN_URLBOX_API_SECRET` | No       | URLBox API secret |

**Settings:**

| Setting             | Type    | Default | Description                       |
| ------------------- | ------- | ------- | --------------------------------- |
| `apiKey`            | string  | —       | URLBox API key (required, secret) |
| `apiSecret`         | string  | —       | URLBox API secret (secret)        |
| `viewportWidth`     | number  | `1280`  | Viewport width (320–3840)         |
| `viewportHeight`    | number  | `1024`  | Viewport height (200–2160)        |
| `format`            | string  | `png`   | Image format                      |
| `blockAds`          | boolean | `true`  | Block ads                         |
| `hideCookieBanners` | boolean | `true`  | Hide cookie consent banners       |

## Content Extractors

Content extractor plugins fetch and parse web page content for the generation pipeline.

### Local Content Extractor

Built-in HTML content extraction using fetch and HTML parsing. No external API needed. This is the **default content extractor** and is always enabled.

| Field              | Value                     |
| ------------------ | ------------------------- |
| Plugin ID          | `local-content-extractor` |
| Configuration Mode | `admin-only`              |
| Auto Enable        | Yes                       |
| Default For        | `content-extractor`       |
| System Plugin      | Yes                       |

**Settings:**

| Setting            | Type   | Default | Description                        |
| ------------------ | ------ | ------- | ---------------------------------- |
| `timeout`          | number | `15000` | Request timeout in ms (1000–60000) |
| `minContentLength` | number | `200`   | Minimum content length (0–10000)   |
| `userAgent`        | string | —       | Custom user agent string           |

### Notion Extractor

Extract content from Notion pages (both public and private).

| Field              | Value              |
| ------------------ | ------------------ |
| Plugin ID          | `notion-extractor` |
| Configuration Mode | `hybrid`           |
| Auto Enable        | No                 |

**Settings:**

| Setting                     | Type    | Default | Description                                                  |
| --------------------------- | ------- | ------- | ------------------------------------------------------------ |
| `apiKey`                    | string  | —       | Notion API key (optional, secret — needed for private pages) |
| `useSplitbeeForPublicPages` | boolean | `true`  | Use Splitbee API for public pages                            |
| `timeout`                   | number  | `15000` | Request timeout in ms                                        |

### Jina AI

Web search and content extraction via Jina AI's reader and search APIs.

| Field              | Value                         |
| ------------------ | ----------------------------- |
| Plugin ID          | `jina`                        |
| Configuration Mode | `hybrid`                      |
| Auto Enable        | No                            |
| Capabilities       | `search`, `content-extractor` |

**Environment Variables:**

| Variable              | Required | Description  |
| --------------------- | -------- | ------------ |
| `PLUGIN_JINA_API_KEY` | No       | Jina API key |

**Settings:**

| Setting  | Type   | Default | Description                     |
| -------- | ------ | ------- | ------------------------------- |
| `apiKey` | string | —       | Jina API key (required, secret) |

### Scrapfly

Website screenshot capture and content extraction via the Scrapfly API.

| Field              | Value                             |
| ------------------ | --------------------------------- |
| Plugin ID          | `scrapfly`                        |
| Configuration Mode | `hybrid`                          |
| Auto Enable        | No                                |
| Capabilities       | `screenshot`, `content-extractor` |

**Environment Variables:**

| Variable                  | Required | Description      |
| ------------------------- | -------- | ---------------- |
| `PLUGIN_SCRAPFLY_API_KEY` | No       | Scrapfly API key |

**Settings:**

| Setting  | Type   | Default | Description                         |
| -------- | ------ | ------- | ----------------------------------- |
| `apiKey` | string | —       | Scrapfly API key (required, secret) |

### PDF Content Extractor

Extract text content from PDF files. Uses text-layer extraction by default, with optional OCR fallback via Mistral AI for scanned or image-based PDFs.

| Field        | Value               |
| ------------ | ------------------- |
| Plugin ID    | `pdf-extractor`     |
| Auto Enable  | No                  |
| Capabilities | `content-extractor` |

**Environment Variables:**

| Variable                       | Required | Description                                       |
| ------------------------------ | -------- | ------------------------------------------------- |
| `PLUGIN_PDF_EXTRACTOR_API_KEY` | No       | Mistral AI API key (only needed for OCR fallback) |

**Settings:**

| Setting         | Type   | Default | Description                                         |
| --------------- | ------ | ------- | --------------------------------------------------- |
| `mistralApiKey` | string | —       | Mistral API key for OCR fallback (optional, secret) |

## Data Source

### Apify

Import data from external sources using Apify web scraping actors.

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| Plugin ID    | `apify`                               |
| Capabilities | `data-source`, `form-schema-provider` |

**Settings:**

| Setting               | Type   | Default | Description                                                        |
| --------------------- | ------ | ------- | ------------------------------------------------------------------ |
| `apiToken`            | string | —       | Apify API token (required, secret)                                 |
| `defaultFieldMapping` | object | —       | Field mapping (name, description, source_url, category, image_url) |

## Pipeline

The platform supports three generation pipelines. See [AI & Generation](/ai-agents/#generation-pipelines) for a comparison.

### Standard Pipeline

The default 15-step structured generation pipeline. Uses LangChain for AI operations with configurable search, extraction, and content generation steps.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `standard-pipeline`                |
| Configuration Mode | default                            |
| Auto Enable        | Yes                                |
| Default For        | `pipeline`                         |
| System Plugin      | Yes                                |
| Capabilities       | `pipeline`, `form-schema-provider` |

The 15 pipeline steps, organized into 8 phases:

1. Prompt Comparison
2. Prompt Processing
3. Domain Detection
4. AI First Items Generation
5. Search Queries Generation
6. Web Search
7. Content Retrieval
8. Content Filtering
9. Items Extraction
10. Deduplication and Data Aggregation
11. Categories and Tags Processing
12. Sources Validation
13. Badges Processing
14. Image Capture
15. Markdown Generation

### Agent Pipeline

Autonomous AI agent pipeline using the Vercel AI SDK with tool calling. The agent independently researches and generates directory items using a parent/worker model architecture.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `agent-pipeline`                   |
| Configuration Mode | `hybrid`                           |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

**Settings:**

| Setting    | Type    | Default | Description                                |
| ---------- | ------- | ------- | ------------------------------------------ |
| `maxSteps` | integer | `50`    | Maximum agent tool-calling steps (10–2000) |

### Claude Code Generator

Generation pipeline that uses the Claude Code CLI to autonomously research and generate directory items. Requires either an OAuth token or Anthropic API key.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `claude-code`                      |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

**Settings:**

| Setting        | Type   | Default  | Description                                                 |
| -------------- | ------ | -------- | ----------------------------------------------------------- |
| `oauthToken`   | string | —        | Claude Code OAuth token (secret, from `claude setup-token`) |
| `apiKey`       | string | —        | Anthropic API key (secret, alternative to OAuth)            |
| `model`        | string | —        | Model alias or full name (e.g., `sonnet`, `opus`)           |
| `version`      | string | `2.1.37` | Claude Code CLI version                                     |
| `maxTurns`     | number | `500`    | Maximum conversation turns (1–100)                          |
| `maxBudgetUsd` | number | —        | Maximum budget in USD                                       |

**Environment Variables:**

| Variable                         | Required | Description                                       |
| -------------------------------- | -------- | ------------------------------------------------- |
| `PLUGIN_CLAUDE_CODE_OAUTH_TOKEN` | No       | OAuth token (can be set in user settings instead) |

### Claude Managed Agent

Hosted Claude Managed Agent pipeline. Delegates the full directory generation to Anthropic's managed agent runtime instead of orchestrating the steps locally.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `claude-managed-agent`             |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Claude Managed Agent Plugin](./claude-managed-agent-plugin.md) for setup, settings, and the full list of environment variables. Refer to `packages/plugins/claude-managed-agent/src/` for the latest schema.

### Codex Generator

Pipeline plugin that delegates the full generation to OpenAI Codex. Useful when you want Codex's tool-using behaviour to drive the entire generation flow.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `codex`                            |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Codex Plugin](./codex-plugin.md) for setup. Refer to `packages/plugins/codex/src/` for the current settings schema.

### Gemini Generator

Pipeline plugin that delegates the full generation to the Gemini CLI agent. Distinct from the `google` AI provider plugin: Gemini Generator runs as an autonomous CLI-driven pipeline, while the `google` plugin exposes Gemini models for use as a regular AI provider in the Standard or Agent pipelines.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `gemini`                           |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Gemini Plugin](./gemini-plugin.md) for setup. Refer to `packages/plugins/gemini/src/` for the current settings schema.

### OpenCode Generator

Pipeline plugin that delegates the full generation to OpenCode, an open-source code agent.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `opencode`                         |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [OpenCode Plugin](./opencode-plugin.md) for setup. Refer to `packages/plugins/opencode/src/` for the current settings schema.

### Make.com Workflows

Pipeline plugin that triggers Make.com (formerly Integromat) scenarios via webhooks to handle directory generation. Use this to plug in a no-code/low-code workflow as the source of generated items.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `make`                             |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Make.com Plugin](./make-plugin.md) for setup. Refer to `packages/plugins/make/src/` for the current settings schema.

### SIM AI Workflows

Pipeline plugin that delegates directory generation to a SIM AI workflow defined in the SIM Studio platform.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `sim-ai`                           |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [SIM AI Workflows Plugin](./sim-ai-plugin.md) for setup. Refer to `packages/plugins/sim-ai/src/` for the current settings schema.

### Zapier Automation

Pipeline plugin that triggers Zapier actions during directory generation. Lets you wire generation events to any of Zapier's 7000+ integrations.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `zapier`                           |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Zapier Plugin](./zapier-plugin.md) for setup. Refer to `packages/plugins/zapier/src/` for the current settings schema.

## Prompt Management

### Langfuse

External prompt management plugin. Lets you store, version, label, and A/B-test all pipeline prompts in [Langfuse](https://langfuse.com/) instead of shipping them in-repo.

| Field        | Value             |
| ------------ | ----------------- |
| Plugin ID    | `langfuse`        |
| Category     | `utility`         |
| Auto Enable  | No                |
| Capabilities | `prompt-provider` |

See [Langfuse Plugin](./langfuse-plugin.md) for setup, label conventions, and fallback behaviour. Refer to `packages/plugins/langfuse/src/` for the current settings schema.

## Utility

### Comparison Generator

Auto-generates SEO-optimized A vs B comparison pages between directory items.

| Field              | Value                  |
| ------------------ | ---------------------- |
| Plugin ID          | `comparison-generator` |
| Configuration Mode | `hybrid`               |
| Auto Enable        | No                     |
| System Plugin      | Yes                    |
| Capabilities       | `form-schema-provider` |

**Settings:**

| Setting                    | Type    | Default         | Description                                                       |
| -------------------------- | ------- | --------------- | ----------------------------------------------------------------- |
| `cadence_override`         | string  | `use_directory` | Generation cadence: `use_directory`, `daily`, `weekly`, `monthly` |
| `max_comparisons_mode`     | string  | `custom`        | `custom` or `unlimited`                                           |
| `max_comparisons`          | number  | `50`            | Max total comparisons (1–500, only used in Custom mode)           |
| `min_items_for_comparison` | number  | `3`             | Min items in category before generating (2–20)                    |
| `ai_provider`              | string  | —               | Override AI provider for comparison generation                    |
| `ai_model`                 | string  | —               | Override AI model for comparison generation                       |
| `custom_prompt`            | string  | —               | Additional instructions appended to comparison prompts            |
| `extended_analysis`        | boolean | `false`         | Enable deep-dive 7-section extended analysis                      |

See [Comparisons](/features/comparisons) for the full feature documentation.
