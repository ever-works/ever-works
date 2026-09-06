# Feature Specification: Connections, scope presets, per-agent grants and the vault

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md).
> Describe **what** the system does, not how it's structured. Implementation lives in
> [`plan.md`](./plan.md); the ordered work lives in [`tasks.md`](./tasks.md).

**Epic ID**: `AW-15-connections-scopes`
**Program**: [`agent-workspace`](../README.md)
**Branch**: `feat/aw-15-connections-scopes`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Size**: L · **Blocking dependencies**: none
**Extends**: `plugins`, `mcp-connections`, `repo-connections`, `tool-grants`

---

## 0. TL;DR

An Ever Works owner today can connect exactly **one** account per provider, cannot say what
that account is allowed to do beyond "connected", cannot narrow one Agent's access without
narrowing everyone's, has no way to know a credential died until a Run fails, and has nowhere
to put an API key for a service we do not ship a plugin for.

This epic makes **Connection** a first-class, countable thing:

```
        ┌────────────────────────────────────────────────────────────────┐
        │  Settings → Connections                                        │
        │                                                                │
        │  Plugin (installed)          Connection (one account)          │
        │  ───────────────────         ─────────────────────────         │
        │    github            ──┬──►  "Company GitHub"   ★ primary      │
        │                        └──►  "Client GitHub"                   │
        │    slack-connector   ─────►  "Team workspace"                  │
        │    (mcp) docs-server ─────►  "Docs server"                     │
        │                                                                │
        │  every Connection carries                                      │
        │    · a label you chose            · a health state             │
        │    · a scope preset: Read only ─or─ Read and write             │
        │    · last used → the Runs that used it                        │
        │                                                                │
        │  and, per Agent, a grant that can only ever NARROW it:         │
        │    inherit  →  read  →  blocked                                 │
        │  enforced immediately before every single tool call.           │
        └────────────────────────────────────────────────────────────────┘
```

Plus a **Vault**: write-only, masked credential entries an Agent can *use* through the existing
`{{cred.key}}` mechanism but that nobody — no user, no Agent, no API response — can ever read
back.

Plus **Add MCP server**: paste a URL or paste the JSON config a server's own docs publish; if
the server wants an interactive sign-in instead of a header, we detect that from the server
itself and drive the sign-in without asking the user to understand why.

Three shippable phases: **P1** registry + presets + health; **P2** per-agent grants + per-call
enforcement + last-used; **P3** vault + MCP paste/sign-in flow.

---

## 1. Overview

An owner can connect **several accounts to the same provider**, name each one, mark one as the
primary, and choose for each a plain-English **scope preset** — *Read only* or *Read and write*
— instead of a list of raw provider scope strings. Every connected account shows a **health**
state that the platform refreshes on its own, with a one-click **Reconnect** when a credential
expires, and a **Last used** link that opens exactly the Runs that touched that account. From
the account's **Manage** view an owner can narrow or completely block a single Agent's access,
and that change binds on the Agent's very next tool call — no Run restart, no process restart,
no re-authorisation. For services Ever Works has no plugin for, a **Vault** holds grouped,
write-only, masked credentials that Agents can use and no one can read. And an owner can add
**any MCP server** by pasting its URL or the JSON config snippet its own documentation
publishes; if that server authenticates interactively, Ever Works detects it, opens the
sign-in page, and settles the card on its own when the approval lands.

## 2. Why now

### 2.1 The questions an owner asks that Ever Works cannot answer today

| The owner's question | What they do today | What is missing |
| --- | --- | --- |
| "Connect my GitHub *and* my client's GitHub." | Impossible. | The platform stores at most one account per person per provider. There is no second slot. |
| "This Agent should only *read* my issue tracker." | Turn the plugin off for everyone, or accept full access. | There is no access level on a connection at all; a connection is a boolean. |
| "Block just the research Agent from the CRM." | Not expressible. Tool grants are name-pattern based and cannot name *which account*. | Nothing binds an Agent to a specific connected account with a narrower level. |
| "Which of these is still working?" | Open each settings row one at a time and press *Test*. | Health is pull-only. Nothing probes on a schedule; nothing tells you a token died. |
| "What has it been doing with my calendar?" | Read the whole activity log and filter by eye. | Runs are not attributed to the connection that served them. |
| "I need to give it a key for a service you don't support." | Put it in an environment variable on the server, or paste it into a chat. | Agents can already reference a named secret, but a workspace owner has nowhere to store one. |
| "Add this MCP server — here's the config from their docs." | Hand-translate the snippet into name / URL / header-name / header-value fields, and give up if the server wants a sign-in instead of a header. | The manual form accepts only a URL plus static headers; interactive sign-in is not supported at all. |

### 2.2 The three concrete gaps in the code we own

1. **One-account ceiling.** The platform can hold exactly one signed-in account per person per
   provider; a second one cannot be stored at all. Agencies and consultants — people running the
   same tool for several clients — are blocked outright.
2. **Access is all-or-nothing and coarse.** Tool grants answer "may this Agent use deployment
   tools at all" and cannot answer "may this Agent act on the client's repository but not on
   ours" — a tool's name says nothing about which account will serve it. And access is worked
   out **once, when a Run starts**, so tightening it mid-Run does not bind until the next Run.
3. **Health is invisible and credentials are homeless.** Nothing checks a connection unless
   somebody opens its settings row and presses a button, so a revoked credential surfaces as a
   failed Run. And although Agents can already reference a named secret inside a tool argument,
   there is nowhere for a workspace owner to put one — the only place a secret can live is an
   environment variable an operator sets on the server.

### 2.3 Why this is one epic and not three

Presets, per-agent grants and the vault are the same decision seen from three angles: *what may
this credential be used for, by whom, and can anyone read it back*. Splitting them produces
three access models that disagree. Doing them together produces one: **a Connection carries a
ceiling, a grant may only narrow it, and the secret behind it is never readable.**

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — second account on the same provider.**
  **Given** an owner already has a GitHub connection labelled "Company GitHub",
  **when** they open Settings → Connections → *Add account* on GitHub, sign in with a second
  identity, and choose *Read only*,
  **then** both accounts appear as separate rows under GitHub, "Company GitHub" keeps its
  ★ primary badge, and the new row shows "Read only" and health *Healthy*.

- **S2 — rename and re-primary.**
  **Given** two GitHub connections,
  **when** the owner renames the second to "Client GitHub" and presses *Make primary*,
  **then** the ★ moves to "Client GitHub", the change is written to the activity log naming
  both labels, and every Agent that did not name a specific account now uses "Client GitHub"
  on its next tool call.

