---
id: plugins
title: Plugins
sidebar_label: Plugins
---

# Plugins

A **plugin** is a capability the platform does not have on its own — a model to write with, a search engine to research with, a Git host to push to, somewhere to deploy. The platform ships the sockets; plugins fill them.

Open **Plugins** in the dashboard sidebar (`/plugins`) to see every plugin your install carries.

## Plugins vs. the pages that look like plugins

| You want to…                                                     | Go to…                                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Turn an AI provider, search engine, Git host or deploy target on | **Plugins** (`/plugins`)                                                            |
| Give a plugin its API key, token or model                        | The plugin's own page — **Settings** on its card                                    |
| Walk plugin settings one category at a time                      | **Settings → Plugins** (`/settings/plugins`)                                        |
| Change which plugin serves a capability inside one Work          | That Work's **Plugins** tab → **Capability Providers**                              |
| Connect Slack / GitHub / meetings so their activity streams in   | [Integrations](./integrations.md) — connector plugins plus the pipeline around them |

`/settings/plugins` has no page of its own: it redirects to the **AI Providers** category, and each category page lists only the plugins in that category you have already enabled. Every category except **Pipeline** answers with a _page not found_ when that list comes back empty — so until you have enabled an AI provider, following the redirect lands on a 404 rather than an empty page.

## What the page shows

The list is grouped under category headings. Searching, or picking a category chip, flattens it into a single grid.

| Control          | What it does                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Search box       | Matches the plugin **name**, **description**, **category** and **capabilities**. Not settings values. |
| Category chips   | **All**, plus one chip per category that has at least one plugin registered on this install.          |
| **Enabled only** | Hides everything not currently enabled.                                                               |

Each card carries the icon, name, version, description, a category tag, up to two capability tags (any beyond two collapse into a `+N` count), a **Settings** link, a **Docs** link when the plugin declares an `http:` or `https:` homepage, and the **Enable** / **Disable** button. Capabilities that merely repeat the plugin's category, and a handful of internal ones, are never shown as tags.

One of two badges can sit next to the version — never both, since a plugin that is registered as both system and built-in shows only **System**:

| Badge        | Meaning                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **System**   | Always on. There is no Enable/Disable button, and the API rejects a disable with _"is a system plugin and cannot be disabled"_. |
| **Built-in** | Registered as built-in rather than as an externally installed package. Changes nothing about enabling or disabling.             |

Cards are sorted enabled first, then installed, then alphabetically — but that order is captured **once, when the page loads**, so a card you just toggled stays put instead of jumping. Reload to re-sort.

## Categories

Twenty-four categories exist. Twenty of them have a fixed display order:

**Pipeline · AI Providers · Search · Content Processors · Screenshots · Git Providers · Deployment · Data Sources · Storage · Databases · Vector Stores · DNS Providers · Email Providers · Notification Channels · Job Runtimes · Secret Stores · Forms · Integrations · Utilities · Themes**

Four are not in that list — **Connectors**, **Metrics**, **Memory Frameworks** and **RAG Pipelines** — so they all sort to the bottom, after the twenty above. Use the search box or a category chip to jump to one.

A few whose scope is easy to guess wrong:

| Category                  | What plugs in here                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage**               | Object-storage backends — local filesystem, S3, MinIO, GitHub blob.                                                                                                                         |
| **Databases**             | The relational backend for deployed Works: the tenant-level connection, plus a per-Work database derived from it. Distinct from **Storage**.                                                |
| **Notification Channels** | Outbound-only delivery targets.                                                                                                                                                             |
| **Connectors**            | Channel plugins built on the same outbound send contract as Notification Channels, plus an inbound leg. Each connector declares which directions it implements; most declare outbound only. |
| **Secret Stores**         | Backends that resolve an opaque credential reference (Vault, Kubernetes, Infisical, Doppler) into a real credential.                                                                        |
| **Metrics**               | Read-only metric collectors. This is where [Goals](./goals.md) get their numbers.                                                                                                           |

:::note Memory Frameworks and RAG Pipelines are contracts, not products yet
Both categories exist in the manifest schema, but **no plugin ships under either one**. Since a chip only appears for a category that has a registered plugin, you will not see them on the page. The per-Work Knowledge Base is unaffected — it does not go through them.
:::

## Enabling a plugin

