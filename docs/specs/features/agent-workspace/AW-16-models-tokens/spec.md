# Feature Specification: Model accounts, priority chains and fallbacks

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md).
> Describe **what** the system does, not how it's structured. Implementation lives in
> [`plan.md`](./plan.md); the ordered work lives in [`tasks.md`](./tasks.md).

**Epic ID**: `AW-16-models-tokens`
**Program**: [`agent-workspace`](../README.md)
**Branch**: `feat/aw-16-models-tokens`
**Status**: `Draft`
**Created**: 2026-09-06
**Last updated**: 2026-09-06
**Size**: M · **Blocking dependencies**: none
**Extends**: `plugins` (`ai-provider` capability), `agents`, `schedules`, `fleet`, `AgentRun`

---

## 0. TL;DR

Ever Works can hold exactly **one** credential per AI provider, has **no** cross-provider
fallback of any kind, exposes **no** reasoning control and **no** run deadline, warns about
**nothing** before a key dies, and records on a Run how many tokens it burned but not **which
model actually answered**. When a key expires at 02:00, every scheduled Agent stops, silently,
until somebody notices.

This epic makes the model layer something an owner can hold in their head:

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Settings → Models                                                       │
  │                                                                          │
  │  PROVIDER ACCOUNTS — the number IS the fallback order                    │
  │    Provider A   #1  "Company key"    Working        last used 3m ago     │
  │                 #2  "Overflow key"   Expires in 9d  last used 2d ago     │
  │    Provider B   #1  "Personal key"   Needs reconnect                     │
  │                                                                          │
  │  MODEL DEFAULTS — narrowest wins                                         │
  │    Workspace default ──► Agent override ──► Schedule override            │
  │       big-model            fast-model         fast-model                 │
  │                                                                          │
  │    If it can't answer:   1. other-big-model                              │
  │                          2. fast-model      (never the default itself)   │
  │                                                                          │
  │    Reasoning effort  Medium        Run timeout  15 minutes               │
  └──────────────────────────────────────────────────────────────────────────┘
                                    │
        one call fails ─────────────┤
                                    ▼
   attempt list = models in order × that model's accounts in order
       1. big-model      / Company key     429 rate limited   → next account
       2. big-model      / Overflow key    401 expired        → next model
       3. other-big-model/ Company key     OK  ────────────────► answered
                                    │
                                    ▼
   Run receipt: "Ran on other-big-model via Provider A, account 'Company key',
                 effort Medium — after 2 earlier attempts"