- **S3 — connect at the narrow preset by default.**
  **Given** an owner connecting a new provider,
  **when** the connect dialog opens,
  **then** *Read only* is preselected with the copy "Start narrow. You can widen this later
  without reconnecting.", and the owner must actively choose *Read and write* to widen it.

- **S4 — widen a preset without reconnecting.**
  **Given** a connection at *Read only* whose plugin declares that the write preset needs
  additional provider scopes,
  **when** the owner switches it to *Read and write*,
  **then** either the change applies immediately (the granted provider scopes already cover
  the write preset), or the dialog says exactly which additional approval is needed and offers
  *Re-approve* — and if the owner cancels, the connection stays at *Read only* and nothing
  changes.

- **S5 — narrow one Agent.**
  **Given** a *Read and write* CRM connection used by four Agents,
  **when** the owner opens *Manage → Agent access* and sets the research Agent to *Read only*,
  **then** the research Agent's write tools disappear from its next tool call, the other three
  Agents are untouched, and the row reads "Read only · narrowed from the connection default".

- **S6 — block one Agent mid-Run.**
  **Given** an Agent is mid-Run and about to call a tool on a connection,
  **when** the owner sets that Agent to *Blocked* on that connection,
  **then** the Agent's very next call on that connection is refused **before any outbound
  request is made**, within 5 seconds of the save, with the Run log line "Blocked by connection
  access — <connection label>", and no Agent, worker or Run is restarted.

- **S7 — health goes bad on its own.**
  **Given** a connection whose credential has been revoked at the provider,
  **when** the scheduled health check next probes it,
  **then** its row flips to *Expired*, a banner appears at the top of Settings → Connections
  reading "1 connection needs attention", and the row grows a *Reconnect* button.

- **S8 — reconnect carries everything forward.**
  **Given** an *Expired* connection with a label, a preset, and three per-agent grants,
  **when** the owner presses *Reconnect* and completes the provider's sign-in,
  **then** the same connection row returns to *Healthy* keeping its label, its preset, its
  primary flag and all three grants — no second row is created and no setting is re-asked.

- **S9 — last used opens the receipts.**
  **Given** a connection that Agents have used,
  **when** the owner clicks its "Last used 12 minutes ago" link,
  **then** they land on the Runs list filtered to exactly the Runs that made a call on that
  connection, newest first.

- **S10 — a credential for a service we do not ship.**
  **Given** a service Ever Works has no plugin for,
  **when** the owner adds a Vault entry with group "Billing", key `acme_api_key` and pastes
  the value,
  **then** the entry is listed as "Billing / acme_api_key · ●●●●●●●● · set 6 Sep 2026 by
  evereq", the value is never returned by any API, and an Agent tool argument written as
  `{{cred.acme_api_key}}` resolves to the real value at call time and is scrubbed from the
  transcript.

- **S11 — add an MCP server from its published config.**
  **Given** a server's docs publish a `"docs-server": { "url": "https://…", "headers": { … } }`
  snippet,
  **when** the owner pastes that snippet whole — trailing comma and all — into *Add MCP
  server*,
  **then** the form fills itself in (name, URL, header name), the header **value** goes
  straight into the Vault write-only, and after *Connect* the card lists the tools it found
  within 120 seconds.

- **S12 — an MCP server that wants a sign-in, not a key.**
  **Given** the owner pastes only an https URL for a server that authenticates interactively,
  **when** they press *Connect*,
  **then** the card detects it from the server's own response, shows *Open sign-in page*,
  and — after the owner approves in that tab — settles to *Connected* on its own with the tool
  count, with no code to copy back.

### 3.2 Edge cases and failures

- **S13 — provider limit reached.**
  **Given** a provider already has 10 connections,
  **when** the owner presses *Add account*,
  **then** the button is disabled with the copy "10 of 10 accounts connected. Remove one to
  add another." and the API refuses a direct call with `409 connection_limit_reached`.

- **S14 — label collision.**
  **Given** a connection labelled "Client GitHub",
  **when** the owner names a second GitHub connection "client github",
  **then** the field errors inline with "You already have a connection called 'Client GitHub'.
  Pick another name." and nothing is saved.

- **S15 — MCP name collides with an installed plugin.**
  **Given** the `github` plugin is installed,
  **when** the owner pastes an MCP config whose server name is `github`,
  **then** the wizard refuses with "A connection called 'github' already exists. Rename this
  one." and offers a prefilled alternative; no row is created and the pasted secret is
  discarded, not stored.

- **S16 — two different URLs, same-ish name.**
  **Given** an MCP connection already points at `https://a.example.com/mcp`,
  **when** the owner adds `https://b.example.com/mcp`,
  **then** two distinct connections exist. Ever Works never merges two endpoints into one row,
  whatever they are called.

- **S17 — same URL twice.**
  **Given** an MCP connection already points at `https://a.example.com/mcp`,
  **when** the owner pastes the identical URL again,
  **then** the wizard says "You are already connected to this server as 'docs-server'." and
  offers *Open it* rather than creating a duplicate.

- **S18 — unparseable paste.**
  **Given** the owner pastes something that is neither a URL nor a recognisable config,
  **when** they press *Connect*,
  **then** the wizard says "That doesn't look like a server URL or a config snippet. Paste the
  https URL, or the `\"name\": { … }` block from the server's docs." and keeps what they typed.

- **S19 — a grant that tries to widen.**
  **Given** a connection at *Read only*,
  **when** an owner (or an API client) sets an Agent grant to *Read and write*,
  **then** the effective access stays *Read only*, the row shows "Read and write · clamped to
  the connection's Read only", and the API returns the clamped effective value rather than an
  error. Widening the connection later un-clamps it automatically.

- **S20 — health check cannot reach the server.**
  **Given** an MCP server that times out,
  **when** the scheduled probe runs three consecutive times without success,
  **then** the row flips to *Unreachable* (not *Expired* — no credential was rejected), the
  copy reads "Couldn't reach this server. Last tried 4 minutes ago.", and *Reconnect* is **not**
  offered because reconnecting fixes nothing.

- **S21 — the health sweeper itself fails.**
  **Given** the scheduled health check errors,
  **when** an owner opens Settings → Connections,
  **then** every row still renders with its last known health and a "Checked 2 hours ago"
  timestamp. A stale probe never blanks a row, never flips a healthy row to *Expired*, and
  never blocks a call.

- **S22 — a blocked Agent asks anyway.**
  **Given** an Agent blocked on a connection,
  **when** the model asks for one of that connection's tools,
  **then** the tool is not offered to the model at all for that Run, and if a cached descriptor
  is invoked anyway the call is refused locally with `connection_blocked`, recorded once in the
  Run log, and the Run continues rather than failing.