Press **Enable** on the card. A dialog opens — titled **Enable**, described as _"Configure how this plugin is enabled across your works."_ — carrying one checkbox, **Also enable for all works**. Press **Enable** again in the dialog to commit.

:::caution
The first click only opens the dialog. Nothing is enabled until you confirm inside it. Plugins that cannot apply to a Work at all — those declaring `user-only` visibility, which never appear in a Work's plugin list — skip the dialog and enable on the first click, so the two flows genuinely differ from card to card.
:::

If the enable fails, the switch rolls back **and** an error toast appears carrying the server's reason, falling back to _"Failed to enable plugin"_. Disable behaves the same way, with _"Failed to disable plugin"_. A switch that silently snaps back with no message is no longer a state you should see.

### "Also enable for all works"

This checkbox is the difference between a plugin your account can use and a plugin your Works actually run.

- **Ticked** (the default) — the plugin is active in every Work you own, present and future. You can still switch it off in an individual Work afterwards.
- **Unticked** — the plugin is enabled for your account only. Your Works will **not** use it until you enable it on each Work's Plugins tab.

Cancelling the dialog declines _that_ enable and nothing more: the checkbox is restored to ticked, so re-opening that plugin's dialog starts from the default again.

### There is no install step

Enabling is the whole lifecycle. On installs running in **dynamic** plugin-distribution mode, enabling a plugin that is not yet on the server downloads and verifies the package first, then registers it. On bundled installs that step is a no-op — everything is already present.

:::warning
Neither `/plugins` nor a plugin's own page has an **Install** or **Uninstall** button. If you are following a guide that tells you to install a plugin before enabling it, that guide is describing the developer-facing plugin system, not this screen. Enable is the action you want.
:::

## Account level vs. Work level

Two switches decide whether a plugin runs inside a given Work — yours and the Work's — and they do not combine the way you might expect. The first row that matches wins:

| Situation                                              | Result inside a Work                                       |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| The plugin is marked **System**                        | On. Always, everywhere.                                    |
| You **disabled** it on `/plugins`                      | Off — the account-level off switch cascades to every Work. |
| The Work has its own on/off record for the plugin      | The Work's setting wins.                                   |
| You ticked **Also enable for all works**               | On.                                                        |
| You enabled it on `/plugins` and nothing above applies | **Off.** Account-level _on_ does not cascade.              |
| You have never touched it                              | Off, unless the plugin's manifest sets `autoEnable`.       |

:::caution
Read that fifth row twice. **Enabling a plugin on `/plugins` does not switch it on inside your Works** unless you ticked "Also enable for all works" or enabled it on the Work itself. Disabling, by contrast, _does_ cascade. This asymmetry is the single most common reason a freshly configured plugin appears to do nothing.
:::

Per-Work control lives on the Work's **Plugins** tab, which requires the **Manager** or **Owner** role on that Work — see [Work members](./work-members.md). The tab's **Show installed only** toggle starts on, so plugins you have not enabled at the account level are hidden until you turn it off.

## Disabling a plugin

**Disable** always opens a confirmation first, warning that _"Disabling this plugin will also disable it in all your works"_. Press **Confirm Disable** to commit.

Your settings and saved credentials survive a disable — re-enabling brings them back. System plugins have no Disable button at all.

## Settings and credentials

Open a plugin's page from **Settings** on its card. What you see depends on what the plugin declares: a settings form, an **Account Connection** panel for OAuth plugins, a **Device Authentication** panel, a link out to where you generate the token, a "bring your own key" prompt that reveals the form, or — for a plugin that declares one — a step-by-step onboarding wizard that replaces the ordinary Save row.

:::caution
**Save is blocked until the plugin is enabled.** With the plugin off, the Save button is greyed out and the page prints _"Enable this plugin first, then save its settings."_ Enable, then paste your key — not the other way round.
:::

Secret fields — API keys and tokens — behave differently from the rest:

| Behaviour                         | Detail                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored encrypted                  | Secrets are encrypted at rest and never returned to the page in full.                                                                                                                                                                                                                          |
| **Partially revealed** after save | A saved secret comes back as its first four characters, a `••••` mask, then its last four — `sk-1••••9f2a`. Values of eight characters or fewer reveal two on each side, and values of four or fewer come back fully masked. It renders read-only beside a key icon, not as an editable input. |
| Replace via **Modify**            | Press **Modify** to clear the field and type a new value; **Cancel** next to the input puts the masked placeholder back. There is no way to read the old secret in full — if you have lost it, generate a fresh one at the provider.                                                           |
| Only changes are sent             | Fields you did not touch are left out of the save entirely, so a partial edit cannot blank the rest.                                                                                                                                                                                           |