```

Three shippable phases:

- **P1** — Model Accounts (several per provider, ordered, encrypted, health-probed, expiry
  warnings) + the workspace / Agent / Schedule model ladder + what-actually-ran on every Run.
- **P2** — Failover: account chain, ordered fallback models that exclude the primary,
  cooldowns, reasoning effort, run timeout as a hard stop.
- **P3** — Getting credentials onto the computers agents control, and the sync signal that
  says when they have not arrived yet.

---

## 1. Overview

A workspace owner can register **several accounts per AI provider**, give each a name, and
put them in a numbered order — and that single numbered order **is** the failover order: if
the account at position 1 is rate-limited, expired or unreachable, the next one is tried, in
the order shown, with no second list to keep in sync. On top of the accounts sits a **model
ladder**: the workspace picks a default model, an Agent may override it, and a Schedule may
override that — so heavy reasoning runs on the best model while the hourly check runs on a
fast one. Each level may also carry an **ordered list of fallback models** that the platform
walks when the model above it is rate-limited, unreachable, or has no working account left —
and the list **never offers the current primary as its own fallback**, so a chain can never
loop back onto the model that just failed. Two workspace-wide defaults sit beside them: a
**reasoning effort** that says how hard models should think before answering, and a **run
timeout** that ends a stuck Run instead of letting it hang forever; a Schedule may override
either. Credentials are watched: an account that is going to expire says so **days before it
bites**, with a one-click reconnect, and an account that has already died raises a banner
naming what fell back to what. And when the agents in question run on the owner's own
computers, a **sync signal** says plainly that the newest credentials have not reached all of
them yet, with one action that sends them. Finally, every Run records the model, provider and
account that actually answered it — including every attempt that failed first — so "what did
this cost and on what" is answerable from the receipt rather than from a log.

## 2. Why now

### 2.1 The questions an owner asks that Ever Works cannot answer today

| The owner's question | What they do today | What is missing |
| --- | --- | --- |
| "Use my company key first and my personal key when it runs out." | Impossible. | A provider's credential is a single field on a single plugin settings record. There is no second account and nowhere to put an order. |
| "Everything stopped at 2am — why?" | Open Runs, open the failed one, read the error, guess. | Nothing watches credential expiry, nothing warns before it, and nothing tells the owner a key is the reason. |
| "Don't stall when the provider rate-limits me." | Nothing. The call fails and the Run fails. | There is no cross-provider fallback anywhere in the platform. The only automatic retry moves to a *more expensive tier of the same provider* on the *same* credential. |
| "Run my nightly digest on the cheap model." | Set the Agent's model — and every Run of that Agent changes, including the ones you wanted on the good model. | Overrides exist per Agent only. A Schedule cannot carry a model. |
| "Make it think harder on the research job." | Nothing. | There is no reasoning-effort setting at any level. The only reasoning behaviour that ships is an automatic, per-model-name rule that *suppresses* extended thinking; it is not configurable and not visible. |
| "Kill a run that has been stuck for an hour." | Wait for a platform-wide sweeper, or cancel by hand if you happen to look. | There is no per-workspace or per-schedule run deadline, and no per-call deadline at all. |
| "Which model actually answered this run?" | Cross-reference the run against the usage ledger by timestamp. | The Run record stores total tokens and a cost, but not the model, the provider or the account that produced them. |
| "Did my new key reach the machines?" | Log into each machine and check by hand. | Provider credentials on a computer an agent controls are placed there by hand, out of band, with nothing on either side reporting whether they match what the workspace holds. |

### 2.2 The four concrete gaps in the code we own

1. **One credential per provider, structurally.** Provider configuration lives in a plugin's
   settings record — one blob per provider per scope. A second account for the same provider
   has nowhere to exist, and consequently neither does an order, a per-account health state,
   or a per-account "last used".
2. **No fallback exists, and a setting pretends otherwise.** The only automatic retry in the
   model path escalates to a higher-complexity model alias **on the same provider and the same
   credential** — which is exactly the wrong move when the credential is the thing that failed.
   Meanwhile an operator-facing setup flow writes an ordered "fallback providers" value into
   configuration that **nothing at runtime ever reads**. The result is a documented feature
   that does not exist and cannot be observed to not exist.
3. **Three knobs the product talks about are not knobs.** Reasoning effort is a hardcoded,
   per-model-name rule with three values that only ever reduce thinking; there is no user
   control, and the interface type that other documentation says carries it does not have the
   field. There is no configurable AI-call deadline anywhere — the single timeout that exists
   is a fixed 15-second budget used by the "test connection" button. And model selection is
   accepted without checking the id against the catalogue, so a typo is persisted happily and
   fails much later at call time.
4. **Attribution stops at the ledger.** Per-call usage rows carry a model id; the Run record
   does not. So the Run receipt — the thing this program is building the whole cost story
   around — cannot say what ran without a join the receipt surface does not do.

### 2.3 Why this is one epic and not four

Accounts, model choice, fallbacks and effort are four faces of a single decision the platform
makes thousands of times a day: **which (model, provider, credential) triple answers this
call, and what happens when it can't.** Split across four epics they become four resolvers
that disagree — a fallback list that names a model with no working account, an Agent override
that silently ignores the workspace's effort setting, a run deadline that fires while a
fallback attempt is still in flight. Built together they are **one ordered attempt list, built
once per call, recorded once per Run**. Credential delivery to computers is in the same epic
for the same reason: an account is only real once the thing that uses it has it.

## 3. User scenarios

### 3.1 Primary scenarios

- **S1 — a second account on the same provider.**
  **Given** an owner with one account on a provider, labelled "Company key",
  **when** they open Settings → Models → *Add account* on that provider, paste a second
  credential and name it "Overflow key",
  **then** both appear as numbered rows under that provider — "Company key" at **#1**,
  "Overflow key" at **#2** — and the panel says "Agents use them in this order."

- **S2 — the order is the fallback order, and reordering takes three actions.**
  **Given** two accounts on one provider,
  **when** the owner presses *Move up* on "Overflow key" and *Save*,
  **then** the numbers swap, a toast reads "Order saved. Agents pick it up on their next
  call.", and the next Agent call that reaches that provider tries "Overflow key" first —
  with no restart of any Agent, Run, worker or process.

- **S3 — a rate limit falls through to the next account, not to a different model.**
  **Given** a provider with accounts #1 and #2 and an Agent whose model belongs to it,
  **when** a call on account #1 comes back rate-limited,
  **then** the same model is retried on account #2 within the same call, the Run does not
  fail, and the Run receipt lists both attempts with the first marked "rate limited".

- **S4 — an expired credential falls through to the next model.**
  **Given** a provider whose only account has an expired credential, and a workspace fallback
  chain whose first entry belongs to a different provider,
  **when** an Agent makes a call,
  **then** the credential failure is not retried on the same provider, the next model in the
  chain answers, the Run completes, and the receipt reads "after 1 earlier attempt".

- **S5 — the workspace picks the default model.**
  **Given** an owner in Settings → Models → *Model defaults*,
  **when** they choose a default model from the picker,
  **then** every Agent and every Schedule that has not overridden it uses that model on their
  next Run, and each override control elsewhere shows "Workspace default ({model})" as its
  first option.

- **S6 — an Agent overrides the workspace.**
  **Given** a workspace default of a large model,
  **when** the owner opens an Agent → Settings → *Model* and selects a fast model,
  **then** that Agent's Runs use the fast model, every other Agent is untouched, and the
  Agent's panel shows "Overriding the workspace default" with a *Reset to workspace default*
  link.

- **S7 — a Schedule overrides the Agent.**
  **Given** an Agent set to a large model with an hourly schedule attached,
  **when** the owner opens that schedule's *Model for this schedule* drawer and picks a fast
  model,
  **then** the hourly Runs use the fast model, a manual Run of the same Agent uses the large
  model, and both receipts say which one ran.

- **S8 — the fallback list refuses to offer the primary.**
  **Given** a policy whose primary model is `M`,
  **when** the owner opens *Add a fallback*,
  **then** `M` is absent from the list — not greyed, absent — and the helper text reads "Your
  default model is never offered as its own fallback."

- **S9 — changing the primary repairs the chain.**
  **Given** a chain of primary `M1` with fallbacks `M2`, `M3`,
  **when** the owner changes the primary to `M2`,
  **then** `M2` is removed from the fallback list automatically, the list becomes `M3`, and an
  inline note reads "Removed M2 from the fallbacks — it's your default now."

- **S10 — expiry is announced before it bites.**
  **Given** an account whose credential expires in 9 days,
  **when** the owner next loads any dashboard page,
  **then** the account row shows "Expires in 9 days", and at 3 days a dashboard banner appears
  reading "{label} expires in 2 days. Reconnect →" that links straight to that row.

- **S11 — reconnect keeps everything.**
  **Given** an expired account at position #2 with a name and a usage history,
  **when** the owner presses *Reconnect* and supplies a fresh credential,
  **then** the same row returns to *Working*, keeping its position, its name, its history, and
  every policy that referenced it — no second row is created and no order is re-asked.

- **S12 — a stuck run ends instead of hanging.**
  **Given** a workspace run timeout of 15 minutes,
  **when** a Run is still going 15 minutes after it started,
  **then** it ends as failed with the reason "Run timed out after 15 minutes", the receipt
  records the routing that was in flight, and the next scheduled Run starts normally.

- **S13 — reasoning effort is a choice with consequences shown.**
  **Given** the workspace effort default of *Medium*,
  **when** the owner sets a research Agent to *High*,
  **then** that Agent's calls request the provider's high reasoning setting where the chosen
  model supports one, the Agent panel shows "High — costs more and takes longer", and Runs of
  that Agent record `effort: high`.

- **S14 — the credentials have not reached the computers.**
  **Given** three computers enrolled in the fleet and a provider account added five minutes
  ago,
  **when** the owner loads Settings → Models,
  **then** a banner reads "3 computers don't have your latest provider accounts yet. Send now
  →", and pressing *Send now* marks them and each computer applies the change on its next
  check-in, with the banner clearing on its own once all three report the current version.

### 3.2 Edge cases and failures

- **S15 — the credential is rejected at the moment it is added.**
  **Given** an owner pasting a credential,
  **when** the pre-save check fails against the provider,
  **then** nothing is saved, no row appears, and the dialog says "That key didn't work with
  {provider}. Nothing was saved." with the credential field retained so they can fix a typo.

- **S16 — the credential is valid but the provider has no models to list.**
  **Given** a provider whose catalogue cannot be fetched without a working key,
  **when** the account saves successfully but the catalogue call returns nothing,
  **then** the account is created and healthy, the model picker for that provider shows
  "Couldn't load this provider's models. You can still type a model id." and accepts a
  free-typed id — marked with a warning triangle and the tooltip "Not in the catalogue we can
  see. Double-check the spelling."

- **S17 — two people reorder at once.**
  **Given** two owners with Settings → Models open,
  **when** both save a different order,
  **then** the second save is refused with "Someone changed this while you were editing. We
  reloaded the order — check it and save again.", the list refreshes to the stored order, and
  no partial order is ever persisted.

- **S18 — removing the last working account for a model in active use.**
  **Given** a provider with one account, referenced by the workspace default model,
  **when** the owner presses *Remove*,
  **then** the confirm dialog names the consequence — "'{label}' is the only account for
  {provider}, and 4 agents route to a {provider} model. Removing it makes those runs fall back
  to {nextModel}." — and if there is no fallback at all it instead reads "…those runs will
  stop until you add an account or pick a different model." The owner must type nothing; one
  confirm is enough.

- **S19 — every attempt fails.**
  **Given** a chain of a primary and two fallbacks, all of whose accounts are exhausted,
  **when** an Agent makes a call,
  **then** the Run fails once — not once per attempt — the run log carries a single line "No
  model could answer: tried 4 of 4. Last error: rate limited.", the receipt lists all four
  attempts with their reasons, and no further attempts are made for that call.

- **S20 — a budget cap stops the call.**
  **Given** a workspace or mission budget that is already blocked,
  **when** an Agent makes a call,
  **then** the call is refused **before** any attempt is made, **no fallback is tried**, and
  the message is "Stopped by your budget cap, not by a model. Fallbacks were not tried." —
  because falling back would spend money the owner has already said not to spend.

- **S21 — a bad request is not a fallback trigger.**
  **Given** a call that the provider rejects as malformed or with an unknown model id,
  **when** the error comes back,
  **then** the platform does **not** walk the chain (the next model would fail identically),
  the Run fails immediately, and the message names the model id that was rejected.

- **S22 — except when the request is too big.**
  **Given** a call rejected because it exceeds the model's context window,
  **when** a later entry in the chain has a larger context window,
  **then** the platform moves to that entry and records the reason as "prompt too large for
  {model}", and if no later entry is larger it fails immediately without pointless attempts.

- **S23 — a paused account is skipped, not failed over.**
  **Given** an account the owner has paused,
  **when** the chain is built,
  **then** the paused account is simply absent from the attempt list — it does not count
  toward the attempt ceiling, it produces no error, and the row reads "Paused — agents skip
  this one."

- **S24 — the chain would exceed the attempt ceiling.**
  **Given** a chain that expands to more than 6 (model, account) pairs,
  **when** a call is made,
  **then** only the first 6 are attempted, the receipt says "stopped after 6 attempts", and
  the settings page shows an inline note on save: "This chain can expand to {n} attempts. Only
  the first 6 are tried."

- **S25 — a model in a chain has no account at all.**
  **Given** a fallback entry whose provider has no account, or only paused ones,
  **when** the owner saves,
  **then** the save succeeds but the entry is badged "No account — this step will be skipped",
  and it is genuinely skipped at call time without consuming an attempt.

- **S26 — a computer never comes back.**
  **Given** a push to computers with one machine offline,
  **when** ten minutes pass with no check-in from it,
  **then** the sync banner stops counting it as pending and reads "1 computer hasn't checked
  in since {time}. It will pick this up when it comes back." — the banner does not block, does
  not retry forever, and does not claim success.

- **S27 — a viewer opens the page.**
  **Given** a workspace member without permission to change model settings,
  **when** they open Settings → Models,
  **then** they see the accounts, their health and the defaults in full, every control is
  disabled with the tooltip "Only workspace admins can change model settings", and no
  credential value — masked or otherwise — is present anywhere in what the page received.

- **S28 — the settings service is unreachable.**
  **Given** the model settings cannot be loaded,
  **when** the owner opens Settings → Models,
  **then** the page renders its shell with a single error panel reading "Couldn't load your
  model settings. Your agents are unaffected — they're using the settings they already have."
  and a *Try again* button. It never renders an empty state that implies nothing is
  configured.

- **S29 — a Run in flight when the policy changes.**
  **Given** a Run that is mid-execution,
  **when** the owner changes the workspace default model,
  **then** the in-flight Run keeps the routing it resolved at its start — the receipt shows
  the model that actually ran — and the *next* Run picks up the new default.

- **S30 — the run timeout is set below what a schedule needs.**
  **Given** a workspace run timeout of 5 minutes and a schedule whose Runs historically take
  20,
  **when** the owner saves the 5-minute value,
  **then** the save succeeds and an inline note reads "3 schedules have runs that usually take
  longer than this. They'll start timing out." with a link to those schedules — a warning, not
  a block.

## 4. Functional requirements

Every default, limit and threshold in this section is a number, and every number is testable.
The consolidated table is §4.11.

### 4.1 Provider accounts

- **FR-1** The system MUST let an owner register more than one account for the same AI
  provider within one workspace, up to **8** accounts per provider.
- **FR-2** The system MUST cap the total number of provider accounts in one workspace at
  **32**, and MUST refuse account 33 with a message naming the limit.
- **FR-3** Each account MUST carry an owner-chosen **name** of 1–60 characters, unique within
  its provider in that workspace, and MUST reject a duplicate name with "You already have an
  account called '{name}'."
- **FR-4** Each account MUST carry a **position** — a contiguous integer from 1 to N within
  its provider — and the system MUST renumber the remaining accounts to stay contiguous when
  one is removed.
- **FR-5** The system MUST present the position as the account's failover order and MUST NOT
  offer any second ordering concept for the same accounts.
- **FR-6** Reordering MUST be possible in at most **three** interactions from the list view
  (move, move, save) and MUST NOT require re-entering any credential.
- **FR-7** An account MUST be **pausable** and **resumable** without losing its position, its
  name, its credential or its history.
- **FR-8** The system MUST let an owner replace an account's credential in place, keeping the
  same account row, position, name and history.
- **FR-9** Before an account is created or its credential replaced, the system MUST verify the
  credential against the provider and MUST NOT persist a credential that fails verification.
- **FR-10** The system MUST record on each account when it was **last used** by a call, to
  minute precision, and MUST link that to the Runs that used it.
- **FR-11** Removing an account MUST require one confirmation that names the concrete
  consequence: how many Agents route to that provider today and what they will fall back to,
  or that they will stop.
- **FR-12** Account changes (create, rename, reorder, pause, resume, credential replace,
  remove) MUST each write one activity-log entry naming the account and the field, and MUST
  NOT write the credential value.
- **FR-13** The available providers MUST be exactly those that installed plugins declare an
  AI-provider capability for. The system MUST NOT contain a built-in list of provider names.
- **FR-14** Each provider's credential field names, labels and secrecy MUST come from that
  provider's own declared settings schema; the system MUST NOT assume every provider
  authenticates with a single key.

### 4.2 The priority chain and account failover

- **FR-15** For a given model, the system MUST build the account attempt order from that
  model's provider's accounts, in ascending position, skipping accounts that are paused or in
  cooldown.
- **FR-16** A call that fails with a **rate-limit** signal MUST be retried on the next account
  for the same provider with the **same** model.
- **FR-17** A call that fails with a **credential** signal (rejected or forbidden) MUST mark
  that account as needing reconnection immediately, and MUST retry on the next account.
- **FR-18** A call that fails with a **transient** signal (server error, network failure,
  attempt deadline) MUST retry on the next account for the same provider before moving to the
  next model.
- **FR-19** When every account for a model's provider is exhausted or skipped, the system MUST
  move to the next model in the fallback chain.
- **FR-20** An account that failed with a credential signal MUST be skipped for **15 minutes**.
- **FR-21** An account that failed with a rate-limit signal MUST be skipped for the provider's
  stated retry delay, or **60 seconds** if none was stated, capped at **30 minutes**.
- **FR-22** An account that failed with a transient signal MUST be skipped for **60 seconds**,
  and for **5 minutes** after **3** such failures within a **5-minute** window.
- **FR-23** The system MUST NOT attempt the same (model, account) pair more than once within
  one call.
- **FR-24** The system MUST stop after **6** attempts within one call regardless of how long
  the chain is, and MUST record that it stopped for that reason.

### 4.3 The model ladder

- **FR-25** The system MUST support a **workspace default model**, expressed as a provider and
  a model id together.
- **FR-26** An Agent MUST be able to override the workspace default model, and MUST be able to
  return to inheriting it in one action.
- **FR-27** A Schedule MUST be able to override the model of the Agent it runs, and MUST be
  able to return to inheriting it in one action.
- **FR-28** Resolution order MUST be exactly: schedule override, then agent override, then
  workspace default, then the provider plugin's own default. Narrowest wins.
- **FR-29** Every override control MUST show the value it is overriding, by name, at the point
  of choice.
- **FR-30** A model selection MUST be validated against the visible catalogue for its provider
  at save time; an id absent from the catalogue MUST still be accepted but MUST be marked as
  unverified, both at save and in the settings list.
- **FR-31** A policy change MUST take effect on the next call an Agent makes, within **5
  seconds** of the save, with no restart of any Agent, Run, worker or process.
- **FR-32** A Run that has already started MUST keep the routing it resolved when it started,
  even if the policy changes mid-Run.
- **FR-33** The system MUST NOT silently substitute a model. Any substitution is a recorded
  fallback attempt with a reason.
- **FR-34** Deleting an Agent or a Schedule MUST delete its override and MUST NOT leave the
  workspace default changed.
- **FR-35** A workspace with no default model configured MUST continue to behave exactly as
  today — the provider plugin's own default answers — and the settings page MUST say so rather
  than showing an empty value.
- **FR-36** The system MUST NOT require a workspace default before an Agent override can be
  set.

### 4.4 Fallback models

- **FR-37** Each policy level (workspace, agent, schedule) MUST be able to carry an **ordered
  list of fallback models**, each a provider and model id together.
- **FR-38** A policy MUST allow at most **3** fallback entries.
- **FR-39** The fallback picker MUST NOT offer the policy's current primary model, and the
  saved list MUST NOT contain it.
- **FR-40** Changing a policy's primary to a model already in its fallback list MUST remove
  that entry from the list automatically and MUST tell the owner it did.
- **FR-41** The fallback list MUST NOT contain the same (provider, model) pair twice.
- **FR-42** A fallback entry whose provider has no usable account MUST be badged as skippable
  at save time and MUST be skipped at call time without consuming an attempt.
- **FR-43** Fallback MUST be triggered by rate-limit, credential and transient signals only.
- **FR-44** Fallback MUST NOT be triggered by a malformed-request or unknown-model rejection.
- **FR-45** The system SHOULD move to the next chain entry on a context-length rejection when
  and only when a later entry has a larger known context window.
- **FR-46** A budget block MUST stop the call outright and MUST NOT trigger any fallback
  attempt.

### 4.5 Reasoning effort

- **FR-47** The workspace MUST carry a default **reasoning effort** with exactly four values:
  `minimal`, `low`, `medium`, `high`. The default MUST be `medium`.
- **FR-48** An Agent MUST be able to override the workspace effort; a Schedule MUST be able to
  override the Agent's.
- **FR-49** The effort MUST be applied to a call as the provider's own nearest equivalent
  control when the chosen model exposes one.
- **FR-50** When the chosen model exposes no reasoning control, the effort MUST be ignored
  silently at call time and MUST be recorded on the Run as not applicable.
- **FR-51** The effort control MUST state its trade-off in plain words at the point of choice
  — higher costs more and takes longer.
- **FR-52** The system MUST NOT change the existing automatic per-model reasoning behaviour
  for any workspace that has not set an effort; `medium` MUST be behaviour-neutral on upgrade.

### 4.6 Run timeout

- **FR-53** The workspace MUST carry a default **run timeout** in seconds, defaulting to
  **900** (15 minutes), settable between **60** and **7200** (2 hours).
- **FR-54** A Schedule MUST be able to override the run timeout within the same bounds.
- **FR-55** A Run still executing at its timeout MUST be ended, not warned about, and MUST
  come to rest as failed with the reason "Run timed out after {n} minutes".
- **FR-56** A timed-out Run MUST record the routing that was in flight when it was ended.
- **FR-57** Each individual model attempt MUST carry its own deadline of **120 seconds** by
  default, settable between **15** and **600**, and a breached attempt deadline MUST be
  treated as a transient failure (FR-18) rather than a Run failure.
- **FR-58** The sum of attempt deadlines MUST NOT be able to exceed the run timeout; the
  system MUST clamp the last attempt's deadline to the remaining run budget.
- **FR-59** Saving a run timeout shorter than the recent typical duration of existing
  Schedules MUST warn, naming how many, and MUST NOT block the save.

### 4.7 Credential health and expiry

- **FR-60** Every account MUST carry a health state from exactly: `working`, `expiring`,
  `expired`, `invalid`, `paused`, `unknown`.
- **FR-61** The system MUST probe every non-paused account's health at least every **6 hours**.
- **FR-62** A probe MUST NOT consume a paid model call where the provider offers a cheaper
  identity or catalogue check.
- **FR-63** An account with a known expiry MUST become `expiring` **14 days** before it, and
  MUST raise a dashboard banner at **3 days**.
- **FR-64** An account that has expired or been rejected MUST become `expired`/`invalid`
  within one probe cycle, or immediately if a live call sees the rejection first.
- **FR-65** Every unhealthy account row MUST offer **Reconnect** inline, and reconnecting MUST
  preserve position, name, history and every policy reference.
- **FR-66** A dashboard banner MUST appear when any account in the active workspace is
  `expiring` within 3 days, `expired` or `invalid`, and MUST name the account and the
  consequence.
- **FR-67** The banner MUST be dismissible per browser and MUST reappear when the set of
  unhealthy accounts changes.
- **FR-68** When an account becomes `expired` or `invalid`, the system MUST state what agents
  fall back to, or that they will stop.
- **FR-69** Health probing MUST never itself fail a Run, block a page render, or change an
  account's position.

### 4.8 Credential sync to computers

- **FR-70** The workspace MUST carry a monotonically increasing **bundle version** that
  advances on any change to accounts, their order, their credentials, or the model policies.
- **FR-71** Each enrolled computer MUST report the bundle version it has applied on its
  regular check-in.
- **FR-72** A computer is **out of sync** when its applied version is lower than the current
  version.
- **FR-73** The system MUST show a sync signal naming the number of out-of-sync computers,
  with a single action that sends the current bundle.
- **FR-74** A sent bundle MUST be applied by an online computer within **2 minutes** at the
  95th percentile.
- **FR-75** A computer that has not checked in for **10 minutes** MUST be reported separately
  as not currently reachable, with the time of its last check-in, and MUST NOT be counted as a
  pending send.
- **FR-76** The sync signal MUST clear on its own once every reachable computer reports the
  current version — with no user action.
- **FR-77** Credential material sent to a computer MUST be transported only over an
  authenticated channel bound to that computer's own credential, MUST be stored by the
  computer in its operating system's secret store where one is available, and MUST NOT be
  written to any log on either side.
- **FR-78** A workspace with no enrolled computers MUST show no sync signal at all.

### 4.9 What actually ran

- **FR-79** Every Run MUST record the provider, model id and account name that produced its
  answer.
- **FR-80** Every Run MUST record the reasoning effort that was requested, or that none
  applied.
- **FR-81** Every Run that fell back MUST record each earlier attempt in order, with its
  model, its account and its failure reason.
- **FR-82** The recorded routing MUST be what actually executed, never what was configured.
- **FR-83** The routing record MUST NOT contain any credential value, in whole or in part.
- **FR-84** A Run that made no model call MUST record no routing rather than a misleading
  default.

### 4.10 Permission and secrecy

- **FR-85** Only a workspace administrator MUST be able to create, reorder, pause, replace,
  reconnect or remove a provider account, or change any model default.
- **FR-86** Any workspace member MUST be able to read accounts, their names, positions and
  health, and every model default.
- **FR-87** The system MUST NOT return a credential value — whole, partial, masked or hashed —
  in any response, to any role, at any time, including immediately after it is saved.
- **FR-88** Credential values MUST be encrypted at rest.
- **FR-89** Activity-log entries about credentials MUST name the field, never the value.
- **FR-90** The system MUST NOT log a credential value in any error, trace, breadcrumb or
  metric.
- **FR-91** The system MUST NOT add a markup, margin or metering layer over provider spend;
  what a provider bills the owner's own account is what the owner pays.
- **FR-92** The system MUST NOT purchase, top up or extend any provider account balance or
  subscription on the owner's behalf.
- **FR-93** The system MUST NOT change a model, an order, an effort or a timeout by itself.
  Every value in this epic changes only because a person changed it.

### 4.11 Every number in this spec

| Thing | Value |
| --- | --- |
| Accounts per provider per workspace | max **8** |
| Provider accounts per workspace | max **32** |
| Account name length | **1–60** characters |
| Fallback entries per policy | max **3** |
| Attempts per call | max **6** |
| Per-attempt deadline | default **120 s**, range **15–600 s** |
| Run timeout | default **900 s**, range **60–7200 s** |
| Reasoning effort | `minimal` \| `low` \| `medium` \| `high`, default **medium** |
| Health probe cadence | every **6 hours** |
| Expiry: warn from | **14 days** before |
| Expiry: banner from | **3 days** before |
| Cooldown after credential failure | **15 minutes** |
| Cooldown after rate limit | stated delay, else **60 s**, capped **30 min** |
| Cooldown after transient failure | **60 s**; **5 min** after **3** in **5 min** |
| Policy change takes effect | next call, within **5 s** |
| Bundle reaches a computer | within **2 min** at p95 |
| Computer considered unreachable after | **10 minutes** without check-in |
| Settings page first paint | within **1.5 s** at p95 |

## 5. Key entities

| Entity | New? | What it is |
| --- | --- | --- |
| **Model Account** | **New** | One set of credentials for one AI provider, held by a workspace, carrying a name, a position, a health state and a last-used time. Several may exist for the same provider; the position is the failover order. |
| **Model Policy** | **New** | The routing decision at one scope: a primary model, an ordered fallback list, a reasoning effort and a run timeout. Exists at workspace, Agent and Schedule scope; the narrowest one that sets a field wins that field. |
| **Model Bundle version** | **New** (a counter, not a noun users name) | A single increasing number per workspace that says "the model configuration changed". Computers report the version they have applied; a mismatch is the sync signal. |
| **Run routing record** | **New** (part of an existing entity) | What actually answered a Run: provider, model, account name, effort, and every earlier attempt with its reason. Lives on the Run. |
| Agent | Existing | Gains an optional Model Policy at Agent scope. Its existing single provider/model fields keep working and are read as a policy of one. |
| Schedule | Existing | Gains an optional Model Policy at Schedule scope, and an optional run-timeout override. |
| Run | Existing | Gains the routing record above. |
| Plugin | Existing | Providers are exactly the installed plugins that declare the AI-provider capability. This epic adds no provider list of its own. |
| Node / Fleet | Existing | A computer an agent controls. Reports its applied bundle version; receives sent bundles. Called "computer" in UI copy only. |
| Organization / Workspace | Existing | The scope every Model Account and workspace-level Model Policy belongs to. |

### 5.1 Two new nouns, and why each is not a synonym of something we have

**Model Account** is not the same thing as a Connection. A Connection (AW-15) is an account a
*tool* calls, gated by a scope preset and per-agent grants, and asked "may this Agent use you
for this tool". A Model Account is an account the *model resolver* calls, gated by nothing but
its position in a chain, and asked "can you answer right now, and if not, who's next". They
share the English word "account" and nothing else: different consumer, different lifecycle,
different failure semantics, different UI. Merging them would put a failover position on a
calendar connection and a scope preset on a model key. If both epics ship, the Connections
registry may *list* Model Accounts read-only for discoverability — see §9.

**Model Policy** is not a synonym of settings. It is the one place three levels of override
resolve, so that the workspace, an Agent and a Schedule cannot express contradictory routing.
Without it, the same four fields would have to be duplicated onto Agent, onto every kind of
Schedule, and onto the workspace, and each copy would drift.

> Per the program's rule 2, both nouns are added to the vocabulary table in
> [`README.md`](../README.md) in the same PR that lands this spec.

### 5.2 States and transitions

**Model Account health**

```
                      ┌──────── probe ok ────────┐
                      ▼                          │
  (created) ──► unknown ──► working ──────────────┤
                              │  │                │
              expiry ≤14d ────┘  │ 401/403 or     │
                      ▼          │ probe reject   │
                  expiring ──────┤                │
                      │          ▼                │
              expiry reached ► expired ─┐         │
                                        ├─ Reconnect (keeps position,
                                invalid ┘   name, history) ──► working
  any state ──► paused (owner) ──► resumes to its previous state
