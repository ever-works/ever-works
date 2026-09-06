---
id: built-in-plugins
title: Built-in Plugins
sidebar_label: Built-in Plugins
sidebar_position: 5
---

# Built-in Plugins

The platform ships with 102 plugins under `packages/plugins/`, spanning **19 of the 24 categories** declared by `PLUGIN_CATEGORIES` in `packages/plugin/src/contracts/plugin-manifest.types.ts`: AI provider, search, content extractor, screenshot, git provider, deployment, data source, pipeline, storage, database, vector store, DNS, secret store resolver, job runtime, email provider, notification channel, connector, metrics, and utility. (`form`, `integration`, `theme`, `memory`, and `rag` are declared as contracts but have no shipped plugin yet.) This page documents the most widely used ones, with configuration and environment variables for each.

## Plugin count by category

Counted from each package's `everworks.plugin.category` field.

| Category                | Count | Plugin IDs                                                                                                                                                                                                                              |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline`              | 14    | `activepieces`, `agent-pipeline`, `claude-code`, `claude-managed-agent`, `codex`, `composio`, `gemini`, `gtm-pipeline`, `hermes-agent`, `make`, `opencode`, `sim-ai`, `standard-pipeline`, `zapier`                                     |
| `ai-provider`           | 11    | `anthropic`, `google`, `grok`, `groq`, `lm-studio`, `mistral`, `ollama`, `openai`, `openrouter`, `vercel-ai-gateway`, `vllm`                                                                                                            |
| `connector`             | 11    | `bluesky-connector`, `discord-connector`, `google-workspace-connector`, `hubspot-connector`, `jira-connector`, `linear-connector`, `mastodon-connector`, `notion-connector`, `pipedrive-connector`, `slack-connector`, `zoom-connector` |
| `utility`               | 10    | `agentmemory`, `browser-automation`, `comparison-generator`, `everworks-skills`, `everworks-task-tracker`, `langfuse`, `local-workspace`, `memory-pipeline-modifier`, `pty-local`, `sandbox-workspace`                                  |
| `search`                | 9     | `brave`, `brightdata`, `exa`, `firecrawl`, `linkup`, `perplexity`, `serpapi`, `tavily`, `valyu`                                                                                                                                         |
| `secret-store-resolver` | 7     | `secret-store-aws-sm`, `secret-store-azure-kv`, `secret-store-doppler`, `secret-store-gcp-sm`, `secret-store-infisical`, `secret-store-k8s`, `secret-store-vault`                                                                       |
| `job-runtime`           | 6     | `job-runtime-bullmq`, `job-runtime-inngest`, `job-runtime-node`, `job-runtime-pgboss`, `job-runtime-temporal`, `job-runtime-trigger`                                                                                                    |
| `content-extractor`     | 6     | `jina`, `local-content-extractor`, `notion-extractor`, `officecli-extractor`, `pdf-extractor`, `scrapfly`                                                                                                                               |
| `notification-channel`  | 5     | `discord-channel`, `novu-channel`, `slack-channel`, `telegram-channel`, `whatsapp-channel`                                                                                                                                              |
| `email-provider`        | 5     | `mailchimp-transactional`, `mailgun`, `postmark`, `resend`, `sendgrid`                                                                                                                                                                  |
| `storage`               | 4     | `aws-s3`, `github-storage`, `local-fs`, `minio`                                                                                                                                                                                         |
| `metrics`               | 4     | `custom-http-metrics`, `google-analytics-metrics`, `posthog-metrics`, `stripe-metrics`                                                                                                                                                  |
| `vector-store`          | 2     | `pgvector`, `qdrant`                                                                                                                                                                                                                    |
| `screenshot`            | 2     | `screenshotone`, `urlbox`                                                                                                                                                                                                               |
| `deployment`            | 2     | `k8s`, `vercel`                                                                                                                                                                                                                         |
| `git-provider`          | 1     | `github`                                                                                                                                                                                                                                |
| `database`              | 1     | `postgres-db`                                                                                                                                                                                                                           |
| `data-source`           | 1     | `apify`                                                                                                                                                                                                                                 |
| `dns`                   | 1     | `cloudflare-dns`                                                                                                                                                                                                                        |

A plugin's **capabilities** are independent of its category: `scrapfly` sits in `content-extractor` but also advertises `screenshot`, and every `search` plugin except `brave`, `perplexity` and `serpapi` also advertises `content-extractor`.

## EW-693 — Core vs distributable

As of EW-693 (Dynamic Plugin Distribution), every plugin is classified
as either **core** (always bundled in the platform image, present in
both `bundled` and `dynamic` modes) or **distributable** (published to
the npm registry under `@ever-works/*`, installable at runtime when
`PLUGIN_DISTRIBUTION_MODE=dynamic`). The classification lives on the
plugin's manifest (`everworks.plugin.distribution`); when absent, the
default is `core` for `systemPlugin: true` and `registry` otherwise.

**Core (27):** `agent-pipeline`, `comparison-generator`, `github`,
`job-runtime-bullmq`, `job-runtime-inngest`, `job-runtime-node`,
`job-runtime-pgboss`, `job-runtime-temporal`, `job-runtime-trigger`,
`k8s`, `local-content-extractor`, `local-fs`, `local-workspace`,
`openrouter`, `pgvector`, `postgres-db`, `sandbox-workspace`,
`secret-store-aws-sm`, `secret-store-azure-kv`, `secret-store-doppler`,
`secret-store-gcp-sm`, `secret-store-infisical`, `secret-store-k8s`,
`secret-store-vault`, `standard-pipeline`, `tavily`, `vercel`. These
are bundled in every image. `local-fs` is the default boot-storage so
the API can serve without any distributable storage plugin enabled
(FR-4).

**Distributable (75):** every other plugin under `packages/plugins/*`.
In `bundled` mode these still ship in the image (so a fresh deploy
behaves byte-for-byte the same as pre-EW-693); in `dynamic` mode they
are stripped from the image and pulled from `@ever-works/<id>-plugin`
on first enable via the per-replica installer. The full split is
generated from each plugin's `package.json` `everworks.plugin`
manifest — see `scripts/strip-non-core-plugins.js` for the runtime
classification rule.

27 core plus 75 distributable accounts for all 102 plugins. Sixteen
plugins state `distribution: 'core'` explicitly (the six job runtimes,
the seven secret stores, `local-fs`, `pgvector`, `postgres-db`); the
other eleven inherit `core` from `systemPlugin: true`. Everything added
since — including `hermes-agent`, `gtm-pipeline`, `officecli-extractor`,
`grok`, `qdrant`, `cloudflare-dns`, the connectors, the email providers,
the notification channels and the metrics providers — is `registry`,
so it is stripped from a `dynamic`-mode image and installed on demand.

See `docs/specs/features/dynamic-plugin-distribution/spec.md` for the
full feature spec and `docs/internal/EW-693-deployment.md` for the
operator runbook.

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

### Grok (xAI)

Use xAI's Grok models through the OpenAI-compatible xAI API — 131,072-token context, vision input, tool calling and structured output. Assign a different Grok model per task tier.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `grok`          |
| Category           | `ai-provider`   |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |
| Distribution       | `registry`      |

**Settings:**

| Setting        | Type   | Default               | Description                                                             |
| -------------- | ------ | --------------------- | ----------------------------------------------------------------------- |
| `apiKey`       | string | —                     | xAI API key (required, secret, user-scoped; env fallback `XAI_API_KEY`) |
| `defaultModel` | string | `grok-2-latest`       | Default model for all AI tasks (required)                               |
| `simpleModel`  | string | `grok-2-latest`       | Tags, short descriptions, quick classifications                         |
| `mediumModel`  | string | `grok-2-latest`       | Listings, summaries, content reformatting                               |
| `complexModel` | string | `grok-2-latest`       | Full page generation and multi-step analysis                            |
| `baseUrl`      | string | `https://api.x.ai/v1` | API endpoint (advanced, hidden by default)                              |
| `temperature`  | number | `0.7`                 | Response variability (0–2, hidden)                                      |
| `maxTokens`    | number | `4096`                | Max response length (hidden)                                            |

Get a key at [console.x.ai](https://console.x.ai), then enable the plugin at **Settings → Plugins → AI Provider** (`/settings/plugins/ai-provider`) and paste it into **xAI API Key**.

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

### LM Studio

Use locally running models via the LM Studio local server. No API key required.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `lm-studio`     |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default     | Description                                                      |
| -------------- | ------ | ----------- | ---------------------------------------------------------------- |
| `baseUrl`      | string | —           | LM Studio URL (required, e.g., `http://localhost:1234/v1`)       |
| `apiKey`       | string | `lm-studio` | API key (optional; only for an auth proxy in front of LM Studio) |
| `defaultModel` | string | —           | Loaded model id (required; populated via the model picker)       |

### vLLM

Use a self-hosted vLLM OpenAI-compatible server (typically GPU-hosted).

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `vllm`          |
| Configuration Mode | `user-required` |
| Auto Enable        | No              |

**Settings:**

| Setting        | Type   | Default | Description                                                          |
| -------------- | ------ | ------- | -------------------------------------------------------------------- |
| `baseUrl`      | string | —       | vLLM URL (required, e.g., `http://localhost:8000/v1`)                |
| `apiKey`       | string | `EMPTY` | API key (secret; only required if started with `--api-key`)          |
| `defaultModel` | string | —       | Model id passed to `vllm serve --model` (required; via model picker) |

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

Deploy work websites to Vercel. This is the **default deployment provider** and is always enabled.

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

### Kubernetes

Deploy work websites to any Kubernetes cluster you control as an alternative to Vercel. Selectable per-work via `deployProvider: k8s` (dashboard or `.works/works.yml`). Supports a pluggable container registry (GitHub Container Registry by default) and ingress controller strategies (nginx, Traefik, plus a generic fallback). See [Kubernetes Deployment](../features/k8s-deployment.md) for the full user guide.

| Field              | Value           |
| ------------------ | --------------- |
| Plugin ID          | `k8s`           |
| Configuration Mode | `user-required` |
| Auto Enable        | Yes             |
| Default For        | —               |
| System Plugin      | Yes             |

**Settings:**

| Setting               | Type    | Default           | Description                                                     |
| --------------------- | ------- | ----------------- | --------------------------------------------------------------- |
| `kubeconfig`          | string  | —                 | Full kubeconfig YAML (required, secret, user-scoped)            |
| `kubeContext`         | string  | —                 | Override the kubeconfig's `current-context`                     |
| `namespace`           | string  | `ever-works`      | Target Kubernetes namespace                                     |
| `registry.kind`       | string  | `github`          | One of `github`, `dockerhub`, `generic`                         |
| `registry.owner`      | string  | (auto)            | GHCR owner; defaults to your connected GitHub account           |
| `registry.visibility` | string  | `auto`            | `auto` mirrors the website repo, or `public` / `private`        |
| `ingressClass`        | string  | (cluster default) | Detected at validation time; populated from `IngressClass` list |
| `ingressHost`         | string  | —                 | Default ingress host when a work has no custom domain           |
| `tlsIssuer`           | string  | —                 | cert-manager `ClusterIssuer` name                               |
| `replicas`            | integer | `1`               | Pod replicas (1–10)                                             |

## Screenshot

Screenshot plugins capture website images for work item previews.

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

### OfficeCLI Extractor

Extract text from Office documents — Word `.docx`, Excel `.xlsx`, PowerPoint `.pptx` — via the [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) tool and its official `@officecli/sdk` Node SDK. Off by default; enable it only when you need Office source material. It has zero URL overlap with the PDF extractor, and OfficeCLI ships musl binaries so it runs on the platform's `node:22-alpine` base image.

| Field         | Value                 |
| ------------- | --------------------- |
| Plugin ID     | `officecli-extractor` |
| Category      | `content-extractor`   |
| Auto Enable   | No                    |
| System Plugin | No                    |
| Capabilities  | `content-extractor`   |

**Settings:**

| Setting      | Type   | Default    | Description                                                                            |
| ------------ | ------ | ---------- | -------------------------------------------------------------------------------------- |
| `renderMode` | string | `text`     | Output format: `text` or `markdown`                                                    |
| `maxBytes`   | number | `26214400` | Max document size to download and process, 25 MB (env `OFFICECLI_EXTRACTOR_MAX_BYTES`) |
| `timeout`    | number | `30000`    | HTTP download + OfficeCLI command timeout in ms (5000–300000, hidden)                  |
| `binaryPath` | string | —          | Absolute path to a specific `officecli` binary; blank uses the bundled one (hidden)    |

When a source URL points at an Office document, the content-extractor facade delegates to this plugin: it downloads the file behind an SSRF guard and the byte cap, writes it to a private temp file, opens it with OfficeCLI, and always cleans up the temp file and the OfficeCLI resident afterwards.

The bundled OfficeCLI binary and SDK are Apache-2.0; the Ever Works wrapper is AGPL-3.0. See `packages/plugins/officecli-extractor/README.md` for the full attribution notice.

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

## Storage

Storage plugins implement the `storage` capability plus the object verbs (`put-object`, `get-object`, and `presigned-put` where the backend supports pre-signed uploads). They back every file the dashboard accepts — Knowledge Base documents, item images, avatars. Pick one at **Settings → Plugins → Storage** (`/settings/plugins/storage`). Introduced in EW-637; the Git LFS and `data-repo` work landed in EW-644. See [Storage Backends](../features/storage-backends.md) for the user-facing guide.

### Local Filesystem

Writes objects to a directory on the API server. This is the **default boot storage** (FR-4): the API can serve with no distributable storage plugin enabled at all.

| Field         | Value                                 |
| ------------- | ------------------------------------- |
| Plugin ID     | `local-fs`                            |
| Category      | `storage`                             |
| Auto Enable   | Yes                                   |
| System Plugin | Yes                                   |
| Distribution  | `core`                                |
| Capabilities  | `storage`, `put-object`, `get-object` |

**Settings:**

| Setting      | Type   | Default                       | Environment variable | Description                                 |
| ------------ | ------ | ----------------------------- | -------------------- | ------------------------------------------- |
| `uploadsDir` | string | `<tmpdir>/ever-works-uploads` | `UPLOADS_DIR`        | Absolute path on the API server for objects |
| `maxBytes`   | number | `5242880` (5 MiB)             | `UPLOADS_MAX_BYTES`  | Per-object size cap in bytes                |

Single-node only — the directory is local to the API pod, so a multi-replica deployment needs S3, MinIO, or GitHub storage instead.

### AWS S3

| Field        | Value                                                  |
| ------------ | ------------------------------------------------------ |
| Plugin ID    | `aws-s3`                                               |
| Category     | `storage`                                              |
| Auto Enable  | No                                                     |
| Distribution | `registry`                                             |
| Capabilities | `storage`, `put-object`, `get-object`, `presigned-put` |

**Settings** (required: `region`, `bucket`):

| Setting                 | Type   | Default | Environment variable             | Description                                                   |
| ----------------------- | ------ | ------- | -------------------------------- | ------------------------------------------------------------- |
| `region`                | string | —       | `AWS_S3_REGION`                  | Region of the bucket, e.g. `us-east-1`                        |
| `bucket`                | string | —       | `AWS_S3_BUCKET`                  | Bucket name                                                   |
| `accessKeyId`           | string | —       | `AWS_ACCESS_KEY_ID`              | IAM access key (secret); omit to use the AWS credential chain |
| `secretAccessKey`       | string | —       | `AWS_SECRET_ACCESS_KEY`          | IAM secret (secret); omit to use the AWS credential chain     |
| `presignExpiresSeconds` | number | `600`   | `AWS_S3_PRESIGN_EXPIRES_SECONDS` | Pre-signed upload URL TTL, 60–3600                            |

Leaving both key fields blank is the recommended production setup: the plugin then falls back to the default AWS credential chain (instance role, IRSA, or the ambient profile).

### MinIO

S3-compatible object storage you host yourself. Same verb set as AWS S3, pointed at your own endpoint.

| Field        | Value                                                  |
| ------------ | ------------------------------------------------------ |
| Plugin ID    | `minio`                                                |
| Category     | `storage`                                              |
| Auto Enable  | No                                                     |
| Distribution | `registry`                                             |
| Capabilities | `storage`, `put-object`, `get-object`, `presigned-put` |

**Settings** (required: `endpoint`, `bucket`):

| Setting                 | Type   | Default     | Environment variable            | Description                                              |
| ----------------------- | ------ | ----------- | ------------------------------- | -------------------------------------------------------- |
| `endpoint`              | string | —           | `MINIO_ENDPOINT`                | Full endpoint URL, e.g. `https://minio.example.com:9000` |
| `region`                | string | `us-east-1` | `MINIO_REGION`                  | Region label sent in S3 requests (MinIO ignores it)      |
| `bucket`                | string | —           | `MINIO_BUCKET`                  | Bucket name                                              |
| `accessKey`             | string | —           | `MINIO_ACCESS_KEY`              | MinIO access key (secret)                                |
| `secretKey`             | string | —           | `MINIO_SECRET_KEY`              | MinIO secret key (secret)                                |
| `presignExpiresSeconds` | number | `600`       | `MINIO_PRESIGN_EXPIRES_SECONDS` | Pre-signed upload URL TTL, 60–3600                       |

### GitHub Storage

Stores uploads as files in a GitHub repository, with optional Git LFS. Keeps every asset inside the Git-native ownership model — the same repos you already own.

| Field        | Value                                        |
| ------------ | -------------------------------------------- |
| Plugin ID    | `github-storage`                             |
| Category     | `storage`                                    |
| Auto Enable  | No                                           |
| Distribution | `registry`                                   |
| Capabilities | `storage`, `put-object`, `get-object`, `lfs` |

**Modes** (the `mode` setting):

| Mode                      | Behaviour                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `separate-repo` (default) | One operator-owned repository holds every upload. Owner and repo come from the settings UI (the same OAuth-connected selectors as work creation) or from the env vars. |
| `data-repo`               | Uploads land in each Work's own data repo, resolved per upload from the Work's owner and storage config, authenticated with that Work owner's OAuth token.             |

`data-repo` mode requires the API to inject a `WorkRepoResolver` into the plugin context at boot (`apps/api/src/uploads/storage-backend.factory.ts` does this) and requires every upload to carry `workId` — anonymous uploads are rejected with a configuration error rather than silently misfiled.

**Git LFS.** With `lfsEnabled` on, the blob goes to GitHub's LFS storage via the LFS Batch API and only a pointer file is committed; the plugin also keeps an idempotent `.gitattributes` entry tracking `<pathPrefix>/**`. It defaults to `true` for fresh deployments and `false` for deployments that already had the legacy env vars set without an explicit `mode`, so existing setups keep a byte-for-byte identical commit shape. LFS deletes are best-effort — removing the pointer commit drops the file from the branch tree, but GitHub's public API exposes no LFS object purge, matching `git lfs rm`.

| Transport setting                 | Values                                             | Notes                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lfsTransport`                    | `api` (default), `git-cli`                         | `api` calls the LFS Batch API over HTTPS via the Octokit token — no binaries needed. `git-cli` shells out and needs `git` ≥ 2.40 + `git-lfs` ≥ 3.4 on PATH. |
| `transport` (non-LFS commit path) | `auto` (default), `contents-api`, `clone-and-push` | `auto` picks `contents-api` for `separate-repo` and `clone-and-push` (isomorphic-git) for `data-repo`.                                                      |

**Environment Variables:**

| Variable                         | Required               | Description                                                                                                  |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GITHUB_STORAGE_MODE`            | No                     | `separate-repo` (default) or `data-repo`                                                                     |
| `GITHUB_STORAGE_TOKEN`           | Yes in `separate-repo` | PAT with `contents:write` on the storage repo                                                                |
| `GITHUB_STORAGE_OWNER`           | Yes in `separate-repo` | Repository owner                                                                                             |
| `GITHUB_STORAGE_REPO`            | Yes in `separate-repo` | Repository name                                                                                              |
| `GITHUB_STORAGE_BRANCH`          | No                     | Default `main`                                                                                               |
| `GITHUB_STORAGE_PATH_PREFIX`     | No                     | Default `uploads`                                                                                            |
| `GITHUB_STORAGE_LFS_ENABLED`     | No                     | `true` / `false` — see the default rule above                                                                |
| `GITHUB_STORAGE_LFS_TRANSPORT`   | No                     | `api` (default) or `git-cli`                                                                                 |
| `GITHUB_STORAGE_TRANSPORT`       | No                     | `auto` / `contents-api` / `clone-and-push`                                                                   |
| `GITHUB_STORAGE_PUBLIC_URL_BASE` | No                     | Public raw URL base (e.g. a CDN in front of a public repo); unset routes reads through the authenticated API |

The matching settings keys are `mode`, `token`, `owner`, `repo`, `branch`, `pathPrefix`, `lfsEnabled`, `lfsTransport` and `transport` — the settings form and the environment variables above are two views of the same values.

## Database

### PostgreSQL DB

Holds the relational database connection used by deployed Works. Distinct from `storage` (object storage): this is the SQL server a Work's site talks to. The plugin owns the tenant-level backend choice and provisions or derives a database per Work.

| Field              | Value                   |
| ------------------ | ----------------------- |
| Plugin ID          | `postgres-db`           |
| Category           | `database`              |
| Configuration Mode | `hybrid`                |
| Auto Enable        | Yes                     |
| System Plugin      | Yes                     |
| Distribution       | `core`                  |
| Capabilities       | `database`, `datastore` |

**Settings:**

| Setting                    | Type   | Scope | Default         | Description                                                                                                                                                                                                                                                                       |
| -------------------------- | ------ | ----- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                     | string | user  | `ever-works-db` | `ever-works-db` — a managed database provisioned for you, one per Work, no setup. `custom` — connect your own Postgres server.                                                                                                                                                    |
| `customConnectionString`   | string | user  | —               | `postgresql://user:password@host:5432/db`, used as the server for all your Works. A database is created per Work when the role allows `CREATE DATABASE`; otherwise the connection is used as-is. Secret; stored encrypted and shown masked. Visible only when `mode` is `custom`. |
| `overrideConnectionString` | string | work  | —               | Override the database for THIS Work only. Secret; writable from the Work's **Deploy** page (`/works/:id/deploy`) — the scope guards enforce that. Blank falls back to the account-level setting.                                                                                  |

See [Managed Hosting](../features/managed-hosting.md) for how the managed `ever-works-db` mode fits with `*.ever.works` subdomains.

## Vector Store

Vector-store plugins hold the Knowledge Base chunk embeddings and answer retrieval queries. Every plugin normalises its raw vendor score into `[0, 1]` (higher is better) so the retrieval contract stays backend-independent, and declares how it isolates one Work from another (`namespacePerWork`).

### pgvector

The **default vector store**. Keeps embeddings in the same Postgres the API already uses, in the `work_knowledge_chunks` table created by the agent migrations — zero extra infrastructure.

| Field         | Value                          |
| ------------- | ------------------------------ |
| Plugin ID     | `pgvector`                     |
| Category      | `vector-store`                 |
| Default For   | `vector-store`                 |
| Auto Enable   | Yes                            |
| System Plugin | Yes                            |
| Distribution  | `core`                         |
| Tenancy mode  | `rowFilter` (per-Work via SQL) |

**Settings:**

| Setting               | Type   | Default                  | Environment variable      | Description                                                                                                                    |
| --------------------- | ------ | ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `embeddingModel`      | string | `text-embedding-3-small` | `KB_EMBEDDING_MODEL`      | Must match the model that produced the existing rows — a mismatch retrieves from a mixed vector space and recall drops sharply |
| `embeddingDimensions` | number | `1536`                   | `KB_EMBEDDING_DIMENSIONS` | `vector(N)` column dimension (1–16000). Changing it needs a column-altering migration plus a full re-embed                     |
| `indexType`           | string | `ivfflat`                | `KB_PGVECTOR_INDEX_TYPE`  | `ivfflat` or `hnsw`; `hnsw` is faster at query time but needs pgvector ≥ 0.5.0 and a separate index build                      |
| `lists`               | number | `100`                    | `KB_PGVECTOR_LISTS`       | ivfflat inverted lists — tune to about `sqrt(rows)`                                                                            |
| `efSearch`            | number | `40`                     | `KB_PGVECTOR_EF_SEARCH`   | HNSW recall-vs-latency knob; ignored when `indexType` is `ivfflat`                                                             |

Every retrieval applies `WHERE work_id = $1`, so per-Work isolation holds even though all Works share one table.

### Qdrant

Stores embeddings in a Qdrant cluster (Qdrant Cloud or self-hosted) with **one collection per Work** — `deleteByWork` becomes a single collection drop instead of a whole-index payload-filter delete, and HNSW parameters can be tuned per tenant.

| Field           | Value                          |
| --------------- | ------------------------------ |
| Plugin ID       | `qdrant`                       |
| Category        | `vector-store`                 |
| Auto Enable     | No                             |
| Distribution    | `registry` (install-on-demand) |
| Tenancy mode    | `collection` (one per Work)    |
| Supports filter | Yes (payload filter pushdown)  |
| Supports hybrid | No (vector-only retrieval)     |

**Settings:**

| Setting            | Type   | Default                  | Environment variable       | Description                                                                                  |
| ------------------ | ------ | ------------------------ | -------------------------- | -------------------------------------------------------------------------------------------- |
| `qdrantUrl`        | string | `http://localhost:6333`  | `QDRANT_URL`               | HTTP(S) endpoint of the Qdrant instance                                                      |
| `qdrantApiKey`     | string | —                        | `QDRANT_API_KEY`           | Secret. Required for Qdrant Cloud and any cluster behind auth                                |
| `collectionPrefix` | string | `ever-works-kb`          | `QDRANT_COLLECTION_PREFIX` | Final collection name is `{prefix}-{workId}`                                                 |
| `embeddingModel`   | string | `text-embedding-3-small` | `KB_EMBEDDING_MODEL`       | Must match the model that produced the points already in the collection                      |
| `vectorSize`       | number | `1536`                   | `QDRANT_VECTOR_SIZE`       | Changing it requires re-creating the collection                                              |
| `distance`         | string | `cosine`                 | `QDRANT_DISTANCE`          | `cosine`, `dot`, or `euclid` — drives both the collection config and the score normalisation |
| `upsertBatchSize`  | number | `128`                    | `QDRANT_UPSERT_BATCH_SIZE` | Points per `POST /points` request                                                            |

Score normalisation branches on the distance metric: cosine maps `(raw + 1) / 2`, dot applies a sigmoid, euclid uses `1 / (1 + raw)` — every branch clamped to `[0, 1]`.

## Pipeline

The platform ships **14 pipeline plugins** — three first-party engines plus eleven that delegate generation to an external agent or automation platform. See [AI & Generation](/ai-agents/#generation-pipelines) for a comparison.

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

Autonomous AI agent pipeline using the Vercel AI SDK with tool calling. The agent independently researches and generates work items using a parent/worker model architecture.

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

Generation pipeline that uses the Claude Code CLI to autonomously research and generate work items. Requires either an OAuth token or Anthropic API key.

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

Hosted Claude Managed Agent pipeline. Delegates the full work generation to Anthropic's managed agent runtime instead of orchestrating the steps locally.

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

Pipeline plugin that triggers Make.com (formerly Integromat) scenarios via webhooks to handle work generation. Use this to plug in a no-code/low-code workflow as the source of generated items.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `make`                             |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Make.com Plugin](./make-plugin.md) for setup. Refer to `packages/plugins/make/src/` for the current settings schema.

### SIM AI Workflows

Pipeline plugin that delegates work generation to a SIM AI workflow defined in the SIM Studio platform.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `sim-ai`                           |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [SIM AI Workflows Plugin](./sim-ai-plugin.md) for setup. Refer to `packages/plugins/sim-ai/src/` for the current settings schema.

### Zapier Automation

Pipeline plugin that triggers Zapier actions during work generation. Lets you wire generation events to any of Zapier's 7000+ integrations.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `zapier`                           |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Zapier Plugin](./zapier-plugin.md) for setup. Refer to `packages/plugins/zapier/src/` for the current settings schema.

### Composio Integrations

Pipeline plugin that executes Composio tools during work generation. Gives Ever Works access to 500+ third-party app integrations (Gmail, Slack, GitHub, Notion, Linear, Salesforce, …) with OAuth brokered per user by Composio.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `composio`                         |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Composio Plugin](./composio-plugin.md) for setup. Refer to `packages/plugins/composio/src/` for the current settings schema.

### Activepieces Automation

Pipeline plugin that delegates work generation to Activepieces flows. It triggers a flow webhook at the execute stage and collects structured items from the flow's Return Response action — an AI-first, open-source alternative to Make.com and Zapier that you can self-host or run on Activepieces Cloud.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `activepieces`                     |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Capabilities       | `pipeline`, `form-schema-provider` |

See [Activepieces Plugin](./activepieces-plugin.md) for setup. Refer to `packages/plugins/activepieces/src/` for the current settings schema.

### Hermes Agent

Pipeline plugin that uses a preconfigured [Hermes Agent](https://github.com/NousResearch/hermes-agent) installation on the API host as the generation engine. Ever Works provisions an isolated workspace for the run, launches Hermes in one-shot CLI mode against it, and validates the structured result file Hermes writes back before storing the generated items.

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `hermes-agent`                     |
| Category           | `pipeline`                         |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |
| Distribution       | `registry`                         |
| Capabilities       | `pipeline`, `form-schema-provider` |

**Settings** (required: `profile`):

| Setting      | Type    | Default      | Description                                                                                     |
| ------------ | ------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `profile`    | string  | `default`    | Hermes profile already configured on the backend via `hermes model` (user-scoped)               |
| `provider`   | string  | —            | Optional Hermes provider override passed to the CLI for each run                                |
| `model`      | string  | —            | Optional Hermes model override passed to the CLI for each run                                   |
| `toolsets`   | string  | `web,skills` | Comma-separated Hermes toolsets to enable for generation                                        |
| `skills`     | string  | —            | Optional comma-separated Hermes skills to preload                                               |
| `maxTurns`   | number  | `90`         | Maximum Hermes tool-calling turns per run (1–500)                                               |
| `yolo`       | boolean | `true`       | Bypass Hermes approval prompts so unattended runs do not stall                                  |
| `binaryPath` | string  | `hermes`     | CLI executable path, resolved against the host `PATH` (hidden; env `PLUGIN_HERMES_BINARY_PATH`) |

**Backend prerequisites:**

1. Install Hermes Agent on the machine running the Ever Works API.
2. Run `hermes model` for the profile you intend to use.
3. Enter that profile name in the plugin's settings page, then select `hermes-agent` as the pipeline for the Work at `/works/:id/plugins`.

Hermes provider secrets stay in Hermes' own profile configuration — this plugin does not manage them. Hermes runs do not persist checkpoints (only `standard-pipeline` does), so a host restart mid-run means cancelling and re-triggering generation.

### Go-to-Market Pipeline

The engine behind **Campaign** Works. Runs the go-to-market stage set — research → qualify → draft → review → act → follow-up → enrich → measure — with every stage declaring its `requires` / `provides` keys so hand-offs are explicit and auditable. **Review is a human gate placed before any outbound action**, and the `act` stage only stages approved drafts for delivery: it never sends.

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Plugin ID    | `gtm-pipeline`                     |
| Category     | `pipeline`                         |
| Auto Enable  | No                                 |
| Distribution | `registry`                         |
| Capabilities | `pipeline`, `form-schema-provider` |

**Generator form fields** (resolved from the Work's generator config; out-of-range values clamp to the default):

| Field                    | Type   | Default        | Range / values                                       | Description                                                      |
| ------------------------ | ------ | -------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| `target_channels`        | tags   | `email`        | `email`, `blog`, `social`, `newsletter`, `community` | Channels to prepare content for                                  |
| `tone`                   | select | `professional` | `professional`, `friendly`, `direct`, `enthusiastic` | Voice used for drafted content                                   |
| `cadence`                | select | `weekly`       | `daily`, `weekly`, `biweekly`, `monthly`             | How often the pipeline is expected to run                        |
| `max_contacts_per_run`   | number | `20`           | 1–200                                                | Upper bound of contacts drafted per run                          |
| `qualify_min_score`      | number | `40`           | 0–100                                                | Minimum qualify score required to keep a contact                 |
| `risk_exclude_threshold` | number | `7`            | 0–10                                                 | Contacts at or above this risk score are excluded                |
| `review_required`        | bool   | `true`         | —                                                    | Human gate before any outbound action (drafts-not-sends)         |
| `follow_up_quiet_days`   | number | `4`            | 1–90                                                 | Days of silence after which a prepared action queues a follow-up |

Creating a Campaign Work at `/works/new/campaign` provisions the Work, its Goal, the GTM Agents and the seeded Tasks in one call, with this pipeline already selected. See [Campaigns](../features/campaigns.md).

## Prompt Management

### Langfuse

External prompt management plugin. Lets you store, version, label, and A/B-test all pipeline prompts in [Langfuse](https://langfuse.com/) instead of shipping them in-repo.

| Field        | Value             |
| ------------ | ----------------- |
| Plugin ID    | `langfuse`        |
| Category     | `utility`         |
| Auto Enable  | Yes               |
| Default For  | `prompt-provider` |
| Distribution | `registry`        |
| Capabilities | `prompt-provider` |

**Environment Variables:**

| Variable                     | Required | Description                                   |
| ---------------------------- | -------- | --------------------------------------------- |
| `PLUGIN_LANGFUSE_SECRET_KEY` | No       | Langfuse secret key for API authentication    |
| `PLUGIN_LANGFUSE_PUBLIC_KEY` | No       | Langfuse public key for API authentication    |
| `PLUGIN_LANGFUSE_BASE_URL`   | No       | Langfuse base URL (for self-hosted instances) |

See [Langfuse Plugin](./langfuse-plugin.md) for setup, label conventions, and fallback behaviour. Refer to `packages/plugins/langfuse/src/` for the current settings schema.

## Email Providers

Email-provider plugins implement `email-outbound` and, where the vendor supports it, `email-inbound`. They send every platform email — notifications, digests, and [Agent mailboxes](../features/agent-email.md) — and parse replies back in. Configure them at **Settings → Integrations → Emails** (`/settings/integrations/emails`). Every provider de-dupes on `EmailSendInput.messageRef`, so a retried send is never delivered twice.

| Plugin ID                 | Capabilities                      | Transport                                                    |
| ------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `resend`                  | `email-outbound`                  | Official `resend` SDK with native idempotency keys           |
| `sendgrid`                | `email-outbound`                  | Official `@sendgrid/mail` SDK, v3 Mail Send                  |
| `mailchimp-transactional` | `email-outbound`                  | Official `@mailchimp/mailchimp_transactional` SDK (Mandrill) |
| `mailgun`                 | `email-outbound`, `email-inbound` | Official `mailgun.js` SDK + signed inbound routes            |
| `postmark`                | `email-outbound`, `email-inbound` | Postmark Server API + Inbound Streams webhook parser         |

**Settings by provider:**

| Plugin                    | Setting                | Required | Secret | Environment variable          | Notes                                                       |
| ------------------------- | ---------------------- | -------- | ------ | ----------------------------- | ----------------------------------------------------------- |
| `resend`                  | `apiKey`               | Yes      | Yes    | `RESEND_API_KEY`              | Resend API key                                              |
| `resend`                  | `defaultSenderDomain`  | No       | No     | —                             | Default `from` domain                                       |
| `sendgrid`                | `apiKey`               | Yes      | Yes    | `SENDGRID_API_KEY`            | A fresh `MailService` per send keeps the key request-scoped |
| `sendgrid`                | `defaultSenderDomain`  | No       | No     | —                             | Default `From` domain                                       |
| `mailchimp-transactional` | `apiKey`               | Yes      | Yes    | `MANDRILL_API_KEY`            | Transactional (Mandrill) product, not the Marketing API     |
| `mailchimp-transactional` | `defaultSenderDomain`  | No       | No     | —                             | Default `From` domain                                       |
| `mailgun`                 | `apiKey`               | Yes      | Yes    | `MAILGUN_API_KEY`             | —                                                           |
| `mailgun`                 | `domain`               | Yes      | No     | `MAILGUN_DOMAIN`              | Sending domain                                              |
| `mailgun`                 | `region`               | No       | No     | `MAILGUN_REGION`              | `us` (default) or `eu`                                      |
| `mailgun`                 | `webhookSigningKey`    | No       | Yes    | `MAILGUN_WEBHOOK_SIGNING_KEY` | Enables inbound HMAC-SHA256 verification; unset skips it    |
| `postmark`                | `apiKey`               | Yes      | Yes    | `POSTMARK_API_KEY`            | Postmark Server API token                                   |
| `postmark`                | `defaultSenderDomain`  | No       | No     | —                             | Default `From` domain                                       |
| `postmark`                | `inboundWebhookSecret` | No       | Yes    | `POSTMARK_INBOUND_SECRET`     | Basic-Auth secret for inbound webhook verification          |
| `postmark`                | `inboundStreamId`      | No       | No     | —                             | Specific inbound stream id                                  |

**Inbound webhook URLs** (register these in the provider's dashboard):

| Provider | Purpose         | URL                                                |
| -------- | --------------- | -------------------------------------------------- |
| Postmark | Inbound email   | `https://<your-domain>/api/email/inbound/postmark` |
| Postmark | Delivery events | `https://<your-domain>/api/email/events/postmark`  |

Postmark surfaces `Delivery`, `Bounce`, `SpamComplaint`, `Open` and `Click` events. Mailgun verifies inbound with `HMAC(signingKey, timestamp + token)` compared in constant time and decodes both JSON and form-urlencoded webhook bodies. Resend inbound is not supported yet — Resend's inbound product is still in private beta.

## Notification Channels

Notification-channel plugins are **outbound-only** delivery surfaces for platform notifications. Add and test them at **Settings → Integrations → Channels** (`/settings/integrations/channels`); each channel row has a **Send test** action backed by `POST /api/notification-channels/:id/test`. See [Notifications](../features/notifications.md).

Each plugin declares a **shape** — `broadcast` (a room everyone sees), `direct` (one recipient), or `workflow` (the vendor fans out itself) — plus per-channel `targetConfig` and tenant-wide default settings.

| Plugin ID          | Shape       | Transport                                                 |
| ------------------ | ----------- | --------------------------------------------------------- |
| `slack-channel`    | `broadcast` | Official `@slack/webhook` SDK over an incoming webhook    |
| `discord-channel`  | `broadcast` | Discord incoming webhook URL (plain HTTPS POST)           |
| `telegram-channel` | `direct`    | Official `grammy` SDK (`Api.sendMessage`)                 |
| `whatsapp-channel` | `direct`    | WhatsApp Business Cloud API (`/{phoneNumberId}/messages`) |
| `novu-channel`     | `workflow`  | Novu Trigger API (`POST /v1/events/trigger`)              |

**Per-channel `targetConfig`:**

| Plugin             | Key             | Required | Description                                                    |
| ------------------ | --------------- | -------- | -------------------------------------------------------------- |
| `slack-channel`    | `webhookUrl`    | Yes      | Slack incoming webhook URL (`https://hooks.slack.com/...`)     |
| `slack-channel`    | `username`      | No       | Override sender username for this channel                      |
| `slack-channel`    | `iconEmoji`     | No       | Override sender icon emoji for this channel                    |
| `discord-channel`  | `webhookUrl`    | Yes      | Discord channel incoming webhook URL                           |
| `discord-channel`  | `username`      | No       | Override sender username for this channel                      |
| `discord-channel`  | `avatarUrl`     | No       | Override sender avatar for this channel                        |
| `telegram-channel` | `botToken`      | Yes      | Bot token from @BotFather                                      |
| `telegram-channel` | `chatId`        | Yes      | Destination chat id                                            |
| `whatsapp-channel` | `accessToken`   | Yes      | Meta system-user access token                                  |
| `whatsapp-channel` | `phoneNumberId` | Yes      | WhatsApp Business phone-number id                              |
| `whatsapp-channel` | `to`            | Yes      | Recipient phone in E.164, e.g. `+15551234567`                  |
| `novu-channel`     | `apiKey`        | Yes      | Novu API key (environment-scoped)                              |
| `novu-channel`     | `workflowId`    | Yes      | Novu workflow trigger identifier (the workflow's `name` field) |
| `novu-channel`     | `subscriberId`  | Yes      | Novu subscriber to deliver to                                  |

**Plugin-level defaults** (tenant-wide fallbacks used when a channel does not override them):

| Plugin             | Setting               | Description                                                                             |
| ------------------ | --------------------- | --------------------------------------------------------------------------------------- |
| `slack-channel`    | `defaultUsername`     | Fallback sender username                                                                |
| `slack-channel`    | `defaultIconEmoji`    | Fallback icon emoji, e.g. `:robot_face:`                                                |
| `discord-channel`  | `defaultUsername`     | Fallback sender username                                                                |
| `discord-channel`  | `defaultAvatarUrl`    | Fallback sender avatar                                                                  |
| `telegram-channel` | `disableNotification` | Send silently — no sound or vibration                                                   |
| `whatsapp-channel` | `apiVersion`          | Graph API version, defaults to `v21.0`                                                  |
| `novu-channel`     | `apiBase`             | Defaults to `https://api.novu.co`; set for self-hosted or EU (`https://eu.api.novu.co`) |

**Rich payloads.** Slack accepts Block Kit via the `slack-blocks` payload kind, Discord accepts embeds via `discord-embeds`, Telegram accepts MarkdownV2 via `telegram-markdown`, and WhatsApp accepts a pre-approved template via `whatsapp-template` (`{ name, language, components }`).

**Finding a Telegram chat id:**

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the `botToken`.
2. Send any message to the bot, or add it to a group.
3. `GET https://api.telegram.org/bot<botToken>/getUpdates` and read `result[].message.chat.id`.
4. Paste that value into `chatId` — `verifyTarget` calls `getMe` before the first send to confirm the token.

:::caution WhatsApp's 24-hour window
WhatsApp only allows free-form **text** within 24 hours of the recipient's last message. Outside that window you must send a pre-approved template via the `whatsapp-template` payload kind; plain `text` is best-effort and in-window only.
:::

## Connectors

Connectors are **bidirectional** communication plugins: they send outbound messages or records _and_ pull inbound activity into the event-ingest spine as `IngestedEventEnvelope`s. A connector is a superset of a `notification-channel` — both families coexist, and both are distinct from the third-party automation aggregators in the Pipeline section. Manage them at **Settings → Plugins → Connector** (`/settings/plugins/connector`); see [Connectors](../features/connectors.md) and [Integrations](../features/integrations.md).

Every connector with the `event-source` capability supports an opt-in historical **`backfillDays`** window (default `0` = off, max 90) that widens the _first_ pull only, bounded to a per-phase page cap. Re-delivery is free — the ingest pipeline dedupes on `(source, sourceEventId)`. Connectors that also expose the optional `backfill()` method can import history at any time over an explicit window rather than only as a side effect of the first pull.

| Plugin ID                    | Capabilities                                       | SDK                                         | Outbound                                       |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `slack-connector`            | `connector`, `connector-slack`, `event-source`     | `@slack/web-api`                            | `chat.postMessage` with a bot token            |
| `discord-connector`          | `connector`, `connector-discord`                   | `discord.js` REST client                    | `POST /channels/:id/messages` with a bot token |
| `linear-connector`           | `connector`, `connector-linear`, `event-source`    | `@linear/sdk`                               | Comment on a Linear issue                      |
| `notion-connector`           | `connector`, `connector-notion`, `event-source`    | `@notionhq/client`                          | Comment on a Notion page                       |
| `jira-connector`             | `connector`, `event-source`                        | `jira.js`                                   | Comment on a Jira issue                        |
| `hubspot-connector`          | `connector`, `connector-hubspot`, `event-source`   | `@hubspot/api-client`                       | Note engagement on a CRM record                |
| `pipedrive-connector`        | `connector`, `connector-pipedrive`, `event-source` | `pipedrive`                                 | Note on a deal, person, or organization        |
| `google-workspace-connector` | `connector`, `event-source`                        | `@googleapis/drive`, `@googleapis/calendar` | Drive + Calendar sweep (ingest-focused)        |
| `zoom-connector`             | `connector`, `event-source`                        | `@zoom/rivet`                               | Cloud-recording + transcript sweep             |
| `bluesky-connector`          | `connector`, `connector-bluesky`, `event-source`   | `@atproto/api`                              | Post, or a threaded reply                      |
| `mastodon-connector`         | `connector`, `connector-mastodon`, `event-source`  | `masto`                                     | Status at the configured visibility            |

**Settings by connector:**

| Plugin                       | Setting                     | Secret | Environment variable             | Description                                                                           |
| ---------------------------- | --------------------------- | ------ | -------------------------------- | ------------------------------------------------------------------------------------- |
| `slack-connector`            | `botToken`                  | Yes    | `SLACK_BOT_TOKEN`                | Bot User OAuth token (`xoxb-…`)                                                       |
| `slack-connector`            | `signingSecret`             | Yes    | `SLACK_SIGNING_SECRET`           | For the inbound Events API                                                            |
| `slack-connector`            | `appId`                     | No     | —                                | Slack app id                                                                          |
| `slack-connector`            | `defaultChannelId`          | No     | —                                | Default destination channel, e.g. `C0123456789`                                       |
| `slack-connector`            | `eventChannelIds`           | No     | —                                | Channels to ingest events from (comma-separated ids); defaults to the default channel |
| `discord-connector`          | `botToken`                  | Yes    | `DISCORD_BOT_TOKEN`              | Bot token                                                                             |
| `discord-connector`          | `publicKey`                 | Yes    | `DISCORD_PUBLIC_KEY`             | Application public key for the inbound Interactions API                               |
| `discord-connector`          | `applicationId`             | No     | —                                | Discord application (client) id                                                       |
| `discord-connector`          | `guildId`                   | No     | —                                | Default guild/server id                                                               |
| `discord-connector`          | `defaultChannelId`          | No     | —                                | Default destination channel                                                           |
| `linear-connector`           | `apiKey`                    | Yes    | `LINEAR_API_KEY`                 | Linear API key (`lin_api_…`)                                                          |
| `linear-connector`           | `teamIds`                   | No     | —                                | Comma-separated team-id filter for the pull                                           |
| `linear-connector`           | `defaultIssueId`            | No     | —                                | Default issue for outbound comments                                                   |
| `notion-connector`           | `apiKey`                    | Yes    | `NOTION_API_KEY`                 | Notion integration token                                                              |
| `notion-connector`           | `databaseIds`               | No     | —                                | Comma-separated database filter; empty falls back to workspace `search`               |
| `notion-connector`           | `defaultPageId`             | No     | —                                | Default page for outbound comments                                                    |
| `jira-connector`             | `baseUrl`                   | No     | `JIRA_BASE_URL`                  | Jira site URL, `https://` only — validated against SSRF before every call             |
| `jira-connector`             | `email`                     | No     | `JIRA_EMAIL`                     | Atlassian account email (API-token basic auth)                                        |
| `jira-connector`             | `apiToken`                  | Yes    | `JIRA_API_TOKEN`                 | Atlassian API token                                                                   |
| `jira-connector`             | `projectKeys`               | No     | —                                | Comma-separated project-key filter, whitelisted against Jira's key alphabet           |
| `jira-connector`             | `defaultIssueKey`           | No     | —                                | Default issue for outbound comments                                                   |
| `hubspot-connector`          | `accessToken`               | Yes    | `HUBSPOT_ACCESS_TOKEN`           | Private-app token                                                                     |
| `hubspot-connector`          | `objectTypes`               | No     | —                                | Comma-separated sweep list; contacts, companies, deals when empty                     |
| `hubspot-connector`          | `portalId`                  | No     | —                                | Portal (hub) id — enables record deep links on every envelope                         |
| `hubspot-connector`          | `defaultObjectType`         | No     | —                                | Default object type for `createRecord` and the verify probe                           |
| `hubspot-connector`          | `defaultAssociatedObjectId` | No     | —                                | Default CRM record outbound notes attach to                                           |
| `pipedrive-connector`        | `apiToken`                  | Yes    | `PIPEDRIVE_API_TOKEN`            | API token                                                                             |
| `pipedrive-connector`        | `entityTypes`               | No     | —                                | Comma-separated sweep list; deals, persons, organizations by default                  |
| `pipedrive-connector`        | `companyDomain`             | No     | —                                | `acme` for `acme.pipedrive.com` — enables record deep links                           |
| `pipedrive-connector`        | `defaultDealId`             | No     | —                                | Default deal outbound notes attach to                                                 |
| `google-workspace-connector` | `clientId`                  | No     | `GOOGLE_WORKSPACE_CLIENT_ID`     | Google OAuth client id                                                                |
| `google-workspace-connector` | `clientSecret`              | Yes    | `GOOGLE_WORKSPACE_CLIENT_SECRET` | OAuth client secret                                                                   |
| `google-workspace-connector` | `refreshToken`              | Yes    | `GOOGLE_WORKSPACE_REFRESH_TOKEN` | OAuth refresh token                                                                   |
| `google-workspace-connector` | `surfaces`                  | No     | —                                | `drive`, `calendar`, or both (default both)                                           |
| `google-workspace-connector` | `driveFolderIds`            | No     | —                                | Comma-separated Drive folder filter                                                   |
| `google-workspace-connector` | `calendarIds`               | No     | —                                | Comma-separated calendar ids, default `primary`                                       |
| `google-workspace-connector` | `meetTranscripts`           | No     | —                                | Export Meet transcript docs into meeting envelopes (default `true`)                   |
| `zoom-connector`             | `accountId`                 | No     | `ZOOM_ACCOUNT_ID`                | Zoom account id of the Server-to-Server OAuth app (required)                          |
| `zoom-connector`             | `clientId`                  | No     | `ZOOM_CLIENT_ID`                 | Client id of the Server-to-Server OAuth app (required)                                |
| `zoom-connector`             | `clientSecret`              | Yes    | `ZOOM_CLIENT_SECRET`             | Client secret of the Server-to-Server OAuth app (required)                            |
| `bluesky-connector`          | `identifier`                | No     | —                                | Handle or DID of the connected account                                                |
| `bluesky-connector`          | `appPassword`               | Yes    | `BLUESKY_APP_PASSWORD`           | Always an **app password**, never the account password                                |
| `bluesky-connector`          | `service`                   | No     | —                                | PDS URL, defaults to `https://bsky.social`, SSRF-guarded                              |
| `mastodon-connector`         | `instanceUrl`               | No     | —                                | Instance base URL, SSRF-guarded before every call                                     |
| `mastodon-connector`         | `accessToken`               | Yes    | `MASTODON_ACCESS_TOKEN`          | Application token                                                                     |
| `mastodon-connector`         | `defaultVisibility`         | No     | —                                | `public`, `unlisted`, `private`, or `direct`                                          |

Every `event-source` connector also accepts `backfillDays` (0–90) as described above. Required settings, from each plugin's `settingsSchema.required`: `botToken` (Slack, Discord); `apiKey` (Linear, Notion); `apiToken` (Pipedrive); `accessToken` (HubSpot); `baseUrl` + `email` + `apiToken` (Jira); `clientId` + `clientSecret` + `refreshToken` (Google Workspace); `accountId` + `clientId` + `clientSecret` (Zoom); `identifier` + `appPassword` (Bluesky); `instanceUrl` + `accessToken` (Mastodon). Per-send overrides such as Slack's and Discord's `channelId`, Linear's `issueId`, Notion's `pageId` or HubSpot's `associatedObjectId` travel on the send's `targetConfig`, not on plugin settings.

**Inbound status.** The Slack and Discord connectors ship the outbound leg first; inbound message routing (signature verify → pair → route to an Agent → reply in-thread) is a documented follow-up in each plugin's README, with the `signingSecret` / `publicKey` settings already captured so no reconfiguration is needed when it lands.

## Metrics

Metrics plugins implement the read-only `metrics-provider` capability. The `MetricsFacadeService` in `@ever-works/agent` routes `listMetrics` and `getMetricValue` through them so [Goals](../features/goals.md) can evaluate targets like "keep signups above 100" without any vendor being hard-coded into the platform.

| Plugin ID                  | Reads                                                   | Notes                                                                          |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `stripe-metrics`           | Stripe balance and income via the official `stripe` SDK | Values reported in the configured currency                                     |
| `google-analytics-metrics` | GA4 Data API via `@google-analytics/data` (`runReport`) | Active users, conversions, and other GA4 metrics                               |
| `posthog-metrics`          | PostHog Query API                                       | `posthog-node` is ingestion-only, so this plugin uses the documented Query API |
| `custom-http-metrics`      | Any JSON HTTP endpoint you control                      | One metric per configured endpoint, `supportedWindows: ['point']`              |

**Settings:**

| Plugin                     | Setting              | Required | Default                  | Environment variable                    | Description                                                     |
| -------------------------- | -------------------- | -------- | ------------------------ | --------------------------------------- | --------------------------------------------------------------- |
| `stripe-metrics`           | `secretKey`          | Yes      | —                        | `STRIPE_SECRET_KEY`                     | Stripe secret key (a restricted `rk_...` key is recommended)    |
| `stripe-metrics`           | `currency`           | No       | `usd`                    | —                                       | Lowercase ISO-4217 code metric values are reported in           |
| `google-analytics-metrics` | `propertyId`         | Yes      | —                        | `GOOGLE_ANALYTICS_PROPERTY_ID`          | Numeric GA4 property id; `properties/123456789` also accepted   |
| `google-analytics-metrics` | `serviceAccountJson` | Yes      | —                        | `GOOGLE_ANALYTICS_SERVICE_ACCOUNT_JSON` | Full JSON service-account key file (secret)                     |
| `posthog-metrics`          | `projectId`          | Yes      | —                        | `POSTHOG_PROJECT_ID`                    | Numeric project id                                              |
| `posthog-metrics`          | `personalApiKey`     | Yes      | —                        | `POSTHOG_PERSONAL_API_KEY`              | Personal API key (secret)                                       |
| `posthog-metrics`          | `apiHost`            | No       | `https://us.posthog.com` | —                                       | EU Cloud is `https://eu.posthog.com`; self-hosted URLs work too |
| `custom-http-metrics`      | `endpoints`          | Yes      | —                        | —                                       | Array of endpoint definitions (below)                           |

A `custom-http-metrics` endpoint entry:

```jsonc
{
	"endpoints": [
		{
			"id": "mrr", // stable metric id, referenced by Goals
			"label": "Monthly recurring revenue",
			"url": "https://metrics.example.com/mrr",
			"unit": "usd", // optional, defaults to "count"
			"valuePath": "data.metrics[0].value",
			"method": "GET", // optional; GET is the only allowed value
			"headers": {
				// optional; values are stored as secrets
				"Authorization": "Bearer …"
			}
		}
	]
}
```

## DNS

### Cloudflare DNS

Creates, updates, and removes DNS records for the subdomains and custom domains your Works are served from. Implements `IDnsProvider` and runs alongside the legacy concrete provider in `packages/agent/src/ever-works-providers/cloudflare-dns.provider.ts` — this plugin is additive, not a replacement.

| Field        | Value                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| Plugin ID    | `cloudflare-dns`                                                                        |
| Category     | `dns`                                                                                   |
| Auto Enable  | No                                                                                      |
| Visibility   | `user-only`                                                                             |
| Distribution | `registry`                                                                              |
| Capabilities | `dns`, `dns-ensure-record`, `dns-remove-record`, `dns-record-exists`, `dns-root-domain` |

**Two modes, side by side:**

| Mode                           | Who configures it | Where credentials live                                                                                                     |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Managed** (`*.ever.works`)   | Platform operator | Environment variables — the `x-envVar` schema entries forward them into plugin settings, so no per-user setup is needed.   |
| **Bring your own** (your apex) | The account owner | Encrypted user-scoped plugin settings. Records are created with the Cloudflare proxy **off** so you keep serving your TLS. |

**Settings** (required: `apiToken`, `zoneId`):

| Setting          | Type    | Default      | Environment variable            | Description                                                                                                                             |
| ---------------- | ------- | ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apiToken`       | string  | —            | `CLOUDFLARE_API_TOKEN`          | Scoped token with `DNS:Edit` on the target zone (secret, user-scoped)                                                                   |
| `zoneId`         | string  | —            | `CLOUDFLARE_ZONE_ID`            | Zone id that owns the root domain                                                                                                       |
| `rootDomain`     | string  | `ever.works` | `EVER_WORKS_DOMAIN`             | The DNS zone this provider manages                                                                                                      |
| `targetHostname` | string  | —            | `EVER_WORKS_DEPLOY_LB_HOSTNAME` | CNAME target — the ingress load-balancer hostname public Work subdomains resolve to (admin-only)                                        |
| `proxied`        | boolean | `true`       | —                               | Create records behind the Cloudflare proxy (Universal SSL out of the box); set `false` for custom domains you already terminate TLS for |

Create the token at <https://dash.cloudflare.com/profile/api-tokens> with `DNS:Edit` on the target zone.

**Capability methods:**

| Capability          | Method                                           | Behaviour                                                                |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| `dns-ensure-record` | `ensureRecord({ host, type, target, proxied? })` | Idempotent create-or-update; patches drifted records in place            |
| `dns-remove-record` | `removeRecord({ host, type? })`                  | Idempotent delete; omitting `type` probes both `CNAME` and `A`           |
| `dns-record-exists` | `recordExists(host)`                             | Uniqueness probe — true if any `CNAME` or `A` record exists for the host |
| `dns-root-domain`   | `rootDomain()`                                   | Returns the zone's root domain                                           |

See [Custom Domains](../features/custom-domains.md) and [Managed Hosting](../features/managed-hosting.md).

## Job Runtimes

Job-runtime plugins implement `IJobRuntimeProvider` — the seam every background job in the platform goes through. One provider is active per instance, selected with `EVER_WORKS_JOB_RUNTIME`; the rest stay loaded but inert so a hot swap stays cheap. Tenants can override the instance default from **Settings → Job Runtime** (`/settings/job-runtime`), bounded by the operator allow-list `EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS`. See [Job Runtimes](../features/job-runtimes.md).

All six declare the same capability set — `job-runtime-enqueue`, `job-runtime-cancel`, `job-runtime-status`, `job-runtime-schedule`, `job-runtime-bind-tenant` — and all six ship as `core` (bundled in every image). `job-runtime-node` additionally declares `job-runtime-worker-host`.

| Plugin ID              | `EVER_WORKS_JOB_RUNTIME` | Broker               | Peer dependency the operator installs      | Per-tenant isolation                                           |
| ---------------------- | ------------------------ | -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `job-runtime-trigger`  | `trigger`                | Trigger.dev (push)   | `@trigger.dev/sdk`                         | Per-tenant `projectAccessToken`                                |
| `job-runtime-bullmq`   | `bullmq`                 | Redis                | `bullmq`, `ioredis`                        | Redis `queuePrefix` per tenant                                 |
| `job-runtime-pgboss`   | `pgboss`                 | Postgres             | `pg-boss`                                  | Postgres schema per tenant                                     |
| `job-runtime-temporal` | `temporal`               | Temporal             | `@temporalio/client`, `@temporalio/worker` | Temporal namespace per tenant                                  |
| `job-runtime-inngest`  | `inngest`                | Inngest (serverless) | `inngest`                                  | Per-tenant `eventKey` + `signingKey`                           |
| `job-runtime-node`     | `node`                   | Your enrolled Fleet  | none                                       | Structural — the lease query only returns the owner's own work |

**Environment variables by runtime:**

| Runtime    | Variables                                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`  | `TRIGGER_SECRET_KEY` (prod `tr_prod_*`), `TRIGGER_PROJECT_REF`, optional `TRIGGER_API_URL` for self-hosted                                                                                            |
| `bullmq`   | `BULLMQ_REDIS_URL`, `BULLMQ_QUEUE_PREFIX`                                                                                                                                                             |
| `pgboss`   | `PGBOSS_CONNECTION_STRING`, `PGBOSS_SCHEMA`                                                                                                                                                           |
| `temporal` | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TLS_CERT` + `TEMPORAL_TLS_KEY` (mTLS recommended)                                                                                                 |
| `inngest`  | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                                                                                                                                                            |
| `node`     | `FLEET_NODE_API_URL`, `FLEET_NODE_LEASE_TTL_SECONDS`, `FLEET_NODE_REQUIRED_CAPABILITIES`, `FLEET_NODE_AGENT_TASK_COMMAND`, `FLEET_NODE_AGENT_TASK_WORKSPACE`, `FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH` |

None of the plugin packages depend on their broker SDK: operators pin and inject the real dispatchers themselves, and the shipped defaults are throwing stubs so a half-configured deployment fails loudly at first dispatch instead of silently dropping work. `job-runtime-trigger` and `job-runtime-inngest` keep `startWorkerHost` a deliberate no-op — both are push/serverless models where the vendor invokes your deployed code, so there is no worker process to start.

**The `node` runtime — the queue is the fleet.** Instead of an external broker, `enqueue` writes a lease-able `fleet_jobs` row and the machines you enrolled in [Fleet](../features/fleet.md) poll for it over the same outbound-only HTTP channel enrollment and heartbeat already use — no inbound port is ever opened on a user's machine.

```mermaid
flowchart LR
    Q[queued] -->|lease| L[leased]
    L -->|job heartbeat| R[running]
    R -->|complete| D[done]
    R -->|error, attempts spent| F[failed]
    L -->|lease expiry| Q
    R -->|lease expiry| Q
```

A lease is a **deadline, not a lock**: if a node dies mid-job nothing has to notice, because `leaseExpiresAt` passes and the work returns to the pool (or fails once the attempt budget is spent). Claiming is a conditional `UPDATE` pinned to `status = 'queued'`, so two nodes racing the same row produce exactly one winner. `JobEnqueueOptions.tags` entries prefixed `cap:` become real scheduling requirements — a node may only lease a job whose every required tag is in its advertised capability set — while ordinary tags stay observability labels and never narrow eligibility. `registerSchedules` is intentionally a no-op: recurrence belongs to the platform cron, because anchoring a wall-clock schedule to intermittently-online machines would elect "whichever node happened to be awake" as the only one that ever fires.

## Secret Stores

Secret-store plugins implement the `secret-store-resolve` capability. They turn an opaque `credentialsSecretRef` pointer stored on a tenant row into a plaintext credential bag at the moment a job runtime needs it, so no third-party credential is ever persisted in the platform database. All seven ship as `core`. The defaults `inline:` and `env:` need no plugin at all — they are handled in-process by `packages/agent/src/tasks/in-process-secret-store-resolver.service.ts`. See [Secret Stores](../features/secret-stores.md).

Each plugin claims exactly one pointer scheme and **fails open** — an unrecognised scheme or any error returns `null` with a warning rather than throwing.

| Plugin ID                | Backend             | Pointer format                                       | Example                                  |
| ------------------------ | ------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `secret-store-vault`     | HashiCorp Vault KV  | `vault:<path after /v1/>`                            | `vault:secret/data/tenants/acme/trigger` |
| `secret-store-k8s`       | Kubernetes Secrets  | `k8s:<name>` or `k8s:<namespace>/<name>`             | `k8s:tenant-acme-creds`                  |
| `secret-store-aws-sm`    | AWS Secrets Manager | `aws-sm:<region>/<secretName>`                       | `aws-sm:us-east-1/prod/tenants/acme`     |
| `secret-store-gcp-sm`    | GCP Secret Manager  | `gcp-sm:<projectId>/<secretName>`                    | `gcp-sm:my-project/tenant-acme`          |
| `secret-store-azure-kv`  | Azure Key Vault     | `azure-kv:<vault>/<secretName>`                      | `azure-kv:my-vault/prod-tenant-acme`     |
| `secret-store-doppler`   | Doppler             | `doppler:<project>/<config>`                         | `doppler:ever-works/prd_tenants_acme`    |
| `secret-store-infisical` | Infisical           | `infisical:<workspaceId>/<environment>/<secretPath>` | `infisical:ws-abc/prod/tenants/acme`     |

**Settings (all resolved from environment variables):**

| Plugin                   | Setting                 | Secret | Environment variable      | Description                                                                 |
| ------------------------ | ----------------------- | ------ | ------------------------- | --------------------------------------------------------------------------- |
| `secret-store-vault`     | `vaultAddr`             | No     | `VAULT_ADDR`              | Vault server URL, e.g. `https://vault.internal:8200`                        |
| `secret-store-vault`     | `vaultToken`            | Yes    | `VAULT_TOKEN`             | Token with read permission on the requested paths                           |
| `secret-store-k8s`       | `kubernetesServiceHost` | No     | `KUBERNETES_SERVICE_HOST` | In-cluster API server IP, set by the kubelet automatically                  |
| `secret-store-k8s`       | `kubernetesServicePort` | No     | `KUBERNETES_SERVICE_PORT` | In-cluster API server port, defaults to 443                                 |
| `secret-store-aws-sm`    | `awsAccessKeyId`        | No     | `AWS_ACCESS_KEY_ID`       | Omit to use the ambient AWS credential chain                                |
| `secret-store-aws-sm`    | `awsSecretAccessKey`    | Yes    | `AWS_SECRET_ACCESS_KEY`   | Omit to use the ambient AWS credential chain                                |
| `secret-store-aws-sm`    | `awsSessionToken`       | Yes    | `AWS_SESSION_TOKEN`       | For temporary STS credentials                                               |
| `secret-store-gcp-sm`    | `gcpAccessToken`        | Yes    | `GCP_ACCESS_TOKEN`        | OAuth2 access token with the `secretmanager.secretAccessor` role            |
| `secret-store-azure-kv`  | `azureKvToken`          | Yes    | `AZURE_KV_TOKEN`          | Azure AD bearer token, scope `https://vault.azure.net/.default`             |
| `secret-store-doppler`   | `dopplerToken`          | Yes    | `DOPPLER_TOKEN`           | Service Token or Service Account token with read access                     |
| `secret-store-infisical` | `infisicalToken`        | Yes    | `INFISICAL_TOKEN`         | Service Token or Machine Identity token with read access                    |
| `secret-store-infisical` | `infisicalHost`         | No     | `INFISICAL_HOST`          | Base URL for self-hosted instances; defaults to `https://app.infisical.com` |

The Vault resolver auto-detects the KV version: it tries KV v2 first (`json.data.data` is an object) and falls back to KV v1. The Kubernetes resolver reads its bearer token, CA cert and default namespace from the service-account mount at `/var/run/secrets/kubernetes.io/serviceaccount/` and base64-decodes every Secret value; running **out** of cluster it returns `null` and warns, so local development should use `inline:` instead. GCP deliberately takes a pre-fetched `GCP_ACCESS_TOKEN` rather than signing service-account JWTs itself — operators provision it out of band via Workload Identity, a refresher sidecar, or a cron.

## Utility

### Comparison Generator

Auto-generates SEO-optimized A vs B comparison pages between work items.

| Field              | Value                  |
| ------------------ | ---------------------- |
| Plugin ID          | `comparison-generator` |
| Configuration Mode | `hybrid`               |
| Auto Enable        | No                     |
| System Plugin      | Yes                    |
| Capabilities       | `form-schema-provider` |

**Settings:**

| Setting                    | Type    | Default    | Description                                                  |
| -------------------------- | ------- | ---------- | ------------------------------------------------------------ |
| `cadence_override`         | string  | `use_work` | Generation cadence: `use_work`, `daily`, `weekly`, `monthly` |
| `max_comparisons_mode`     | string  | `custom`   | `custom` or `unlimited`                                      |
| `max_comparisons`          | number  | `50`       | Max total comparisons (1–500, only used in Custom mode)      |
| `min_items_for_comparison` | number  | `3`        | Min items in category before generating (2–20)               |
| `ai_provider`              | string  | —          | Override AI provider for comparison generation               |
| `ai_model`                 | string  | —          | Override AI model for comparison generation                  |
| `custom_prompt`            | string  | —          | Additional instructions appended to comparison prompts       |
| `extended_analysis`        | boolean | `false`    | Enable deep-dive 7-section extended analysis                 |

See [Comparisons](/features/comparisons) for the full feature documentation.

### Ever Works Skills

First-party `skills-provider` capability plugin (ADR-012). Sources
the curated Skills catalog from the [`ever-works/skills`](https://github.com/ever-works/skills)
GitHub repo (per ADR-014). Ships v1 with a built-in fallback catalog
(cron-defaults / secret-handling / commit-message-style) so the
plugin works before the upstream repo is created — the platform
self-recovers when it appears.

| Field              | Value                                 |
| ------------------ | ------------------------------------- |
| Plugin ID          | `everworks-skills`                    |
| Package            | `@ever-works/everworks-skills-plugin` |
| License            | MIT (ADR-014 catalog split)           |
| Configuration Mode | `admin-only`                          |
| Auto Enable        | Yes (default `skills-provider`)       |
| Capabilities       | `skills-provider`                     |

**Settings:**

| Setting           | Type   | Default             | Description                              |
| ----------------- | ------ | ------------------- | ---------------------------------------- |
| `catalogRepo`     | string | `ever-works/skills` | GitHub owner/repo of the catalog source. |
| `catalogBranch`   | string | `main`              | Branch to read from.                     |
| `cacheTtlSeconds` | number | `3600`              | How long to cache the cloned catalog.    |

See [Skills feature](/features/skills-catalog) for the platform-side
data model + resolver + injection pipeline.

### Ever Works Task Tracker

First-party `task-tracker` capability plugin (ADR-013). Thin shim
over the platform's own DB-backed Tasks family — when this plugin
is enabled, `TasksFacadeService` routes every Task operation
through it. Community plugins (Linear / Jira / GitHub Issues) drop
in by implementing the same `ITaskTrackerPlugin` contract.

| Field              | Value                                       |
| ------------------ | ------------------------------------------- |
| Plugin ID          | `everworks-task-tracker`                    |
| Package            | `@ever-works/everworks-task-tracker-plugin` |
| License            | MIT (ADR-014 catalog split)                 |
| Configuration Mode | `admin-only`                                |
| Auto Enable        | No — declared default for `task-tracker`    |
| Distribution       | `registry`                                  |
| Capabilities       | `task-tracker`                              |

**Settings:** none — the plugin binds to the platform's DB-backed
service at boot via a runtime `setPlatformTaskBackend()` delegate.

See [Task tracking feature](/features/tasks) for the full
data model + state machine + chat thread + recurrence pipeline.

### Agent Memory

First-party implementation of the `agent-memory` capability. Talks to a standalone [`agentmemory`](https://github.com/rohitg00/agentmemory) REST server — the same one Claude Code, Codex, OpenCode and MCP clients already use — so one memory store can be shared across every agent an operator runs. The `AgentMemoryFacadeService` dispatches to whichever `agent-memory` plugin the user or Work has resolved.

| Field        | Value          |
| ------------ | -------------- |
| Plugin ID    | `agentmemory`  |
| Category     | `utility`      |
| Auto Enable  | No             |
| Distribution | `registry`     |
| Capabilities | `agent-memory` |

**Settings:**

| Setting     | Type   | Scope | Default                 | Environment variable   | Description                                                                                                   |
| ----------- | ------ | ----- | ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `baseUrl`   | string | user  | `http://localhost:3111` | `AGENTMEMORY_BASE_URL` | REST endpoint of the agentmemory server                                                                       |
| `apiKey`    | string | user  | —                       | `AGENTMEMORY_API_KEY`  | Bearer token (secret). Must match the server's `AGENTMEMORY_SECRET`; empty is fine for a localhost dev server |
| `projectId` | string | work  | `ever-works`            | `AGENTMEMORY_PROJECT`  | Namespace sent as `project` on every request                                                                  |
| `timeoutMs` | number | user  | `30000`                 | —                      | Per-request timeout                                                                                           |

**Three ways to run the backend, same plugin code:**

| Mode                   | When                                                       | Setup                                                                                                               |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Local dev              | Hacking on Ever Works on a laptop                          | `npx @agentmemory/agentmemory` in a second terminal — the default `baseUrl` already points at it                    |
| Self-hosted in cluster | Platform and memory store in the same Kubernetes namespace | Apply `.deploy/k8s/agentmemory.optional.yaml` and set `baseUrl` to `http://agentmemory.<ns>.svc.cluster.local:3111` |
| Hosted                 | You already run agentmemory elsewhere                      | Set `baseUrl` to the HTTPS endpoint and `apiKey` to the server's `AGENTMEMORY_SECRET`                               |

The plugin uses only the documented REST subset — `/agentmemory/health` (which also drives `validateConnection`), `/session/start`, `/session/end`, `/remember`, `/smart-search`, `/context`, and `/forget` for governance deletes. See [Memory](../features/memory.md).

### Memory Pipeline Modifier

A `pipeline-modifier` plugin that injects two steps into whatever pipeline a Work runs: one at the start that fetches prior agent-memory context, and one at the end that saves a digest of what was generated. That is what makes consecutive generation runs build on each other instead of starting cold. Requires an `agent-memory` provider to be enabled.

| Field        | Value                      |
| ------------ | -------------------------- |
| Plugin ID    | `memory-pipeline-modifier` |
| Category     | `utility`                  |
| Auto Enable  | No                         |
| Distribution | `registry`                 |
| Capabilities | `pipeline-modifier`        |

**Settings** (all work-scoped):

| Setting            | Type    | Default           | Description                                                                                                |
| ------------------ | ------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `enabled`          | boolean | `false`           | Inject the memory hooks into this Work's pipeline                                                          |
| `purpose`          | string  | `work-generation` | Hint passed to the memory backend to bias retrieval, e.g. `fix-bug` or `research`                          |
| `maxContextTokens` | number  | —                 | Upper bound on the injected memory context payload (100–32000)                                             |
| `saveSummary`      | boolean | `true`            | Let the last pipeline step save a short observation about what was generated so the next run can recall it |

The injected step ids are `memory-fetch-context` and `memory-save`.

### Local Workspace

The `workspace` provider for self-hosted and desktop installs. Maintains a pool of real `git worktree` checkouts on the host so an Agent task gets an isolated working tree without a fresh clone every time. Each worktree carries a binding stamp written **inside** the gitdir, so it can never be committed and never appears in the working tree. See [Task Isolation](../features/task-isolation.md).

| Field         | Value             |
| ------------- | ----------------- |
| Plugin ID     | `local-workspace` |
| Category      | `utility`         |
| Auto Enable   | No                |
| System Plugin | Yes               |
| Distribution  | `core`            |
| Capabilities  | `workspace`       |

**Settings** (all hidden/advanced):

| Setting          | Type   | Default                                | Description                                         |
| ---------------- | ------ | -------------------------------------- | --------------------------------------------------- |
| `baseDir`        | string | `EW_WORKSPACES_DIR` or the OS temp dir | Directory the worktree pool lives under             |
| `fetchDepth`     | number | `1`                                    | Shallow fetch depth for the base-ref fetch (1–1000) |
| `committerName`  | string | `Ever Works Agent`                     | Commit author name                                  |
| `committerEmail` | string | `agent@ever.works`                     | Commit author email                                 |

### Sandbox Workspace

The cloud-default `workspace` provider. Runs plain `git` in an ephemeral job sandbox: every provision is a fresh shallow clone and the **remote** task branch is the durable identity, so a re-run fetches the pushed branch instead of re-cutting it and nothing is lost when the sandbox evaporates.

| Field         | Value               |
| ------------- | ------------------- |
| Plugin ID     | `sandbox-workspace` |
| Category      | `utility`           |
| Auto Enable   | Yes                 |
| System Plugin | Yes                 |
| Distribution  | `core`              |
| Capabilities  | `workspace`         |

Settings are identical to Local Workspace (`baseDir`, `fetchDepth`, `committerName`, `committerEmail`). The checkout's `origin` remote is always token-free: credentials arrive per operation and are injected into the URL of that single command invocation only — never written into git config, the stamp file, or the working tree, because the checkout runs untrusted repository code. Tokens are scrubbed from every error message before it can reach a log.

### PTY Local

Backs the streaming **Terminal** tab on an Agent's detail page. Implements `terminal-stream` by spawning a local pseudo-terminal and relaying it to attached viewers, with driver and viewer roles enforced by `apps/api/src/terminal/terminal-attach.controller.ts` (`/api/agents/:id/runs/:runId/terminal`). See [Agent Terminals](../features/agent-terminals.md).

| Field        | Value             |
| ------------ | ----------------- |
| Plugin ID    | `pty-local`       |
| Category     | `utility`         |
| Auto Enable  | No                |
| Capabilities | `terminal-stream` |

**Settings:**

| Setting       | Type   | Description                                              |
| ------------- | ------ | -------------------------------------------------------- |
| `defaultCols` | number | Initial terminal width before the client sends a resize  |
| `defaultRows` | number | Initial terminal height before the client sends a resize |

`node-pty` is loaded as a runtime require rather than a static import, so a worker image without the native prebuild degrades instead of crashing at module load.

### Browser Automation

Headless Chromium automation via Playwright, behind a **default-deny** navigation allowlist that is re-checked on every redirect hop. Exposes exactly four verbs so an Agent can research a page it cannot simply fetch.

| Field        | Value                |
| ------------ | -------------------- |
| Plugin ID    | `browser-automation` |
| Category     | `utility`            |
| Auto Enable  | No                   |
| Distribution | `registry`           |
| Capabilities | `browser-automation` |

| Verb         | Purpose                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| `navigate`   | Go to a URL; returns the final URL, HTTP status, title and the full redirect chain     |
| `extract`    | Pull `text` / `html` / `attribute` values out of the rendered DOM by CSS selector      |
| `screenshot` | Capture the viewport, the full page, or one element as base64 PNG or JPEG              |
| `act`        | Run a bounded ordered list of `click` / `fill` / `select` / `press` / `hover` / `wait` |

**Settings:**

| Setting               | Type    | Default       | Description                                                                                                                                                                 |
| --------------------- | ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedHosts`        | array   | `[]`          | The navigation allowlist. **Empty refuses every navigation.** Falls back to `PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS` (comma-separated)                                     |
| `timeoutMs`           | number  | `30000`       | Wall-clock budget for navigation and each action, clamped to 1000–120000                                                                                                    |
| `headless`            | boolean | `true`        | Leave on for any server runtime                                                                                                                                             |
| `subresourcePolicy`   | string  | `public-only` | `public-only` lets a page load assets from any public host while still blocking internal targets; `allowlist` restricts assets too                                          |
| `allowPrivateNetwork` | boolean | `false`       | Advanced escape hatch for internal staging hosts. Requires an explicit host list — the `*` entry is dropped while it is on, so it can never open the whole internal network |
| `executablePath`      | string  | —             | Absolute path to a Chromium binary; empty uses the Playwright-managed browser                                                                                               |
| `channel`             | string  | —             | Optional Playwright channel (`chrome`, `msedge`) instead of the bundled Chromium                                                                                            |

**Allowlist syntax:**

| Pattern            | Matches                                                         |
| ------------------ | --------------------------------------------------------------- |
| `example.com`      | that host exactly (**not** its subdomains), on any port         |
| `*.example.com`    | any subdomain, but **not** the apex                             |
| `example.com:8443` | that host, only on port 8443                                    |
| `*`                | any **public** host — private and internal targets stay blocked |

Anything else (a scheme, a path, an `@`, an embedded wildcard) is rejected as a configuration error rather than interpreted loosely. Refusals throw `BrowserNavigationBlockedError` with a stable code: `invalid_url`, `scheme_blocked`, `credentials_in_url`, `private_address`, `not_allowlisted`, `dns_private_ip`, or `dns_lookup_failed`. The SSRF guard sits underneath the allowlist, so an allowlisted hostname that _resolves_ to `127.0.0.1` is still refused — a DNS-rebinding defence. Sessions opened with `open()` must be released with `close()`; the last close shuts the shared browser down.

## How to enable and configure a plugin

1. Open **Settings → Plugins** (`/settings/plugins`) and pick the category tab — the URL is `/settings/plugins/<category>`, e.g. `/settings/plugins/ai-provider`, `/settings/plugins/storage`, `/settings/plugins/connector`.
2. Toggle the plugin **on**. Plugins with `configurationMode: user-required` stay inactive until their required settings are filled; `admin-only` plugins are configured by an instance administrator; `hybrid` plugins accept either environment variables or per-user settings.
3. Fill the settings form. Fields marked secret are encrypted at rest and rendered masked; fields with an environment-variable fallback show the resolved value when the env var is set, so you can leave them blank on a self-hosted instance.
4. Use the plugin's **Test / Verify** action where one exists — notification channels have **Send test** (`POST /api/notification-channels/:id/test`), and any plugin can be probed with `POST /api/plugins/:pluginId/validate-connection` or read back from `GET /api/plugins/:pluginId/connection-status`. `GET /api/plugins` lists every discovered plugin with its manifest and health.
5. Set a capability default where the platform needs one winner (AI provider, search, pipeline, storage, vector store, task tracker). Per-Work overrides live on the Work's own plugins page at `/works/:id/plugins`, backed by `POST /api/works/:workId/plugins/:pluginId/capability`.
6. From the CLI: `ever-works plugins catalog` lists what is installable, `ever-works plugins install <id>` pulls a distributable plugin (optionally `--version` and `--integrity sha512-…`), `ever-works plugins install-status <id>` reports the per-replica installer state, and `ever-works plugins uninstall <id>` removes it. See [CLI Quickstart](../guides/cli-quickstart.md).

## Related

- [Plugin System Overview](./index.md) · [Architecture](./architecture.md) · [Settings & Configuration](./settings.md)
- [Plugin Categories & Capabilities](./plugin-categories.md) · [Creating a Plugin](./creating-a-plugin.md) · [Plugin API Reference](./api-reference.md)
- Feature guides: [Plugins](../features/plugins.md) · [Storage Backends](../features/storage-backends.md) · [Secret Stores](../features/secret-stores.md) · [Job Runtimes](../features/job-runtimes.md) · [Connectors](../features/connectors.md) · [Notifications](../features/notifications.md) · [Goals](../features/goals.md)
- Deployment: [Kubernetes Deployment](../features/k8s-deployment.md) · [Managed Hosting](../features/managed-hosting.md) · [Custom Domains](../features/custom-domains.md)