- **S23 — someone tries to read a Vault value.**
  **Given** any Vault entry,
  **when** any client calls any endpoint that could return it — list, get, export, the settings
  form, an Agent tool that echoes its own arguments,
  **then** the value is `●●●●●●●●`. There is no endpoint, no role, no flag and no admin
  override that returns the plaintext. The only operations are *replace* and *delete*.

- **S24 — vault full.**
  **Given** 200 Vault entries,
  **when** the owner adds another,
  **then** the API refuses with `409 vault_limit_reached` and the UI reads "200 of 200 secrets
  stored. Delete one to add another."

- **S25 — deleting the primary.**
  **Given** three connections on a provider, the first marked primary,
  **when** the owner deletes it,
  **then** the oldest remaining *Healthy* connection is promoted to primary automatically, the
  promotion is written to the activity log, and the owner sees "Client GitHub is now the
  primary GitHub account."

- **S26 — deleting a connection an Agent is mid-call on.**
  **Given** an in-flight tool call on a connection,
  **when** the owner deletes that connection,
  **then** the in-flight call completes or fails on its own terms, every subsequent call is
  refused with `connection_not_found`, all grants for it are removed, and any Vault entry it
  alone referenced is **kept** (secrets are never deleted as a side effect) with a note "No
  longer used by any connection."

- **S27 — someone else's connection.**
  **Given** a connection belonging to another workspace,
  **when** its id is requested directly,
  **then** the response is `404`, never `403` — existence is not leaked.

- **S28 — first-ever visit.**
  **Given** a workspace with nothing connected,
  **when** the owner opens Settings → Connections,
  **then** they see the empty state: "Nothing connected yet. Connect an account and every
  Agent can use it — at exactly the level you pick." with *Browse providers* and *Add MCP
  server*.

## 4. Functional requirements

### 4.1 The Connection registry

- **FR-1** The system MUST let a workspace hold **more than one Connection per provider**, each
  with its own credential, label, scope preset, health and grants.
- **FR-2** The system MUST cap a workspace at **10 Connections per provider** and **100
  Connections in total**, refusing the 11th (or 101st) with a distinct, machine-readable error
  code and a message naming the limit.
- **FR-3** Each Connection MUST carry a user-chosen **label** of 1–60 characters, unique
  case-insensitively within `(workspace, provider)`, defaulting on creation to the account
  identity the provider reports (e.g. the signed-in username) or, failing that, to the provider
  name plus an ordinal.
- **FR-4** Exactly **one** Connection per `(workspace, provider)` MUST be flagged **primary**.
  The first Connection on a provider becomes primary automatically.
- **FR-5** When the primary Connection is deleted, the system MUST promote the **oldest
  remaining Connection whose health is `healthy`** to primary; if none is healthy, the oldest
  remaining Connection regardless of health.
- **FR-6** An Agent request that does not name a Connection MUST resolve to that provider's
  **primary** Connection.
- **FR-7** Renaming, re-priming, changing a preset, creating and deleting a Connection MUST each
  write an activity-log entry naming the Connection label and the field changed, and MUST NOT
  write any credential value.
- **FR-8** Requesting a Connection that belongs to another workspace MUST return `404`.

### 4.2 Scope presets

- **FR-9** Every Connection MUST carry exactly one **scope preset**, drawn from a fixed
  two-value set: **`read`** ("Read only") and **`write`** ("Read and write"). No third level,
  and no raw provider scope strings are shown to the user anywhere in the connect flow.
- **FR-10** The default preset offered at connect time MUST be **`read`**.
- **FR-11** The set of tools a preset unlocks MUST be **declared by the provider's plugin**, not
  by the platform, so that a plugin that ships later needs no core change to gain presets.
- **FR-12** A provider whose plugin declares no presets MUST behave as if it declared a single
  `write` preset, and its Connections MUST show "Standard access" instead of a preset chooser —
  per-agent blocking (FR-16) still applies.
- **FR-13** Changing a Connection's preset MUST take effect **without deleting and re-creating
  the Connection** and MUST preserve the label, primary flag, grants, health and last-used data.
- **FR-14** If widening a preset requires additional provider approval that the stored
  credential does not carry, the system MUST say so before changing anything, offer a
  re-approval, and leave the Connection at its existing preset if the owner cancels.
- **FR-15** Narrowing a preset MUST NEVER require a re-approval and MUST take effect within
  5 seconds.

### 4.3 Per-agent grants

- **FR-16** For each Connection the system MUST support a per-Agent **grant** with exactly four
  modes: `inherit` (the default, no row stored), `read`, `write`, `blocked`.
- **FR-17** The system MUST also support one **workspace-level grant** per Connection, sitting
  between the Connection's preset and the per-Agent grant, so an owner can set a narrower
  default for every Agent at once.
- **FR-18** Resolution MUST be **narrow-only**: `effective = min(connection preset, workspace
  grant, agent grant)` over the ordering `blocked < read < write`. A grant MUST NEVER widen
  access above the Connection's preset.
- **FR-19** A grant that names a wider mode than its ceiling MUST be **stored as written but
  reported as clamped** — the API returns both `requested` and `effective`, and the UI says
  which ceiling clamped it. It MUST NOT be rejected, so that widening the Connection later
  un-clamps every grant automatically.
- **FR-20** The effective access for `(Agent, Connection)` MUST be evaluated **immediately before
  every tool invocation on that Connection**, not once per Run.
- **FR-21** A grant change MUST bind on the Agent's next tool call and **no later than 5 seconds**
  after the save, with **no Agent restart, no worker restart, no Run restart and no
  re-authorisation**.
- **FR-22** A call refused by a grant MUST be refused **before any outbound network request is
  made**, MUST return a structured refusal (not an exception) to the tool loop, MUST be recorded
  once in the Run log with the Connection label and the reason, and MUST NOT fail the Run.
- **FR-23** Tools belonging to a Connection an Agent is `blocked` on MUST NOT be offered to the
  model when the Run's tool list is assembled.
- **FR-24** Grant resolution failure (e.g. a transient database error) MUST degrade to the
  **Connection's own preset**, never to `write`, and MUST emit a warning.
- **FR-25** The system MUST store at most one grant row per `(Connection, target)`; a second
  write for the same target is an update, enforced at the storage layer so a concurrent double
  write cannot produce two contradictory rows.

### 4.4 Health and reconnect

