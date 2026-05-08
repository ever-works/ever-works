# @ever-works/pdf-extractor-plugin

PDF Content Extractor - Extract text from PDFs with OCR fallback via Mistral AI

## Plugin metadata

| Field        | Value               |
| ------------ | ------------------- |
| ID           | `pdf-extractor`     |
| Category     | `content-extractor` |
| Capabilities | `content-extractor` |
| Author       | Ever Works Team     |
| License      | AGPL-3.0            |
| Built-in     | yes                 |
| Auto-enable  | no                  |

## What does the PDF Extractor do?

This plugin extracts text content from PDF files and converts it to clean markdown for use as source material during work generation. It uses a hybrid approach: fast text-layer extraction for text-based PDFs, with optional OCR fallback via Mistral AI for scanned or image-based documents.

## Why use it?

- **Use PDFs as source material** — extract content from research papers, reports, and documentation
- **No API key required for text PDFs** — text-layer extraction works out of the box
- **OCR for scanned documents** — optionally configure a Mistral AI key for image-based PDFs
- **Smart detection** — automatically determines if a PDF needs OCR based on text density

## How it works in Ever Works

When a source URL points to a PDF file (.pdf extension), the content extractor facade delegates to this plugin instead of the default extractor. It downloads the PDF, extracts text from the text layer, and if the text density is too low (indicating a scanned document), falls back to Mistral OCR if an API key is configured.

## Getting started

1. Enable the PDF Content Extractor plugin on this page
2. For text-based PDFs, no additional configuration is required
3. For scanned/image-based PDFs, get a Mistral AI API key from [console.mistral.ai](https://console.mistral.ai) and enter it in the settings below
4. Add PDF URLs as source material when generating your work

## Settings

- **Mistral API Key** (`mistralApiKey`) — optional, secret, user-scoped. Required only for OCR fallback on scanned/image-based PDFs. Backed by env var `PLUGIN_PDF_EXTRACTOR_API_KEY`.
- **OCR Model** (`ocrModel`) — Mistral OCR model ID, default `mistral-ocr-latest` (hidden).
- **Text Density Threshold** (`textDensityThreshold`) — characters per page below which OCR is triggered, default `100` (hidden).
- **Max Pages** (`maxPages`) — maximum pages to process, default `50`, range 1–500 (hidden).
- **Request Timeout** (`timeout`) — HTTP timeout in ms, default `60000`, range 5000–300000 (hidden).

## Troubleshooting

| Symptom                                        | Likely cause                                                                                     | Fix                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `403` from the extractor               | API key / token missing or revoked                                                               | Re-enter the credential from the PDF Content Extractor dashboard, or set `PLUGIN_PDF_EXTRACTOR_API_KEY` in the host environment for default fallback                      |
| `Failed to extract content` for a specific URL | Page requires authentication, JavaScript rendering, or a custom client (Notion, PDF, login wall) | Verify the URL is publicly reachable; if it requires JavaScript/auth, switch to a more capable extractor (`scrapfly` / `notion-extractor` / `pdf-extractor`) for that URL |
| Plugin not used during extraction              | Another content-extractor plugin is set as the default                                           | In **Settings → Plugins**, set `pdf-extractor` as the default for `content-extractor`, or disable competing plugins                                                       |
| Garbled / empty text from a scanned PDF        | PDF is image-only; this extractor does not OCR                                                   | Pre-process the PDF through OCR (e.g. `ocrmypdf`) before passing the URL, or use a service that includes OCR                                                              |
| `healthCheck` reports unhealthy                | Credential invalid OR PDF Content Extractor endpoint unreachable from the host                   | Verify the credential with a manual call to the upstream API and confirm outbound HTTPS is allowed by the firewall                                                        |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/pdf-extractor-plugin build
pnpm --filter @ever-works/pdf-extractor-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Mistral AI console](https://console.mistral.ai)

## License

AGPL-3.0