```

- `unknown` — created, or never probed since the platform restarted. Usable.
- `working` — last probe or live call succeeded.
- `expiring` — a known expiry is within 14 days. Fully usable.
- `expired` — the known expiry has passed.
- `invalid` — the provider rejected the credential.
- `paused` — the owner switched it off. Skipped by every chain; not an error.

**Model Policy** has no lifecycle of its own — it exists or it does not, and a scope with no
policy inherits the next one out. Deleting the scope deletes the policy.

### 5.3 The resolution ladder — the one rule

```
  For every call an Agent makes:

    effort   = schedule.effort   ?? agent.effort   ?? workspace.effort   ?? medium
    timeout  = schedule.timeout  ?? workspace.timeout ?? 900s
    chain    = schedule.chain    ?? agent.chain    ?? workspace.chain    ?? [provider default]

    attempts = for each (provider, model) in chain, in order:
                 for each account of provider, by position, skipping
                 paused and cooling-down accounts:
                   → attempt (model, account)
               truncated at 6

    first success wins.  first budget block stops everything.
    every attempt, successful or not, is recorded on the Run.
```

Fields resolve **independently**: a Schedule that sets only the model still inherits the
workspace's effort and timeout. There is no all-or-nothing override.

## 6. UX

Every surface below is new unless marked. All copy is the literal user-visible string.

### 6.1 Settings → Models — loaded

```
┌─ Settings ─────────────────┬──────────────────────────────────────────────────────┐
│ Profile                    │  Models                                              │
│ Organization               │  Your provider accounts, and which model does which   │
│ …                          │  job.                                                │
│ Environments               │                                                      │
│ Connections                │  ⚠ 3 computers don't have your latest provider       │
│ ▸ Models              ◀    │    accounts yet.                     [ Send now ]    │
│ Job Runtime                │                                                      │
│ Billing                    │  ── PROVIDER ACCOUNTS ──────────────────────────────  │
│ Usage & Credits            │  Agents use them in this order. Number 1 first, and   │
│                            │  the next one whenever the one above can't answer.    │
│                            │                                                      │
│                            │  Provider A                        [ Add account ]   │
│                            │  ┌────────────────────────────────────────────────┐  │
│                            │  │ ⠿ #1  Company key      ● Working               │  │
│                            │  │       last used 3 minutes ago            [···] │  │
│                            │  ├────────────────────────────────────────────────┤  │
│                            │  │ ⠿ #2  Overflow key     ◐ Expires in 9 days     │  │
│                            │  │       last used 2 days ago               [···] │  │
│                            │  └────────────────────────────────────────────────┘  │
│                            │                                                      │
│                            │  Provider B                        [ Add account ]   │
│                            │  ┌────────────────────────────────────────────────┐  │
│                            │  │ ⠿ #1  Personal key     ✕ Needs reconnect        │  │
│                            │  │       last used 6 hours ago   [ Reconnect ][···]│  │
│                            │  └────────────────────────────────────────────────┘  │
│                            │                                                      │
│                            │  ── MODEL DEFAULTS ─────────────────────────────────  │
│                            │  Default model                                       │
│                            │  [ big-model-id            ▾ ]  Provider A           │
│                            │                                                      │
│                            │  If it can't answer                                  │
│                            │  ┌────────────────────────────────────────────────┐  │
│                            │  │ 1. other-big-model   Provider B          [ ✕ ] │  │
│                            │  │ 2. fast-model        Provider A          [ ✕ ] │  │
│                            │  └────────────────────────────────────────────────┘  │
│                            │  [ + Add a fallback ]                                │
│                            │  Tried in order when the model above is rate-limited, │
│                            │  unreachable, or has no working account. Your default │
│                            │  model is never offered as its own fallback.          │
│                            │                                                      │
│                            │  Reasoning effort                                    │
│                            │  ( ) Minimal  ( ) Low  (•) Medium  ( ) High           │
│                            │  How hard models think before answering. Higher costs │
│                            │  more and takes longer.                              │
│                            │                                                      │
│                            │  Run timeout                                         │
│                            │  [  15  ] minutes                                    │
│                            │  A run still going after this ends instead of hanging.│
│                            │  Between 1 minute and 2 hours.                        │
│                            │                                                      │
│                            │                       [ Discard ]  [ Save defaults ] │
└────────────────────────────┴──────────────────────────────────────────────────────┘
```

Row menu `[···]`: `Move up` · `Move down` · `Rename` · `Replace key` · `Pause` ·
`Remove`. On a paused row the item reads `Resume`.

### 6.2 Loading, empty, error, over-limit, read-only

```
LOADING                                  EMPTY (no accounts at all)
┌──────────────────────────────────┐     ┌──────────────────────────────────────────┐
│ Models                           │     │ Models                                   │
│ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒           │     │                                          │
│ ┌──────────────────────────────┐ │     │  No provider accounts yet.               │
│ │ ▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒           │ │     │  Add one and every agent can use it —    │
│ │ ▒▒▒▒▒▒      ▒▒▒▒▒▒▒▒▒        │ │     │  billed to your own account with that    │
│ └──────────────────────────────┘ │     │  provider, with nothing added on top.    │
│ (skeleton, 3 rows, no spinner)   │     │             [ Add your first account ]   │
└──────────────────────────────────┘     └──────────────────────────────────────────┘

