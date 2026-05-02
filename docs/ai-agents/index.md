---
id: index
title: AI & Generation
sidebar_label: AI Overview
sidebar_position: 1
---

# AI & Generation

The Ever Works Platform uses AI services to power work content generation, enrichment, and conversational features. AI providers are implemented as [plugins](/plugin-system) and routed through the `AiFacadeService`.

## Providers

AI providers are managed through the [plugin system](/plugin-system). Each provider is a plugin that implements the `ai-provider` capability. The platform ships with 8 AI provider plugins:

| Provider          | Plugin ID           | Default Model                               | Configuration              |
| ----------------- | ------------------- | ------------------------------------------- | -------------------------- |
| OpenAI            | `openai`            | `gpt-5.1`                                   | User API key               |
| Anthropic         | `anthropic`         | `claude-sonnet-4-5-20250514`                | User API key               |
| Google Gemini     | `google`            | `models/gemini-2.5-flash`                   | User API key               |
| Groq              | `groq`              | `meta-llama/llama-4-scout-17b-16e-instruct` | User API key               |
| Mistral           | `mistral`           | `mistral-small-latest`                      | User API key               |
| Ollama            | `ollama`            | `llama2`                                    | Local (no key)             |
| OpenRouter        | `openrouter`        | `openai/gpt-5.1`                            | Hybrid (admin or user key) |
| Vercel AI Gateway | `vercel-ai-gateway` | configurable                                | Hybrid                     |

### Provider Capabilities

All providers support chat completions and structured output. Additional capabilities vary:

| Provider      | Streaming | Tool Calling | Vision | Embeddings |
| ------------- | :-------: | :----------: | :----: | :--------: |
| OpenAI        |    Yes    |     Yes      |  Yes   |    Yes     |
| Anthropic     |    Yes    |     Yes      |  Yes   |     No     |
| Google Gemini |    Yes    |     Yes      |  Yes   |    Yes     |
| Groq          |    Yes    |     Yes      |   No   |     No     |
| Mistral       |    Yes    |     Yes      |  Yes   |     No     |
| Ollama        |    Yes    |     Yes      |   No   |     No     |
| OpenRouter    |    Yes    |     Yes      |   No   |     No     |

### Configuration

Providers are configured through the plugin settings UI or environment variables. Each work can use a different AI provider.

See [Built-in Plugins — AI Providers](/plugin-system/built-in-plugins#ai-providers) for complete configuration details for each provider.

## Structured Output

The AI service supports structured output via Zod schemas through LangChain's `withStructuredOutput()`. This is used throughout the generation pipeline to get typed, validated responses from LLMs.

## Generation Pipelines

The platform supports three generation pipelines, each implemented as a plugin. Works can select which pipeline to use.

| Pipeline              | Plugin ID           | Approach                                              | Best For                                                        |
| --------------------- | ------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| **Standard Pipeline** | `standard-pipeline` | 15-step structured pipeline with LangChain            | Full control, configurable steps, web search + AI extraction    |
| **Agent Pipeline**    | `agent-pipeline`    | Autonomous AI agent with tool calling (Vercel AI SDK) | Flexible, autonomous research with minimal configuration        |
| **Claude Code**       | `claude-code`       | Claude Code CLI subprocess                            | Leverages Claude Code's built-in web search and code generation |

All pipelines are orchestrated by the `PipelineOrchestratorService` with checkpoint/resume support.

### Standard Pipeline

The default pipeline runs a **15-step process** organized into 8 phases:

| Phase                  | Steps                                                                       | Description                                          |
| ---------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Initialization**     | Prompt Comparison, Prompt Processing, Domain Detection                      | Validate prompt, extract subject, detect domain type |
| **Content Generation** | AI First Items Generation                                                   | Generate initial items using AI knowledge            |
| **Web Search**         | Search Queries Generation, Web Search, Content Retrieval, Content Filtering | Discover and fetch relevant web pages                |
| **Extraction**         | Items Extraction                                                            | Extract structured items from web content            |
| **Aggregation**        | Deduplication and Data Aggregation                                          | Merge AI and web items, remove duplicates            |
| **Categorization**     | Categories and Tags Processing, Sources Validation                          | Assign categories/tags, validate source URLs         |
| **Enrichment**         | Badges Processing, Image Capture                                            | Evaluate badges, capture screenshots                 |
| **Output**             | Markdown Generation                                                         | Generate markdown descriptions from source content   |

The pipeline uses plugins for each external operation — the active search plugin for web research, the active AI provider for content generation, the active content extractor for page parsing, and the active screenshot plugin for image capture.

### Agent Pipeline

The Agent Pipeline uses the Vercel AI SDK's `generateText` with tool calling to autonomously research and generate work items. It has a parent/worker model architecture:

- **Parent model** (complex model) — orchestrates the research, decides which tools to call
- **Worker model** (default model) — handles content extraction from URLs

The agent has access to tools for web search, URL processing, item management, and progress reporting. It includes a circuit breaker for tool failure isolation and context compaction for managing token budgets.

**5 steps:** Prepare Context, Generate Items, Collect Results, Capture Screenshots, Cleanup.

### Claude Code Pipeline

The Claude Code Pipeline downloads the Claude Code CLI binary, creates a temporary workspace seeded with existing work data, then runs Claude Code as a subprocess to research and generate items. It requires either an OAuth token or Anthropic API key.

**6 steps:** Setup Claude Code, Prepare Context, Generate Items, Collect Results, Capture Screenshots, Cleanup.

See [Built-in Plugins — Pipeline](/plugin-system/built-in-plugins#pipeline) for configuration details for each pipeline.

## Model Router

For cost optimization, the platform includes a **model router** that assigns tasks to different model tiers based on complexity. See [Model Router](/ai-agents/model-router) for details.
