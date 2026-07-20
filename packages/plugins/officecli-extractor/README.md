# @ever-works/officecli-extractor-plugin

OfficeCLI Content Extractor - Extract text from Office documents (`.docx` / `.xlsx` / `.pptx`) using the [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) tool.

## Plugin metadata

| Field         | Value                 |
| ------------- | --------------------- |
| ID            | `officecli-extractor` |
| Category      | `content-extractor`   |
| Capabilities  | `content-extractor`   |
| Author        | Ever Works Team       |
| License       | AGPL-3.0              |
| Built-in      | yes                   |
| System plugin | no                    |
| Default       | no                    |
| Auto-enable   | no                    |

## What does the OfficeCLI Extractor do?

This plugin extracts text content from Office documents (Word `.docx`, Excel `.xlsx`, PowerPoint `.pptx`) and converts it to clean text or markdown for use as source material during work generation. It delegates to the OfficeCLI tool via its official Node SDK (`@officecli/sdk`).

It is **optional and off by default** — enable it only when you need Office extraction. It complements the PDF extractor (`.pdf`) and has zero URL overlap with it.

## Why use it?

- **Use Office documents as source material** — process content from reports, spreadsheets, and slide decks
- **Optional and off by default** — enabled per-work only when you need it
- **Text or markdown output** — choose the render mode that best fits your workflow
- **Runs on Alpine/musl** — OfficeCLI ships musl binaries (`officecli-linux-alpine-x64/arm64`), so it runs on the platform's `node:22-alpine` base image

## How it works in Ever Works

When a source URL points to an Office document (`.docx` / `.xlsx` / `.pptx`), the content extractor facade delegates to this plugin. It downloads the document (behind an SSRF guard and a byte cap), writes it to a private temp file, opens it with OfficeCLI, forwards a single content command, and returns the extracted text. The temp file and the OfficeCLI resident are always cleaned up.

## Getting started

1. Enable the OfficeCLI Content Extractor plugin on this page
2. Choose a render mode (text or markdown) in the settings below
3. Add Office document URLs as source material when generating your work

## Settings

- **Render Mode** (`renderMode`) — output format, `text` (default) or `markdown`.
- **Max Download Size** (`maxBytes`) — maximum document size to download and process, in bytes. Default `26214400` (25 MB). Also overridable via the `OFFICECLI_EXTRACTOR_MAX_BYTES` environment variable.
- **Request Timeout** (`timeout`) — HTTP download + OfficeCLI command timeout in ms, default `30000`, range 5000–300000 (hidden).
- **OfficeCLI Binary Path** (`binaryPath`) — optional absolute path to a specific `officecli` binary; leave blank to use the bundled binary (hidden).

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/officecli-extractor-plugin build
pnpm --filter @ever-works/officecli-extractor-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)

## Third-party attribution (OfficeCLI — Apache-2.0)

This plugin redistributes and invokes the **OfficeCLI** binary and Node SDK
(`@officecli/officecli`, `@officecli/sdk`), which are licensed under the
**Apache License, Version 2.0**. As required by Apache-2.0 §4, the following
attribution is preserved:

```
OfficeCLI
Copyright (c) iOfficeAI (https://github.com/iOfficeAI/OfficeCLI)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

- Upstream project: <https://github.com/iOfficeAI/OfficeCLI>
- Full license text: <https://www.apache.org/licenses/LICENSE-2.0>

The Ever Works plugin wrapper itself is licensed under AGPL-3.0 (see below); the
Apache-2.0 terms above apply only to the bundled OfficeCLI components.

## License

AGPL-3.0