ERROR                                    OVER LIMIT (per provider)
┌──────────────────────────────────────┐ ┌──────────────────────────────────────────┐
│ ⚠ Couldn't load your model settings. │ │ You've reached 8 accounts for Provider A.│
│   Your agents are unaffected —       │ │ Remove one before adding another.        │
│   they're using the settings they    │ │                          [ Add account ] │
│   already have.                      │ │                          (disabled)      │
│                     [ Try again ]    │ └──────────────────────────────────────────┘
└──────────────────────────────────────┘
                                         OVER LIMIT (workspace)
READ-ONLY (not an admin)                 ┌──────────────────────────────────────────┐
┌──────────────────────────────────────┐ │ You've reached 32 provider accounts in   │
│ every control disabled, tooltip:     │ │ this workspace.                          │
│ "Only workspace admins can change    │ └──────────────────────────────────────────┘
│  model settings"                     │
└──────────────────────────────────────┘
```

### 6.3 Add account

```
┌─ Add an account — Provider A ─────────────────────────────────┐
│                                                               │
│  Name this account                                            │
│  [ Company key                                             ]  │
│  Just for you — agents never see it.                          │
│                                                               │
│  API key                                                      │
│  [ ••••••••••••••••••••••••••••••••••••••••••••••••••••• ]    │
│  Stored encrypted. Nobody — not you, not an agent, not an     │
│  export — can read it back out.                               │
│                                                               │
│  Position                                                     │
│  ( ) First — try this before the others                       │
│  (•) Last  — try this after the others            (#3)        │
│                                                               │
│  Billing goes to your own account with Provider A. Ever Works │
│  adds nothing on top and never buys credit for you.           │
│                                                               │
│                              [ Cancel ]  [ Check and add ]    │
└───────────────────────────────────────────────────────────────┘

  ┌─ checking ──────────────┐   ┌─ failed ───────────────────────────────────┐
  │ Checking with Provider A│   │ ✕ That key didn't work with Provider A.    │
  │ … (button disabled)     │   │   Nothing was saved.                       │
  └─────────────────────────┘   │   [ Cancel ]  [ Check and add ]            │
                                └────────────────────────────────────────────┘
```

The credential field is write-only. After a successful save the dialog closes and the field
is never re-rendered with any value; the row's menu offers *Replace key*, never *Show key*.

### 6.4 The fallback picker — the primary is absent

```
┌─ Add a fallback ──────────────────────────────────────────────┐
│  [ /  search models…                                       ]  │
│                                                               │
│  Provider A                                                   │
│    fast-model                             ● 2 accounts        │
│    cheap-model                            ● 2 accounts        │
│  Provider B                                                   │
│    other-big-model                        ✕ no account        │
│    other-fast-model                       ✕ no account        │
│                                                               │
│  Your default model (big-model-id) isn't listed — the chain   │
│  always has to move to a genuinely different model.           │
│                                                               │
│  ✕ no account  ·  this step will be skipped until you add one │
│                                                               │
│                              [ Cancel ]  [ Add to chain ]     │
└───────────────────────────────────────────────────────────────┘
```

When the owner changes the primary to a model already in the chain, an inline note replaces
the removed row for 6 seconds:

> Removed **other-big-model** from the fallbacks — it's your default now.

When the chain expands past the attempt ceiling, an inline note appears under the list on
save:

> This chain can expand to 9 attempts. Only the first 6 are tried.

### 6.5 Agent → Settings → Model

```
┌─ Model ───────────────────────────────────────────────────────┐
│                                                               │
│  (•) Use the workspace default — big-model-id (Provider A)    │
│  ( ) Choose for this agent                                    │
│                                                               │
│      Model            [ fast-model            ▾ ] Provider A  │
│      If it can't answer                                       │
│        1. cheap-model   Provider A                    [ ✕ ]   │
│      [ + Add a fallback ]                                     │
│                                                               │
│      Reasoning effort                                         │
│      ( ) Minimal ( ) Low (•) Medium ( ) High                  │
│      Workspace default is Medium.        [ Use workspace ]    │
│                                                               │
│  Overriding the workspace default.       [ Reset to default ] │
│                                    [ Discard ]  [ Save ]      │
└───────────────────────────────────────────────────────────────┘
```

### 6.6 Model for this schedule

```
┌─ Model for this schedule ─────────────────────────────────────┐
│  Nightly research · every day at 02:00 · Agent "Scout"        │
│                                                               │
│  (•) Inherit from Scout — fast-model (Provider A)             │
│  ( ) Choose for this schedule                                 │
│                                                               │
│      Model            [ big-model-id          ▾ ] Provider A  │
│      Reasoning effort ( ) Minimal ( ) Low ( ) Medium (•) High │
│      Run timeout      [  45  ] minutes                        │
│                                                               │
│  Run the heavy thinking on your best model and the hourly     │
│  checks on a fast one.                                        │
│                                    [ Cancel ]  [ Save ]       │
└───────────────────────────────────────────────────────────────┘
```

### 6.7 Banners

```
EXPIRY — one account
┌────────────────────────────────────────────────────────────────────────────┐
│ ◐  "Overflow key" expires in 2 days.                    [ Reconnect ]  [✕] │
└────────────────────────────────────────────────────────────────────────────┘

EXPIRY — several
┌────────────────────────────────────────────────────────────────────────────┐
│ ◐  2 provider accounts need attention.                     [ Review ]  [✕] │
└────────────────────────────────────────────────────────────────────────────┘

ALREADY BROKEN
┌────────────────────────────────────────────────────────────────────────────┐
│ ✕  "Personal key" stopped working. Agents using it are falling back to      │
│    other-big-model.                                     [ Reconnect ]  [✕] │
└────────────────────────────────────────────────────────────────────────────┘

BROKEN WITH NO FALLBACK
┌────────────────────────────────────────────────────────────────────────────┐
│ ✕  "Personal key" stopped working and there's no fallback. Runs that need   │
│    Provider B will stop.                                [ Reconnect ]  [✕] │
└────────────────────────────────────────────────────────────────────────────┘

SYNC — pending / sending / unreachable / clear
┌────────────────────────────────────────────────────────────────────────────┐
│ ⟳  3 computers don't have your latest provider accounts yet. [ Send now ]  │
├────────────────────────────────────────────────────────────────────────────┤
│ ⟳  Sending to 3 computers…                                                  │
├────────────────────────────────────────────────────────────────────────────┤
│ ⚠  1 computer hasn't checked in since 06:12. It will pick this up when it   │
│    comes back.                                                              │
├────────────────────────────────────────────────────────────────────────────┤
│ (all current — the banner is not rendered at all)                           │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.8 What the Run receipt says

The Run receipt surface belongs to [AW-09](../README.md); this epic supplies the line and its
copy.

```
  Routing
  ────────────────────────────────────────────────────────────────────
  Ran on  other-big-model  ·  Provider B  ·  account "Client key"
  Effort  High
  Timeout 15 minutes (not reached)

  Earlier attempts
    1.  big-model-id   · Provider A · "Company key"  · rate limited
    2.  big-model-id   · Provider A · "Overflow key" · needs reconnect
```

Variants: `Effort — not supported by this model.` · `Timeout 15 minutes — reached, run
ended.` · `Stopped after 6 attempts.` · `No model call was made.`

### 6.9 Exact user-visible copy that carries meaning

| Situation | Copy |
| --- | --- |
| Accounts panel help | "Agents use them in this order. Number 1 first, and the next one whenever the one above can't answer." |
| Order saved | "Order saved. Agents pick it up on their next call." |
| Fallback help | "Tried in order when the model above is rate-limited, unreachable, or has no working account. Your default model is never offered as its own fallback." |
| Primary removed from chain | "Removed {model} from the fallbacks — it's your default now." |
| Effort help | "How hard models think before answering. Higher costs more and takes longer." |
| Effort not supported | "This model doesn't take a thinking setting. Your choice is recorded and ignored for it." |
| Timeout help | "A run still going after this ends instead of hanging. Between 1 minute and 2 hours." |
| Timeout warning | "{n} schedules have runs that usually take longer than this. They'll start timing out." |
| Credential secrecy | "Stored encrypted. Nobody — not you, not an agent, not an export — can read it back out." |
| No markup | "Billing goes to your own account with {provider}. Ever Works adds nothing on top and never buys credit for you." |
| Remove, with fallback | "'{label}' is the only account for {provider}, and {n} agents route to a {provider} model. Removing it makes those runs fall back to {model}." |
| Remove, no fallback | "'{label}' is the only account for {provider}, and {n} agents route to a {provider} model. Removing it makes those runs stop until you add an account or pick a different model." |
| Conflict | "Someone changed this while you were editing. We reloaded the order — check it and save again." |
| Unverified model id | "Not in the catalogue we can see. Double-check the spelling." |
| Catalogue unavailable | "Couldn't load this provider's models. You can still type a model id." |
| Chain exhausted (run log) | "No model could answer: tried {n} of {n}. Last error: {reason}." |
| Budget stop | "Stopped by your budget cap, not by a model. Fallbacks were not tried." |
| Paused row | "Paused — agents skip this one." |
| No-account fallback badge | "No account — this step will be skipped." |
| Read-only tooltip | "Only workspace admins can change model settings" |
| Load error | "Couldn't load your model settings. Your agents are unaffected — they're using the settings they already have." |
| Diagnostic hint (empty Runs, unhealthy account) | "One of your provider accounts needs reconnecting. That's usually why agents stop." |

### 6.10 Keyboard

| Surface | Keys |
| --- | --- |
| Account list | Roving tab stop, one per row. `Alt+↑` / `Alt+↓` move the focused row and announce "Company key, position 2 of 4" politely. `Enter` opens the row menu. `Delete` opens the remove dialog. `Space` toggles keyboard-reorder mode for pointer-free dragging. |
| Fallback chain | Same roving pattern. `Alt+↑`/`Alt+↓` reorder, `Backspace` removes the focused entry and announces "Removed. 1 fallback left." |
| Model picker | Opens focused on the search box; any printable key filters; `↑`/`↓` move; `Enter` selects; `Esc` closes and restores the previous value. |
| Effort radios | Native radio-group arrow behaviour; the helper line is the group's description. |
| Both panels | `Cmd/Ctrl+S` saves the panel containing focus. `Esc` on a dirty panel asks "Discard your changes?" before reverting. |
| Banners | Reachable in tab order before the page heading; the dismiss control is a real button labelled "Dismiss". |
| Everything | Focus is never trapped; each dialog returns focus to the control that opened it; every state change that matters is announced once, politely, never assertively. |

## 7. Out of scope

- **What things cost, caps, credits and meters.** [AW-17](../README.md) owns spend. This epic
  records *what ran*; AW-17 prices it.
- **The Run receipt surface itself.** [AW-09](../README.md) owns the page; this epic supplies
  the routing record and its copy.
- **The Schedules list and calendar.** [AW-10](../README.md) owns them; this epic contributes
  one drawer that hangs off a schedule row.
- **Tool connections, scope presets, per-agent tool grants and the credential vault.**
  [AW-15](../README.md). A Model Account is not a Connection (§5.1).
- **Automatic model selection.** Nothing in this epic picks a model for the owner, infers one
  from a task, or "upgrades" a choice. Routing is what the owner configured plus failover.
- **Cost-aware routing** — choosing the cheapest model that can do the job. A real idea, and a
  different epic; it needs pricing that AW-17 owns.
- **Per-model or per-account spend caps.** Budgets already exist and already gate every call;
  this epic adds no second gate and deliberately makes a budget block a hard stop.
- **Changing which background-job engine runs work.** That is the job-runtime overlay, an
  unrelated system that shares only the word "runtime". Nothing here touches it.
- **Provider-side balance top-ups, subscription management or purchase of any kind.**
- **Retiring or changing the existing per-plugin model settings.** They keep working; a
  workspace with no Model Account behaves exactly as it does today.
- **A second reasoning control per call.** One effort per policy level, four values, nothing
  finer.
- **Streaming-specific routing.** A streamed call resolves its chain identically; mid-stream
  failover is out of scope because a partially delivered answer cannot be retracted.
- **Bringing an entire private model deployment online.** Adding a new provider is adding a
  plugin, which is a different piece of work with its own rules.

## 8. Acceptance criteria

- [ ] An owner can add a second account to the same provider and both appear, numbered.
- [ ] The numbered order is the only ordering control, and reordering takes three interactions.
- [ ] A rate-limited call moves to the next account on the same model, within the same call.
- [ ] A rejected credential moves to the next model, not the next account of the same provider,
      once that provider's accounts are exhausted.
- [ ] A malformed-request rejection does **not** walk the chain.
- [ ] A budget block does **not** walk the chain and says so.
- [ ] No call ever exceeds 6 attempts, and a call that stops for that reason says so.
- [ ] The fallback picker never lists the current primary, and the stored list never contains it.
- [ ] Changing the primary to a model already in the chain removes it from the chain and says so.
- [ ] Workspace, Agent and Schedule overrides resolve narrowest-wins, per field, independently.
- [ ] A policy change binds on the next call within 5 seconds with no restart of anything.
- [ ] An in-flight Run keeps the routing it started with.
- [ ] Reasoning effort has exactly four values, defaults to medium, and medium is
      behaviour-neutral for a workspace that has never set it.
- [ ] A model with no reasoning control ignores the effort and the Run says it was not applicable.
- [ ] A Run past its timeout ends as failed with the timeout reason and the in-flight routing.
- [ ] An account expiring in 9 days shows "Expires in 9 days"; at 3 days a banner appears.
- [ ] Reconnecting an unhealthy account preserves its position, name, history and references.
- [ ] Every Run records provider, model, account name, effort and every earlier attempt.
- [ ] No response, log, trace, export or error contains a credential value at any role level.
- [ ] A non-admin sees everything and can change nothing, with the reason stated.
- [ ] A workspace with enrolled computers shows an accurate out-of-sync count that clears itself.
- [ ] A workspace with no enrolled computers shows no sync signal at all.
- [ ] A workspace that upgrades and changes nothing behaves exactly as it did before.
- [ ] Every functional requirement has a passing test.

## 9. Open questions

- `[NEEDS CLARIFICATION: should the Connections registry (AW-15) list Model Accounts read-only
  so "everything I've connected" is one page, while all mutation stays in Settings → Models?
  It helps discoverability and risks implying the two share a scope model, which they do not.]`
- `[NEEDS CLARIFICATION: is 8 accounts per provider the right ceiling? It is chosen to keep the
  attempt ceiling meaningful, not from observed demand. If real workspaces want more, the
  attempt ceiling — not the account count — is the thing to revisit.]`
- `[NEEDS CLARIFICATION: should a provider account be shareable across Organizations within one
  tenant, or is workspace-scoped correct forever? Shared accounts make an agency's life easier
  and make "who spent this" harder.]`
- `[NEEDS CLARIFICATION: for providers whose credential has no discoverable expiry, should we
  offer the owner a manual "expires on" date so they get the same warning, or is a silent
  `unknown` honest and sufficient?]`
- `[NEEDS CLARIFICATION: what happens to an operator-level configuration value that names an
  ordered fallback provider list and is currently read by nothing? This epic deliberately does
  not read it. Deprecate it, or repurpose it as the instance-wide default chain for workspaces
  that set none?]`
- `[NEEDS CLARIFICATION: should the run timeout also be overridable per Agent, not just per
  workspace and per Schedule? Per-schedule covers the stated need; per-agent is one more level
  to explain.]`
- `[NEEDS CLARIFICATION: should a computer that is out of sync be excluded from taking work, or
  allowed to run with the credentials it already holds? Excluding is safer and can idle a
  fleet; allowing is available and can run on a revoked key.]`

## 10. Constitution gates

- [x] **I — Plugin-first.** No provider client is added. Providers are exactly the installed
      plugins declaring the AI-provider capability; this epic adds accounts and ordering
      *around* them.
- [x] **II — Capability-driven.** No provider id appears in core code, in the UI, or in any
      copy string; the provider list, its credential fields and its model catalogue all come
      from the plugin.
- [x] **III — Source-of-truth repos.** Untouched. Nothing here stores work content.
- [x] **IV — Job runtime.** Health probing and bundle publication run as scheduled background
      work through the configured job-runtime provider, never as in-process timers.
- [x] **V — Forward-only migrations.** Two new tables and additive nullable columns, shipped
      with their migration in the same PR; nothing is dropped or renamed.
- [x] **VI — Tests first-class.** Unit tests for the resolver and the failover classifier,
      controller specs for every endpoint, an end-to-end spec per user-visible flow.
- [x] **VII — Secrets.** Credentials are encrypted at rest, never returned at any role level,
      never logged, and the activity log names fields only.
- [x] **VIII — Plugin counts.** No plugin is added or removed; the canonical list is untouched.
- [x] **IX — Behaviour-first.** This document contains no class name, file path or code.
- [x] **X — Compatibility.** Every existing field keeps working; a workspace that configures
      nothing behaves exactly as it does today.

## 11. References

- Program: [`agent-workspace/README.md`](../README.md)
- Constitution: [`.specify/memory/constitution.md`](../../../../../.specify/memory/constitution.md)
- Plan: [`./plan.md`](./plan.md) · Tasks: [`./tasks.md`](./tasks.md)
- Neighbouring epics: [AW-09 Runs & receipts](../README.md), [AW-10 Schedules](../README.md),
  [AW-15 Connections & scopes](../AW-15-connections-scopes/spec.md),
  [AW-17 Costs & caps](../README.md)
