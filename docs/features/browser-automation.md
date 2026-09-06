---
id: browser-automation
title: Browser Automation
sidebar_label: Browser Automation
description: A headless Chromium your agents can open a page in — navigate, extract, screenshot and act — behind a default-deny host allowlist that is re-checked on every redirect hop.
---

# Browser Automation

Some pages cannot be read with a plain HTTP fetch. A single-page app returns an empty shell; the content only exists after JavaScript has run. **Browser Automation** is the plugin that closes that gap — a real headless Chromium, driven by Playwright, that an [Agent](/features/agents) can point at a page to read what a human would see.

It is deliberately not a general-purpose robot. The plugin ships one security posture that is not optional, and the agent-facing tool built on top of it is **read-only**.

## What it can do

The plugin (`browser-automation`, capability `browser-automation`) exposes four verbs:

| Verb         | What it does                                                                             | Bounds                       |
| ------------ | ---------------------------------------------------------------------------------------- | ---------------------------- |
| `navigate`   | Go to a URL. Returns the final URL, HTTP status, page title and the full redirect chain. | Allowlist-checked, every hop |
| `extract`    | Pull `text`, `html` or a named `attribute` out of the rendered DOM by CSS selector.      | Up to 500 matched nodes      |
| `screenshot` | Capture the viewport, the full page, or one element as base64 PNG or JPEG.               | —                            |
| `act`        | Run an ordered list of `click` / `fill` / `select` / `press` / `hover` / `wait` steps.   | Up to 50 steps per call      |

Sessions are opened, used and closed; the last close shuts the shared browser down.

## What an agent actually gets

Agents do **not** get all four verbs. They get exactly one tool, `browse_url`, and it is read-only:

| Argument    | Meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `url`       | Absolute `http(s)` URL to open. Required.                                    |
| `selector`  | Optional CSS selector. Omit it to read the whole document.                   |
| `format`    | `text` (default), `html` or `attribute`.                                     |
| `attribute` | Attribute name to read — required when `format` is `attribute`, e.g. `href`. |
| `limit`     | Maximum matched nodes to return. Default `20`, capped at `100`.              |

One call opens a session, navigates, extracts and closes again, returning the final URL after redirects, the page title, the matched values, and any sub-resource requests the guard refused.

:::info Why clicking is not offered to the model
`act` exists on the capability but is **not** exposed as an agent tool. Driving a page on your behalf can submit a form or trip an irreversible action, and that needs its own confirmation design rather than arriving as a side effect of letting an agent browse. Screenshot capture is likewise left to the separate [screenshot capability](/api/screenshot-capability), which already has its own facade, budget accounting and UI.
:::

`browse_url` is gated on the agent's **`canCallExternalTools`** permission — the same switch as every other outbound-network tool, and it defaults to off. See [Agent Capabilities](/features/agent-capabilities).

## The security posture

This is the part to read before enabling it.

- **Default-deny allowlist.** An empty allowlist refuses **every** navigation. There is no "allow anything" fallback path, and an empty list is the default.
- **Redirects are re-checked on every hop.** A Playwright route guard aborts any document request whose URL falls outside the allowlist, and the post-navigation audit walks the redirect chain back to the origin — so a hop that somehow slipped through still fails the call instead of quietly returning attacker-chosen content.
- **An SSRF guard sits underneath the allowlist.** Private, loopback, link-local and cloud-metadata targets are refused on both the literal URL and on the DNS result, so an allowlisted hostname that _resolves_ to `127.0.0.1` is still refused. An unresolvable host fails closed.
- **Headless by default.** `headless` must be explicitly set to `false` to get a visible browser, and doing so raises a validation warning.

Allowlist entries are matched exactly, never loosely:

| Pattern            | Matches                                                        |
| ------------------ | -------------------------------------------------------------- |
| `example.com`      | that host exactly — **not** its subdomains — on any port       |
| `*.example.com`    | any subdomain, but **not** the apex                            |
| `example.com:8443` | that host, only on port 8443                                   |
| `*`                | any **public** host; private and internal targets stay blocked |

