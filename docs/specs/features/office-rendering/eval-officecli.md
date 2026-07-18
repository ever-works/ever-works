# Evaluation: OfficeCLI as an optional office-document plugin

**Status:** Evaluation · **Date:** 2026-07-18 · **Owner:** Platform
**Decision:** Adopt as an **optional, off-by-default** plugin — pending one pre-ship gate.

## Question

Can we use [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) to render/extract Office
documents (`.docx`, `.xlsx`, `.pptx`) inside the Wiki / Memory feature, activatable as a
plugin?

## Findings

- **What it is:** an "Office suite for AI agents" — reads/writes/renders `.docx`/`.xlsx`/`.pptx`
  with no Office/LibreOffice install. Render modes: `html` (assets inlined), `screenshot` (PNG
  per page), `svg`, `pdf` (export), plus `text`/`outline`/`stats`/JSON element data. **PDF is
  output-only — it does not read PDF** (so zero overlap with our existing `pdf-extractor`).
- **License:** **Apache-2.0** (verified from the raw `LICENSE`, not just the badge). One-way
  compatible into our AGPLv3 platform; fine for our MIT plugins since we invoke a **separate
  native binary as a subprocess** (tool dependency, like shelling out to `git`) rather than
  linking source. Only obligation: preserve the `NOTICE`/attribution when redistributing the
  binary. No dual-license / paid tier.
- **Runtime:** C#/.NET, shipped as a **self-contained native binary** (runtime embedded).
  Distributed on npm as `@officecli/officecli` (thin wrapper that downloads the platform-native
  binary on install; npm `os: [darwin, linux, win32]`, `cpu: [x64, arm64]`) and an official
  Node SDK `@officecli/sdk` (resident mode over a named pipe). Per our "prefer vendor SDKs"
  rule (NN #22), favor `@officecli/sdk` over spawning the CLI directly.

## The one blocking unknown — Alpine/musl artifact

Our Docker base is `node:22-alpine` (**musl**). A self-contained .NET binary needs a
`linux-musl-x64` / `linux-musl-arm64` build. npm's `os: linux` does **not** distinguish musl
from glibc. **Pre-ship gate:** verify a musl artifact exists — check the GitHub release assets
at <https://github.com/iOfficeAI/OfficeCLI/releases> for a `linux-musl-*` asset, or run the
install + a smoke `officecli view sample.docx text` inside a `node:22-alpine` container. If no
musl build ships, do **not** bake it into the image.

## Decision

1. **Adopt as an optional `content-extractor` plugin** (`@ever-works/officecli-extractor-plugin`),
   `systemPlugin: false`, `autoEnable: false`, `isDefault: false` — mirrors `pdf-extractor`.
   It covers **docx/xlsx/pptx text extraction**, which no current extractor handles, feeding
   the Memory/RAG index. Reuses the SSRF-guard + byte-cap pattern already in `pdf-extractor`
   (source URLs can be untrusted, e.g. community PRs).
2. **The high-fidelity visual render path** (pptx/xlsx → HTML/PNG, OfficeCLI's real
   differentiator) is a **separate, new capability** — an "office-viewer" for showing a doc in
   the Wiki — and should NOT be forced into the text-returning `content-extractor` contract.
   Ship the extractor first; add a render capability later if the Memory UI wants inline
   previews.
3. **Fallbacks if the musl gate fails or the ~native-binary heft is unacceptable:**
   - Text path: `mammoth` (docx→html, MIT) + `SheetJS` (xlsx, Apache-2.0) + an `officeparser`
     for pptx — a fraction of the footprint, pure-JS, no Alpine risk.
   - Render path: **Gotenberg** (LibreOffice-in-a-container, Apache-2.0, HTTP API) as a sidecar
     — keeps the heavy dependency out of the API image entirely.

## Plugin shape (content-extractor path)

```
class OfficeCliExtractorPlugin implements IPlugin, IContentExtractorPlugin {
  category = 'content-extractor';
  capabilities = ['content-extractor'];
  systemPlugin = false; isDefault = false; autoEnable = false;
  canExtract(url)  → /\.(docx|xlsx|pptx)$/i.test(pathname)   // complements pdf-extractor's \.pdf$
  extract(opts)    → ssrf-guard(url) → download (cap bytes, re-check on redirect)
                   → @officecli/sdk open() → { success, markdown, title, wordCount, readingTime }
  getSupportedFormats() → ['text','markdown','html']
}
```
Settings: `renderMode` (text|html), `maxBytes`, `timeout`, `binaryPath`.

## Recommendation

**Yes — prototype the content-extractor plugin, gated behind Enable**, but **run the musl gate
before wiring it into any image build.** If musl fails, fall back to `mammoth`+`SheetJS` for
text and Gotenberg for render. This complements `pdf-extractor` with zero format overlap and is
fully additive.
