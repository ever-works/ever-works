# @ever-works/google-plugin

Google Gemini AI provider plugin for Ever Works platform

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `google`        |
| Category     | `ai-provider`   |
| Capabilities | `ai-provider`   |
| Author       | Ever Works Team |
| License      | MIT             |
| Built-in     | yes             |
| Auto-enable  | no              |

## What is the Google Gemini plugin?

This plugin connects Ever Works to Google's Gemini models. Gemini provides a strong balance of speed, cost, and output quality, with support for exceptionally long documents and built-in embedding models for semantic search.

## Why use it?

- **Extended context window** — Gemini supports up to 1 million tokens, ideal for processing large volumes of source material
- **Embedding support** — Google's text-embedding models enable semantic search within your works
- **Cost-efficient performance** — Gemini Flash models deliver strong results at a low per-token cost
- **Vision capabilities** — analyze images and screenshots as part of content generation

## How it works in Ever Works

When selected as the AI provider, Gemini handles content generation during work creation, powers the conversational AI assistant, and produces text embeddings for semantic search. Gemini Flash is well-suited for simple pipeline tasks, while Gemini Pro handles complex content generation.

## Getting started

1. Obtain an API key from [Google AI Studio](https://aistudio.google.com/apikey)
2. Enable the Google Gemini plugin on this page
3. Enter your API key in the settings below
4. Select your preferred Gemini models for each task complexity level

## Settings

- **Google AI API Key** — connects to Google Gemini for content generation and chat (secret, per-user).
- **Default Model** — used for all AI tasks unless a tier-specific model is set.
- **Simple Tasks Model** — handles tags, short descriptions, and quick classifications.
- **Standard Tasks Model** — handles listings, summaries, and content reformatting.
- **Complex Tasks Model** — handles full page generation and multi-step analysis.
- **Base URL** — custom API endpoint for proxies or compatible services (hidden, advanced).
- **Temperature** — controls output variety; lower is more consistent (hidden, advanced).
- **Max Tokens** — limits the length of each AI-generated response (hidden, advanced).

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/google-plugin build
pnpm --filter @ever-works/google-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Google Gemini homepage](https://ai.google.dev)

## License

MIT