- **FR-26** Every Connection MUST carry a **health** state from exactly this set: `unknown`
  (never checked), `healthy`, `degraded` (1–2 consecutive failed checks), `expired` (the
  provider rejected the credential), `unreachable` (3 or more consecutive failures that were not
  credential rejections).
- **FR-27** The system MUST probe Connection health **on a schedule without user action**, at
  these per-kind intervals: interactive-sign-in Connections every **60 minutes**, MCP server
  Connections every **30 minutes**, key-based Connections every **360 minutes**.
- **FR-28** The scheduled sweep MUST run every **15 minutes**, MUST probe at most **200
  Connections per tick**, MUST time out a single probe at **8 seconds**, and MUST never probe the
  same Connection twice inside its interval.
- **FR-29** A manual *Check now* MUST be available per Connection, rate-limited to **6 checks per
  minute per Connection**.
- **FR-30** A probe MUST NEVER read, log or return a credential value, and its stored error MUST
  be a classified message (code + short text), never a raw provider response body.
- **FR-31** A failed or unavailable health sweep MUST leave every Connection's last known health
  and last-checked timestamp intact and MUST NOT block any tool call.
- **FR-32** *Reconnect* MUST be offered **only** for `expired` Connections, MUST re-use the same
  Connection row, and MUST preserve label, preset, primary flag, grants, last-used data and
  creation time.
- **FR-33** When at least one Connection is `expired` or `unreachable`, the Connections page MUST
  show a banner counting them, linking to the first affected row.
- **FR-34** A health transition into or out of `healthy` MUST write an activity-log entry and
  MUST raise a notification through the owner's configured notification preferences.

### 4.5 Last used and attribution

- **FR-35** Every successful tool call MUST stamp the serving Connection's **last-used timestamp**
  and the **Run id** that made it.
- **FR-36** Last-used writes MUST be amortised to at most **one write per 10 seconds per
  Connection** so a busy Agent does not generate a write per call.
- **FR-37** The Connection row MUST render "Last used <relative time>" as a link that opens the
  Runs list **filtered to Runs that used that Connection**, newest first; a never-used Connection
  MUST read "Never used".
- **FR-38** Deleting a Connection MUST NOT delete or rewrite the Runs that referenced it; the Run
  history keeps the label it had at the time.

### 4.6 The vault

- **FR-39** The system MUST provide a workspace-scoped **Vault** of named secrets an Agent can
  use through the existing `{{cred.<key>}}` tool-argument mechanism.
- **FR-40** A Vault entry MUST carry a **group** (1–40 characters, free text, used only for
  display grouping), a **key** matching `^[a-z][a-z0-9_]{1,63}$` and unique within the
  workspace, an optional **label** (up to 80 characters), and a **value** of up to 8 KB.
- **FR-41** The system MUST cap a workspace at **200** Vault entries.
- **FR-42** A Vault value MUST be **write-only**. No API response, export, log line, error
  message, settings form, activity-log entry or Agent-visible surface may contain it. Reads
  return the literal mask `●●●●●●●●`.
- **FR-43** The only mutations on an existing entry MUST be **replace the value** and **delete
  the entry**. There MUST be no "reveal", "copy" or "export" affordance anywhere, for any role,
  including platform admin.
- **FR-44** A Vault value MUST be encrypted at rest with the platform's envelope encryption and
  MUST be decrypted only at the moment a tool call needs it, for the duration of that call.
- **FR-45** A Vault entry's **last-used timestamp** and the count of Connections referencing it
  MUST be shown, so an owner can find dead secrets.
- **FR-46** Deleting a Connection MUST NOT delete any Vault entry. An entry no Connection
  references MUST be labelled "Not used by any connection" rather than removed.
- **FR-47** A tool call whose `{{cred.key}}` cannot be resolved MUST be **refused with a message
  naming the key** (never the value), rather than sent half-authenticated.

### 4.7 Adding an MCP server

- **FR-48** *Add MCP server* MUST accept **either** an `https` URL **or** a pasted JSON config
  snippet, in one field, and MUST decide which it was given without asking the user.
- **FR-49** Config parsing MUST tolerate the shapes servers actually publish: a bare
  `"name": { … }` fragment, a `{ "mcpServers": { … } }` wrapper, a bare `{ … }` object,
  trailing commas, comments, and surrounding markdown code fences.
- **FR-50** A single paste MUST be at most **16 KB** and MUST declare at most **10** servers;
  each declared server becomes its own Connection.
- **FR-51** Any secret found in a pasted config (a header value, a token field, an environment
  value) MUST be written **straight into the Vault** and referenced by key. It MUST NOT be
  echoed back into the form, stored in the Connection row in plaintext, or returned by any
  subsequent read.
- **FR-52** The system MUST **detect from the server itself** whether it authenticates
  interactively, and if so MUST show *Open sign-in page* rather than asking for a header.
- **FR-53** The interactive sign-in MUST complete **without the user pasting anything back**:
  the card polls at **3-second** intervals for up to **10 minutes** and settles itself to
  *Connected*, or to *Sign-in timed out* with a *Try again* action.
- **FR-54** Credentials obtained interactively MUST be refreshed automatically when they expire
  and MUST NOT require re-approval under normal operation. When the server revokes access the
  Connection MUST show `expired` and *Reconnect* MUST be the identical flow as first-time setup.
- **FR-55** A new MCP Connection name MUST NOT collide with an installed plugin id or an
  existing Connection label in the workspace; a collision MUST be refused with a rename prompt,
  and any pasted secret MUST be discarded rather than stored.
- **FR-56** Two different server URLs MUST NEVER be merged into one Connection. Re-adding a URL
  that already exists MUST offer to open the existing Connection instead of creating a second.
- **FR-57** After a successful connect, the server's tools MUST be listed on the card, and MUST
  become callable by Agents, **within 120 seconds**.
- **FR-58** Every MCP server URL, at first connect and on **every redirect hop** thereafter, MUST
  be checked against the platform's outbound-request guard; a URL that resolves to a private or
  link-local address MUST be refused with "That address isn't reachable from Ever Works."

### 4.8 What the system must not do

- **FR-59** The system MUST NOT display, log, export or return any credential value, provider
  token, refresh token, or Vault value, in any response, at any role level.
- **FR-60** The system MUST NOT let a grant, a preset change, or any API call widen an Agent's
  access above the Connection's preset.
- **FR-61** The system MUST NOT hardcode any provider id, provider scope string or provider tool
  name in platform code; presets and their tool coverage come from the plugin.