Required fields are checked in the browser before anything is sent, and the missing ones are listed by name: _"Missing required fields: …"_.

:::note "Save & verify" is on the Settings page, not the plugin's page
A plugin's own page always labels its button **Save Settings**. The **Save & verify** label — and the panel that reports what the connection found, such as a Kubernetes cluster's name, version and IngressClass list — appears in **Settings → Plugins**, and only for plugins that declare `verifiesOnSave`. Saving on the plugin's own page still runs the same validation; it just reports the result as a plain message instead of that panel.
:::

A Work can override its own copy of these settings from the Work's Plugins tab: _"Override settings for this Work. Unset fields inherit from your user settings."_ **Reset to Defaults** clears the Work's overrides and falls back to your user-level values.

## Which plugin serves a capability

A capability call resolves its provider **at the moment of the call**, not once at startup. For AI providers the order is:

1. The **Agent's** pinned provider, when an Agent is making the call.
2. An explicit per-call override.
3. The Work's **Capability Providers** choice — the panel at the top of the Work's Plugins tab, _"Select which plugin provides each capability for this Work"_.
4. Among the plugins enabled for that user and Work, one that declares itself the default for the capability.
5. Otherwise, simply the first enabled one.

**Steps 1 and 2 do not fall through.** If either override is set but does not name a registered, loaded plugin that carries the capability and is enabled for the scope, the call fails on the spot with `ProviderNotFoundError` — `"<capability> provider not found: <id>"` — and never reaches the Work's choice or the enabled plugins. Steps 3-5 are reached only when no override was given, and only that path ends in `NoProviderError`.

**Deployment** does not use this chain at all. Publishing reads the provider recorded on the Work itself.

## What breaks without a provider

| Capability       | What you get                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI provider**  | Depends entirely on the caller — there is no single behaviour. The digest, for one, degrades rather than failing: it keeps every deterministic number and says why, _"No AI provider is configured, so the digest below is the deterministic activity report without an AI summary."_ |
| **Search**       | The availability check reports _"No search provider is enabled. Enable a search plugin (e.g. Tavily, Linkup, Brave, Exa) in settings."_                                                                                                                                               |
| **Deployment**   | Publishing resolves the provider recorded on the Work. With none recorded it fails with _"No deployment provider configured or available"_; with an id that is not a loaded deployment plugin, _"Deployment provider not found: …"_.                                                  |
| **Git provider** | Repository work fails — importing a source repo, for example, reports _"No git provider configured. Please connect your git provider account."_                                                                                                                                       |
| **Metrics**      | A [Goal](./goals.md) names its provider plugin explicitly, and that name acts as an override: if it is not a loaded, enabled `metrics-provider` plugin, every evaluation fails.                                                                                                       |

:::caution
**Enabled is not the same as configured.** A plugin with no API key is enabled and still useless, and the two failures read differently. Search distinguishes them explicitly: _"Search plugins are enabled but none have all required settings configured (e.g. API key)."_ means you turned the plugin on but never finished its settings page.
:::

## On small screens

:::caution On a narrow window, the AI chat panel can sit over the buttons
On a narrow window — below 768px, so phones and split-screen — the AI chat drawer opens as a full-screen overlay and covers the page underneath, including the **Enable** button on a plugin card and the **Save** button on a plugin's settings page. Close the drawer or widen the window before assuming a button is missing or unresponsive.
:::

## Related

- [Integrations](./integrations.md) — connectors and the event stream they feed.
- [Goals](./goals.md) — what the Metrics category is for.
- [Git operations](./git-operations.md) — what a Git provider plugin unlocks.
- [Kubernetes deployment](./k8s-deployment.md) — a deployment plugin end to end.
- [Knowledge Base](./knowledge-base.md) — retrieval that leans on AI provider and vector-store plugins.
- [Settings map](./settings-map.md) — where every other setting lives.
- [Onboarding](./onboarding.md) — the wizard that enables your first plugins.
