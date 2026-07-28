# @ever-works/browser-automation-plugin

Headless browser automation for Ever Works — navigate, extract, screenshot and act on web pages via Playwright, behind a default-deny navigation allowlist that is re-checked on every redirect hop.

## Plugin metadata

| Field        | Value                 |
| ------------ | --------------------- |
| ID           | `browser-automation`  |
| Category     | `utility`             |
| Capabilities | `browser-automation`  |
| Provider     | Playwright (Chromium) |
| Author       | Ever Works Team       |
| License      | AGPL-3.0              |
| Built-in     | yes                   |

## What it does

Drives a headless Chromium and exposes exactly four verbs through the `browser-automation` capability:

| Verb         | Purpose                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `navigate`   | Go to a URL; returns the final URL, HTTP status, title and the **full redirect chain** |
| `extract`    | Pull `text` / `html` / `attribute` values out of the rendered DOM by CSS selector      |
| `screenshot` | Capture the viewport, the full page, or one element as base64 PNG/JPEG                 |
| `act`        | Run a bounded ordered list of `click` / `fill` / `select` / `press` / `hover` / `wait` |

Sessions are opened with `open()` and **must** be released with `close()`. The last closed session shuts the shared browser down.

## Security posture

A headless browser reachable from server-side code is an SSRF engine with a JavaScript runtime attached. The following are enforced by the plugin, not by convention:

- **Headless by default.** Only an explicit `headless: false` in settings produces a headed browser.
- **Default-deny allowlist.** An empty `allowedHosts` refuses **every** navigation. There is no implicit "allow anything" path.
- **Redirects are re-checked on every hop.** A Playwright route guard aborts any document request outside the allowlist, and a post-navigation audit walks the `redirectedFrom()` chain — a hop that somehow got through still fails the call rather than returning attacker-controlled content. The final landing URL is verified too, including after an `act()` step navigates.
- **SSRF guard underneath the allowlist.** Private, loopback, link-local, CGNAT and cloud-metadata targets (including `169.254.169.254` and its DNS aliases) are refused on both the literal URL and the DNS resolution, so an allowlisted hostname that *resolves* to `127.0.0.1` is refused (DNS-rebinding defence).
- **Fail closed.** An unresolvable host, an unparseable resolved address, and a URL carrying embedded `user:password@` credentials are all refusals — never optimistic retries.
- **Configurable timeout** applied to navigation and to every action, clamped to 1 000–120 000 ms.

Every refusal throws `BrowserNavigationBlockedError` with a stable `code`: `invalid_url`, `scheme_blocked`, `credentials_in_url`, `private_address`, `not_allowlisted`, `dns_private_ip`, `dns_lookup_failed`. Credentials are stripped from the reported URL and message.

## Allowlist syntax

| Pattern             | Matches                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `example.com`       | that host exactly (**not** its subdomains), on any port                  |
| `*.example.com`     | any subdomain (`a.example.com`, `a.b.example.com`) but **not** the apex  |
| `example.com:8443`  | that host, only on port 8443                                             |
| `*`                 | any **public** host — private/internal targets stay blocked              |

Anything else (a scheme, a path, an `@`, an embedded wildcard) is rejected as a configuration error rather than interpreted loosely.

## Settings

- **`allowedHosts`** (array of strings, default `[]`) — the navigation allowlist. Empty means every navigation is refused. Falls back to `PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS` (comma-separated) when unset.
- **`timeoutMs`** (number, default `30000`) — wall-clock budget for navigation and each action; clamped to 1 000–120 000.
- **`headless`** (boolean, default `true`) — leave enabled on any server runtime.
- **`subresourcePolicy`** (`public-only` | `allowlist`, default `public-only`) — `public-only` lets a page load assets from any public host while still blocking internal targets; `allowlist` restricts assets to `allowedHosts` too.
- **`allowPrivateNetwork`** (boolean, default `false`) — advanced escape hatch for automating internal staging hosts. Requires an explicit host list: the `*` entry is dropped while this is on, so it can never open the whole internal network.
- **`executablePath`** — absolute path to a Chromium binary; falls back to `PLUGIN_BROWSER_AUTOMATION_EXECUTABLE_PATH`, then to the Playwright-managed browser.
- **`channel`** — optional Playwright channel (`chrome`, `msedge`) instead of the bundled Chromium.

## Runtime requirements

`playwright-core` is an **optional** dependency loaded through a runtime dynamic import, and Chromium must be present on the host. A runtime without either degrades to a loud `BrowserAutomationNotProvisionedError` — it never crashes at module load. `probe()` and `healthCheck()` report the degraded state (and also flag an empty allowlist, which would make the plugin useless in practice).

## Troubleshooting

| Symptom                                                   | Likely cause                                              | Fix                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `BrowserNavigationBlockedError` with `not_allowlisted`    | The host (or a redirect hop) is not in `allowedHosts`     | Add the host — including any host the site redirects through                     |
| `BrowserNavigationBlockedError` with `private_address`    | Target is loopback/private/link-local/cloud-metadata      | Intentional. Use `allowPrivateNetwork` with an explicit host list if you must    |
| `BrowserNavigationBlockedError` with `dns_private_ip`     | An allowlisted name resolves to an internal address       | Intentional (rebinding defence). Verify the DNS record                          |
| `BrowserAutomationNotProvisionedError` at `open()`        | `playwright-core` or the Chromium binary is missing       | Install `playwright-core` and a Chromium build, or set `executablePath`         |
| Screenshot renders without styling                        | Assets were blocked by `subresourcePolicy: 'allowlist'`   | Switch to `public-only`, or allowlist the asset hosts                           |
| Timeouts on slow pages                                    | 30 s default budget                                       | Raise `timeoutMs` (max 120 000)                                                 |

## Local development

```bash
cd packages/plugins/browser-automation
pnpm build     # tsc --noEmit && tsup
npx vitest run # unit tests, incl. the SSRF-refusal suite (no real browser is launched)
```

The unit tests inject a fake Playwright module and a deterministic DNS resolver, so they never launch a browser and never touch the network.