- **FR-62** The system MUST NOT remove, rename or repurpose any existing connection surface —
  the MCP server list, the repository registry, the per-plugin settings pages and the per-agent
  MCP binding screen all keep working exactly as they do today.

## 5. Non-functional requirements

- **Performance** — Connections index for 100 Connections renders server-side in ≤ 400 ms P95.
  The per-call access decision adds ≤ 2 ms P95 to a tool invocation (it reads a process-local
  cache with a 5-second maximum age, never the database, on the hot path).
- **Reliability** — the health sweeper is idempotent per Connection per interval and safe to run
  concurrently in more than one worker; a duplicate tick probes nothing twice.
- **Security** — every credential path is write-only from the user's side. Envelope encryption at
  rest for Vault values and MCP auth headers. Outbound URL guard on every hop. Cross-workspace
  reads are `404`. Refusals are recorded; values never are.
- **Observability** — activity-log entries for every registry, preset, grant, health and Vault
  mutation; a counter for refusals by reason; a gauge for Connections by health state.
- **Compatibility** — additive only. No existing endpoint changes shape; no existing table loses
  a column; no existing route is removed.
- **Accessibility** — every wireframe below is reachable and operable by keyboard alone, with a
  visible focus ring and an announced live region for the async sign-in and probe states.

## 6. Key entities and domain concepts

| Entity / concept | New? | Description | States → transitions |
| --- | --- | --- | --- |
| **Plugin** | existing | An installed package that can serve a provider. Unchanged. | install lifecycle unchanged |
| **Connection** | **new row, existing noun** | One account on one provider. The program vocabulary already calls this a Connection; today there is no single row for it. This epic gives it one, pointing at whichever existing record actually holds the credential. | `health`: `unknown → healthy ⇄ degraded → expired \| unreachable`; `expired --reconnect→ healthy` |
| **Scope preset** | **new** | A named, two-value access level on a Connection: `read` or `write`. Declared per provider **by its plugin**, chosen per Connection by the owner. Not a row of its own — a value on the Connection plus a declaration in the plugin. | `read ⇄ write` (widening may require re-approval; narrowing never does) |
| **Connection grant** | **new** | A narrow-only override of a Connection's preset for one target (the whole workspace, or one Agent). | `inherit \| read \| write \| blocked`; absence means `inherit` |
| **Vault credential** | **new** | A grouped, named, write-only secret usable by Agents through `{{cred.key}}` and readable by no one. | `set → replaced* → deleted` |
| **Agent** | existing | Unchanged. Gains a per-Connection grant surface. | — |
| **Run** | existing | Unchanged. Gains Connection attribution so "last used" can point at it. | — |
| **Tool grant** | existing | The tenant → organization → Work → Agent tool-name matrix. Unchanged, and still evaluated first; the Connection grant is a second, account-aware gate that runs after it. | — |
| **MCP server connection** | existing | Stays exactly as it is and becomes the backing record for MCP-kind Connections. | — |
| **Repository connection** | existing | Stays exactly as it is and becomes the backing record for repo-kind Connections. | — |
| **Notification channel** | existing | Carries the health-change notification. Unchanged. | — |

> **Why three new concepts and not zero.** *Connection* is already this program's word for "an
> account" ([program README §1](../README.md)); it has simply never been a countable thing, which
> is precisely why a second account per provider is impossible today. *Scope preset* cannot be
> folded into the existing tool-grant matrix because tool names carry no account identity —
> "read on the client's repo, write on ours" is inexpressible with patterns alone. *Vault
> credential* is not a new idea either: an Agent can already reference a named secret as
> `{{cred.key}}` inside a tool argument, and the rule that an unresolvable one refuses the call
> is already settled behaviour; the only place such a secret can live today is an operator's
> environment. This epic gives the workspace its own place to put one. No existing noun is
> renamed and none is retired.

### 6.1 The resolution ladder (the one rule)

```
                 provider plugin declares what each preset covers
                                     │
   Connection preset  ───────────────┴──────────────►  the CEILING
        (read | write)                                  set at connect,
                                                        changeable any time
                    │
                    │  narrow-only
                    ▼
   Workspace grant  (inherit | read | write | blocked)   optional default
                    │
                    │  narrow-only
                    ▼
   Agent grant      (inherit | read | write | blocked)   per Agent
                    │
                    ▼
   EFFECTIVE  =  min(ceiling, workspace, agent)     over  blocked < read < write
                    │
                    ▼
        evaluated immediately before EVERY tool call on this Connection
```

Nothing in this ladder can widen. A grant naming a mode above its ceiling is stored, reported as
clamped, and takes effect the moment the ceiling rises.

## 7. UX

### 7.1 Settings → Connections — loaded

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Connections                                                    [+ Add ▾]      │
│  Accounts your agents can use, and exactly what each one may do.               │
│                                                                                │
│  ⚠  1 connection needs attention.  Client GitHub expired.        [ Fix it → ]  │
│                                                                                │
│  [ All ] [ Providers ] [ MCP servers ] [ Vault ]                               │
│                                                                                │
│  GITHUB ─────────────────────────────────────────────────  2 of 10 accounts   │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ ★  Company GitHub          ● Healthy      Read and write                 │ │
│  │    checked 4 min ago       Last used 12 minutes ago →       [ Manage ]   │ │
│  ├──────────────────────────────────────────────────────────────────────────┤ │
│  │    Client GitHub           ● Expired      Read only                      │ │
│  │    checked 2 min ago       Last used 3 days ago →     [Reconnect][Manage]│ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                          [ + Add account ]     │
│                                                                                │
│  SLACK ──────────────────────────────────────────────────  1 of 10 accounts   │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ ★  Team workspace          ● Healthy      Read only                      │ │
│  │    checked 9 min ago       Never used                       [ Manage ]   │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  MCP SERVERS ────────────────────────────────────────────────────────────────  │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ ★  docs-server             ● Healthy      Standard access · 14 tools     │ │
│  │    checked 1 min ago       Last used 2 hours ago →          [ Manage ]   │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

`[+ Add ▾]` opens a two-item menu: **Connect a provider** · **Add MCP server**.
Keyboard: `↑`/`↓` move between rows, `Enter` opens *Manage*, `r` renames the focused row,
`p` makes it primary, `c` runs *Check now*, `/` focuses the filter, `Esc` closes any drawer.

### 7.2 Loading, empty, error and over-limit