Anything else — a scheme, a path, an `@`, an embedded wildcard — is rejected as a configuration error. A refusal carries a stable code: `invalid_url`, `scheme_blocked`, `credentials_in_url`, `private_address`, `not_allowlisted`, `dns_private_ip` or `dns_lookup_failed`. A refusal means _the host is not allowed_, not that the page is down.

## Settings

| Setting               | Type    | Default       | What it controls                                                                                                                |
| --------------------- | ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `allowedHosts`        | array   | `[]`          | The navigation allowlist. **Empty refuses everything.** Falls back to `PLUGIN_BROWSER_AUTOMATION_ALLOWED_HOSTS`                 |
| `timeoutMs`           | number  | `30000`       | Wall-clock budget for navigation and for each action, clamped to 1000–120000                                                    |
| `headless`            | boolean | `true`        | Leave on for any server runtime                                                                                                 |
| `subresourcePolicy`   | string  | `public-only` | `public-only` lets a page load assets from any public host while still blocking internal ones; `allowlist` restricts assets too |
| `allowPrivateNetwork` | boolean | `false`       | Advanced escape hatch for internal staging hosts. Requires an explicit host list — a `*` entry is refused while it is on        |
| `executablePath`      | string  | —             | Absolute path to a Chromium binary; empty uses the Playwright-managed browser. Also `PLUGIN_BROWSER_AUTOMATION_EXECUTABLE_PATH` |
| `channel`             | string  | —             | Optional Playwright channel (`chrome`, `msedge`) instead of the bundled Chromium                                                |

## How to turn it on

1. Open **Plugins** (`/plugins`) in the dashboard and find **Browser Automation**. It is not auto-enabled — it is distributed through the plugin registry rather than bundled, so on a self-hosted install it may need installing first (see [Plugins](/features/plugins)).
2. Click **Settings** on its card and fill **Navigation allowlist** with the hosts you actually intend to read. Leaving it empty saves fine and then refuses every call — settings validation returns that exact warning.
3. Leave **Headless** on, and leave **Allow private network** off unless you are deliberately pointing the browser at an internal staging host you control.
4. **Enable** the plugin. Remember that enabling on `/plugins` is account-level; a Work does not inherit it unless you also enable it there or tick "Also enable for all works".
5. Probe it with `POST /api/plugins/browser-automation/validate-connection`, or read `GET /api/plugins/browser-automation/connection-status`. A healthy answer reports Playwright available and how many allowlist entries are configured; an empty allowlist is reported as **not** healthy, on purpose.
6. Give the agent that should browse the **`canCallExternalTools`** permission on its [Capabilities](/features/agent-capabilities) tab. Until then `browse_url` is not in its tool list at all.

Then ask the agent for it in plain language — _"open https://example.com/pricing and tell me what the top tier costs"_ — and the tool routes there.

:::caution Playwright is an optional dependency
`playwright-core` is loaded through a runtime dynamic import, so a worker image built without a browser degrades to a loud `BrowserAutomationNotProvisionedError` instead of crashing at module load. If every call comes back not-provisioned, the runtime has no Chromium — install the browser on that image, or point `executablePath` at one that exists.
:::

## Related

- [Agents](/features/agents) — the workers that call `browse_url`
- [Agent Capabilities](/features/agent-capabilities) — where `canCallExternalTools` is granted
- [Plugins](/features/plugins) — enabling, configuring and scoping a plugin
- [Environments](/features/environments) — the per-run networking posture an agent executes under
- [Built-in Plugins](/plugin-system/built-in-plugins) — the full reference entry for `browser-automation`
- [Plugin Categories](/plugin-system/plugin-categories) — where the `browser-automation` capability sits among the sockets
- [Screenshot capability](/api/screenshot-capability) — the separate, budget-accounted way to capture a page image