```
LOADING                              EMPTY (nothing connected)
┌────────────────────────────┐       ┌──────────────────────────────────────────┐
│  Connections               │       │  Connections                             │
│  ▓▓▓▓▓▓▓▓░░░░░░░░░░░░      │       │                                          │
│  ┌──────────────────────┐  │       │        ┌──────────┐                      │
│  │ ▓▓▓▓▓▓  ▓▓▓▓   ▓▓▓▓  │  │       │        │   ⊕      │                      │
│  ├──────────────────────┤  │       │        └──────────┘                      │
│  │ ▓▓▓▓▓▓  ▓▓▓▓   ▓▓▓▓  │  │       │   Nothing connected yet.                 │
│  └──────────────────────┘  │       │   Connect an account and every agent     │
│  (3 skeleton rows, no      │       │   can use it — at exactly the level      │
│   spinner, no layout jump) │       │   you pick.                              │
└────────────────────────────┘       │                                          │
                                     │   [ Browse providers ] [ Add MCP server ]│
                                     └──────────────────────────────────────────┘

ERROR (list failed)                          OVER LIMIT (provider full)
┌────────────────────────────────────┐       ┌──────────────────────────────────┐
│  ⚠  Couldn't load your connections.│       │  GITHUB          10 of 10 accounts│
│     Your agents are unaffected.    │       │  …                                │
│                        [ Retry ]   │       │  [ + Add account ]  (disabled)    │
└────────────────────────────────────┘       │  10 of 10 accounts connected.     │
                                             │  Remove one to add another.       │
                                             └──────────────────────────────────┘
```

### 7.3 Manage — one Connection

```
┌────────────────────────────────────────────────────────────────────────┐
│  Client GitHub                                                    [✕]  │
│  github · connected 4 Aug 2026 · id ends 7f2a                          │
│                                                                        │
│  ● Expired — GitHub rejected this credential.                          │
│    Checked 2 minutes ago.                    [ Reconnect ] [Check now] │
│                                                                        │
│  ── Name ────────────────────────────────────────────────────────────  │
│  [ Client GitHub                                    ]  [ Save ]        │
│  ☐ Make this the primary GitHub account                                │
│                                                                        │
│  ── Access level ────────────────────────────────────────────────────  │
│  ( • ) Read only        Look things up. Never changes anything.        │
│  (   ) Read and write   Look things up and make changes.               │
│                                                                        │
│  Start narrow. You can widen this later without reconnecting.          │
│                                                                        │
│  ── Agent access ────────────────────────────────────────────────────  │
│  Everyone, by default:   [ Inherit (Read only)      ▾ ]                │
│                                                                        │
│  [ 🔍 Filter agents…                                        ]          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ Researcher      [ Read only        ▾ ]  narrowed from default    │ │
│  │ Builder         [ Inherit          ▾ ]  Read only                │ │
│  │ Publisher       [ Blocked          ▾ ]  refused before it calls  │ │
│  │ Analyst         [ Read and write   ▾ ]  ⚠ clamped to Read only   │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│  Changes apply on each agent's next call. Nothing restarts.            │
│                                                                        │
│  ── Activity ────────────────────────────────────────────────────────  │
│  Last used 3 days ago  →  See the 9 runs that used this connection     │
│                                                                        │
│  ── Danger ──────────────────────────────────────────────────────────  │
│  [ Disconnect ]  Agents lose this account immediately. Runs keep       │
│                  their history. Vault secrets are not deleted.         │
└────────────────────────────────────────────────────────────────────────┘
```

Keyboard: `Tab` walks the sections in order; the agent list is a listbox where `↑`/`↓` move and
`Space` opens the mode menu; `Esc` closes the drawer and discards nothing already saved (every
control saves on change, with an inline "Saved" flash and an *Undo* for 5 seconds).

### 7.4 Widening needs approval

```
┌──────────────────────────────────────────────────────────────┐
│  Widen to Read and write?                                    │
│                                                              │
│  GitHub needs one more approval before agents can make       │
│  changes with this account. You'll sign in once; the name,   │
│  the agents you've set and the run history all stay.         │
│                                                              │
│                              [ Cancel ]  [ Re-approve → ]    │
└──────────────────────────────────────────────────────────────┘
```
Cancel leaves the radio on *Read only* — the UI never optimistically shows the wider level.

### 7.5 Add MCP server — the one field

```
┌───────────────────────────────────────────────────────────────────────┐
│  Add MCP server                                                  [✕]  │
│                                                                       │
│  Paste the server's https URL, or the config block from its docs.     │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │ "docs-server": {                                              │   │
│  │   "url": "https://mcp.example.com/v1",                        │   │
│  │   "headers": { "X-Api-Key": "sk-live-…" },                    │   │
│  │ }                                                             │   │
│  └───────────────────────────────────────────────────────────────┘   │
│  Trailing commas are fine. Keys go straight to the Vault — they're    │
│  never shown again, here or anywhere.                                 │
│                                                                       │
│  Reading it…  ▸ name docs-server  ▸ 1 header  ▸ url looks reachable   │
│                                                                       │
│                                        [ Cancel ]  [ Connect → ]      │
└───────────────────────────────────────────────────────────────────────┘
```

### 7.6 Add MCP server — sign-in detected, waiting, connected, refused

```
DETECTED                                    WAITING
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│  mcp.example.com                    │     │  mcp.example.com                    │
│  This server signs you in instead   │     │  ⏳ Waiting for you to approve…     │
│  of using a key.                    │     │     Approve in the tab that opened. │
│                                     │     │     Times out in 9:41.              │
│      [ Open sign-in page → ]        │     │     [ Open sign-in page again ]     │
└─────────────────────────────────────┘     └─────────────────────────────────────┘

CONNECTED                                   TIMED OUT
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│  ● Connected — docs-server          │     │  Sign-in timed out.                 │
│  14 tools available to your agents. │     │  Nothing was saved.                 │
│  mcp__docs-server__search_docs      │     │            [ Try again ]            │
│  mcp__docs-server__get_page  …+12   │     └─────────────────────────────────────┘
│                    [ Done ]         │
└─────────────────────────────────────┘

NAME COLLISION                              DUPLICATE URL
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│  ⚠ A connection called "github"     │     │  You're already connected to this   │
│    already exists. Rename this one. │     │  server as "docs-server".           │
│    [ github-mcp            ]        │     │        [ Open it → ]  [ Cancel ]    │
│    Nothing was saved yet, including │     └─────────────────────────────────────┘
│    the key you pasted.              │
└─────────────────────────────────────┘

UNPARSEABLE                                 ADDRESS REFUSED
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│  ⚠ That doesn't look like a server  │     │  ⚠ That address isn't reachable     │
│    URL or a config snippet. Paste   │     │    from Ever Works.                 │
│    the https URL, or the            │     │    Use a public https address.      │
│    "name": { … } block from the     │     └─────────────────────────────────────┘
│    server's docs.                   │
└─────────────────────────────────────┘
```

### 7.7 Vault

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Vault                                                    [ + Add secret ] │
│  Keys your agents can use and nobody can read — not you, not us, not them. │
│                                                                            │
│  ┌─── Billing ─────────────────────────────────────────────────────────┐  │
│  │  acme_api_key       ●●●●●●●●   set 6 Sep 2026 by evereq             │  │
│  │                     used 2 hours ago · 1 connection    [Replace][🗑] │  │
│  ├─────────────────────────────────────────────────────────────────────┤  │
│  │  acme_webhook_sig   ●●●●●●●●   set 6 Sep 2026 by evereq             │  │
│  │                     never used · not used by any connection [Rep][🗑]│  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌─── Research ────────────────────────────────────────────────────────┐  │
│  │  panel_token        ●●●●●●●●   set 1 Sep 2026 by evereq             │  │
│  │                     used 4 days ago · 1 connection     [Replace][🗑] │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  12 of 200 secrets stored.                                                 │
└────────────────────────────────────────────────────────────────────────────┘

ADD / REPLACE                               EMPTY                    FULL
┌──────────────────────────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Add a secret                        │    │  Nothing stored  │    │ 200 of 200       │
│  Group  [ Billing            ]       │    │  yet.            │    │ secrets stored.  │
│  Key    [ acme_api_key       ]       │    │  Add a key an    │    │ Delete one to    │
│         lowercase, digits, _         │    │  agent needs and │    │ add another.     │
│  Label  [ Acme production    ]       │    │  reference it as │    └──────────────────┘
│  Value  [ ●●●●●●●●●●●●●●●●●● ]       │    │  {{cred.key}}.   │
│         Write-only. Saving replaces  │    │ [ + Add secret ] │
│         the old value; there is no   │    └──────────────────┘
│         way to read either back.     │
│                    [Cancel] [Save]   │
└──────────────────────────────────────┘
```

### 7.8 Agent → Connections tab

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Researcher ▸ Connections                                                │
│  What this agent may reach, and at what level.                           │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ Company GitHub   github   [ Inherit        ▾ ]  → Read and write   │ │
│  │ Client GitHub    github   [ Read only      ▾ ]  narrowed           │ │
│  │ Team workspace   slack    [ Blocked        ▾ ]  refused before it  │ │
│  │                                                  reaches Slack     │ │
│  │ docs-server      mcp      [ Inherit        ▾ ]  → Standard access  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  Changes bind on this agent's next call. Nothing restarts.               │
│                                                                          │
│  Empty state: "This workspace has no connections yet. [ Connect one → ]" │
└──────────────────────────────────────────────────────────────────────────┘
```

### 7.9 Exact user-visible copy (the strings that carry meaning)

| Where | Copy |
| --- | --- |
| Page subtitle | "Accounts your agents can use, and exactly what each one may do." |
| Attention banner | "{count, plural, one {# connection needs attention.} other {# connections need attention.}}" |
| Preset `read` | "Read only — Look things up. Never changes anything." |
| Preset `write` | "Read and write — Look things up and make changes." |
| Preset hint | "Start narrow. You can widen this later without reconnecting." |
| No presets declared | "Standard access" |
| Grant applies | "Changes apply on each agent's next call. Nothing restarts." |
| Clamped grant | "Clamped to the connection's {ceiling}." |
| Blocked grant | "Refused before it reaches {provider}." |
| Health `healthy` | "Healthy · checked {relativeTime}" |
| Health `degraded` | "Having trouble · checked {relativeTime}" |
| Health `expired` | "Expired — {provider} rejected this credential." |
| Health `unreachable` | "Couldn't reach this server. Last tried {relativeTime}." |
| Health `unknown` | "Not checked yet" |
| Last used | "Last used {relativeTime}" / "Never used" |
| Runs link | "See the {count} runs that used this connection" |
| Disconnect | "Agents lose this account immediately. Runs keep their history. Vault secrets are not deleted." |
| Provider full | "{max} of {max} accounts connected. Remove one to add another." |
| Label taken | "You already have a connection called '{label}'. Pick another name." |
| Vault subtitle | "Keys your agents can use and nobody can read — not you, not us, not them." |
| Vault value help | "Write-only. Saving replaces the old value; there is no way to read either back." |
| Vault unused | "Not used by any connection" |
| Vault full | "{max} of {max} secrets stored. Delete one to add another." |
| MCP paste help | "Paste the server's https URL, or the config block from its docs." |
| MCP secret help | "Trailing commas are fine. Keys go straight to the Vault — they're never shown again, here or anywhere." |
| MCP unparseable | "That doesn't look like a server URL or a config snippet. Paste the https URL, or the \"name\": { … } block from the server's docs." |
| MCP sign-in detected | "This server signs you in instead of using a key." |
| MCP waiting | "Waiting for you to approve… Approve in the tab that opened. Times out in {remaining}." |
| MCP connected | "Connected — {count} tools available to your agents." |
| MCP timed out | "Sign-in timed out. Nothing was saved." |
| MCP name taken | "A connection called '{name}' already exists. Rename this one." |
| MCP duplicate url | "You're already connected to this server as '{label}'." |
| Address refused | "That address isn't reachable from Ever Works. Use a public https address." |
| Empty registry | "Nothing connected yet. Connect an account and every agent can use it — at exactly the level you pick." |
| List error | "Couldn't load your connections. Your agents are unaffected." |

## 8. Out of scope

- **Fine-grained, per-tool scope editing.** Two presets, deliberately. If two levels prove
  insufficient for a provider, the answer is a richer declaration in that provider's plugin, in
  a later epic — not a scope-string editor in the UI.
- **Model provider accounts, priority order and fallback chains.** That is [AW-16](../README.md)
  and shares nothing but the word "account".
- **Spend, caps and credit meters** — [AW-17](../README.md). This epic shows *last used*, not
  *what it cost*; the Runs it links to carry the cost.
- **A curated third-party catalogue with partner links.** Providers here are exactly the plugins
  a deployment has installed.
- **Reading a secret back for any reason.** Not a permissions question, not an admin escape
  hatch, not an export option. Out of scope permanently, by design.
- **Sharing a Connection across workspaces**, and cross-organization Connection inheritance.
- **Local, command-launched MCP servers added by hand.** Only network servers (`https`) may be
  added through this flow; locally-launched servers continue to come only from installed
  packages, which is the existing execution gate and stays untouched.
- **Migrating existing per-plugin secret settings into the Vault.** The two coexist; a later
  epic can bridge them.
- **Changing the tool-grant matrix.** It keeps its semantics and runs first; this epic adds a
  second, account-aware gate after it.
- **Approvals for outward-facing actions.** [AW-03](../README.md) owns that; a *Read and write*
  Connection still routes an outward action through the decision queue when policy says so.

## 9. Acceptance criteria

- [ ] Two Connections can exist on one provider; both work; one and only one is primary.
- [ ] Deleting the primary promotes the oldest remaining healthy Connection and says so.
- [ ] A Connection can be renamed; the label is unique per provider, case-insensitively.
- [ ] Connecting defaults to *Read only*; the connect flow never shows a raw provider scope.
- [ ] A provider whose plugin declares no presets shows "Standard access" and no chooser.
- [ ] Widening a preset that needs re-approval asks first and leaves the old preset on cancel.
- [ ] Narrowing a preset never asks for re-approval and binds within 5 seconds.
- [ ] An Agent grant of *Read only* under a *Read and write* Connection removes exactly that
      Agent's write tools and leaves the other Agents' tools intact.
- [ ] An Agent grant of *Read and write* under a *Read only* Connection resolves to *Read only*
      and the API reports both `requested` and `effective`.
- [ ] Setting an Agent to *Blocked* refuses its next call on that Connection within 5 seconds,
      before any outbound request, with no restart of anything, and the Run continues.
- [ ] A refused call appears exactly once in the Run log, naming the Connection and the reason,
      and never contains a credential.
- [ ] With grant resolution deliberately failing, an Agent falls back to the Connection's preset
      — never to *Read and write*.
- [ ] The scheduled sweep flips a revoked credential to *Expired* without any user action, and
      the page banner counts it.
- [ ] *Reconnect* returns the same row to *Healthy* keeping label, preset, primary flag and all
      grants; no second row appears.
- [ ] An unreachable server becomes *Unreachable*, not *Expired*, and is offered no *Reconnect*.
- [ ] Killing the health sweeper leaves every row rendering its last known state and blocks no
      call.
- [ ] "Last used" links to a Runs list containing exactly the Runs that used that Connection.
- [ ] A Vault value cannot be retrieved through any endpoint, export, log, error or Agent tool;
      every read is `●●●●●●●●`.
- [ ] `{{cred.acme_api_key}}` resolves at call time from the Vault and is absent from the Run
      transcript.
- [ ] A tool whose credential cannot be resolved is refused with a message naming the key.
- [ ] The 201st Vault entry and the 11th Connection on a provider are both refused with their
      own error codes and the exact copy in §7.9.
- [ ] Pasting a `"name": { … }` block with a trailing comma parses; the header value lands in
      the Vault and is not echoed.
- [ ] Pasting a URL for a server that signs in interactively shows *Open sign-in page* and
      settles to *Connected* without the user pasting anything back.
- [ ] A name that collides with an installed plugin id is refused and the pasted secret is not
      stored.
- [ ] Two different URLs produce two Connections; the same URL twice offers to open the first.
- [ ] A URL resolving to a private address is refused at connect and on every redirect hop.
- [ ] The existing MCP list, repository registry, per-plugin settings pages and per-agent MCP
      binding screen all still work unchanged.
- [ ] Every user-visible string above is an `en.json` key; no literal appears in a component.
- [ ] All functional requirements have a passing test (unit, controller spec, or e2e).

## 10. Open questions

- `[NEEDS CLARIFICATION: should the workspace-level grant (FR-17) be exposed in P2 or held to
  P3? It is one extra row and one extra select, but it is also a third place to look when
  debugging "why can't this agent…". Recommendation: ship it in P2 but collapse it by default.]`
- `[NEEDS CLARIFICATION: when a Connection is deleted, should its Run attribution keep the label
  as a frozen string, or resolve to "(disconnected)"? The spec assumes frozen label (FR-38);
  confirm with Design.]`
- `[NEEDS CLARIFICATION: 5 seconds is the stated worst-case grant propagation (FR-21). Confirm
  that a 5-second in-process cache is acceptable to Security, or whether an explicit
  invalidation signal is required for the blocked→ transition specifically.]`
- `[NEEDS CLARIFICATION: should a health transition to `expired` raise an item in My Decisions
  (AW-03) as well as a notification? It is a decision only the owner can make, which argues yes,
  but it is also not a mission blocker, which argues no.]`
- `[NEEDS CLARIFICATION: the per-provider cap is 10 (FR-2). Is that right for the agency use
  case, or should it be per-plan?]`
- `[NEEDS CLARIFICATION: which existing plugins get scope-preset declarations in P1? The spec
  assumes the git provider and the connector-category plugins; confirm the P1 list with
  Product.]`

## 11. Constitution gates

- [x] **I — Plugin-first.** No provider knowledge lands in core: presets and their tool coverage
      are declared by each plugin through a new capability. The MCP sign-in flow is a protocol
      handshake that names no particular service.
- [x] **II — Capability-driven.** Presets are resolved through a facade; no plugin id appears
      outside its own package.
- [x] **III — Source-of-truth repos.** Untouched — no content moves.
- [x] **IV — Job runtime.** The health sweep and every probe fan-out go through the configured
      job-runtime provider via dispatcher DI symbols.
- [x] **V — Forward-only migrations.** Three new tables and a small number of additive columns,
      each shipping its migration in the same PR.
- [x] **VI — Tests.** Unit tests for the resolution ladder and the config parser, controller
      specs for every new endpoint, e2e for the registry, the grant flow, the vault and the MCP
      wizard.
- [x] **VII — Secret hygiene.** Write-only vault, envelope encryption, masked reads, classified
      probe errors, activity-log entries naming fields and never values.
- [x] **VIII — Plugin counts.** No plugin is added or removed; the canonical plugin doc is
      untouched.
- [x] **IX — Behaviour-first.** This document names no class, file or endpoint.
- [x] **X — Backwards compatible.** Every existing endpoint, table, route and screen keeps
      working; everything here is additive.

## 12. References

- Program: [`../README.md`](../README.md)
- Related epics: [AW-09 Runs & receipts](../README.md) (the Runs list "last used" links into),
  [AW-16 Model accounts](../README.md), [AW-17 Costs & caps](../README.md),
  [AW-24 Safety rails](../README.md)
- Related specs in this repo: [`../../agent-plugins/spec.md`](../../agent-plugins/spec.md),
  [`../../policy-matrices/`](../../policy-matrices/), [`../../plugins-capabilities/`](../../plugins-capabilities/),
  [`../../connectors/`](../../connectors/)
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
