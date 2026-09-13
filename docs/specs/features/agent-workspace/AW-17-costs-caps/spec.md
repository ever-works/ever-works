# AW-17 — Costs, caps and credits

> Behaviour-first spec per [Constitution Principle IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code. Implementation lives in [plan.md](./plan.md);
> the ordered work lives in [tasks.md](./tasks.md).

**Epic ID:** `AW-17-costs-caps`
**Program:** [Agent Workspace](../README.md) · Wave 2 (control)
**Branch:** `feat/aw-17-costs-caps`
**Status:** `Draft`
**Created:** 2026-09-06
**Last updated:** 2026-09-06
**Size:** L · **Blocking dependency:** AW-09 (Runs and receipts) · **Related:** AW-16 (Model
accounts), AW-05 (Agent email), AW-19 (Home), AW-24 (Safety rails)
**Extends (existing Ever Works nouns):** Run · Agent · Task · Mission · Work · Organization ·
Plugin / Connection · Node / Fleet · Schedule

---

## 0. TL;DR

Ever Works bills every kind of spend — a model call, a web search, a screenshot, an email send —
into **one** balance, at **one** blended rate, with a margin applied at settlement time. The
result is a single number that answers no question: an owner cannot tell whether last month was
expensive because their agents thought too hard or because they searched too much, cannot find
out what a search costs before running one, and cannot set a ceiling that actually stops
anything.

This epic replaces that one blended meter with **three meters that never overlap**, and makes
every cap a refusal rather than a notification.

```
   ┌────────────────────────────────────────────────────────────────────────────────┐
   │  ONE UNIT OF SPEND BELONGS TO EXACTLY ONE METER                                │
   │                                                                                │
   │   ① MODEL USAGE            ② CREDITS                 ③ ADD-ONS                │
   │   Paid by your own         Paid by us on your        A flat monthly line       │
   │   provider account.        behalf, at a published    per provisioned unit.     │
   │   We add nothing to it.    price per call.           Never draws credits.      │
   │   Recorded, never charged. Allowance + packs.        Pro-rated on the day.     │
   └────────────────────────────────────────────────────────────────────────────────┘

   How a unit of spend is classified — total, deterministic, no unit in two meters:

        a unit of spend
              │
              ├─ is it a provisioned thing (an inbox, a Node, a seat)? ──► ③ ADD-ONS
              │
              └─ it is a metered call
                        │
                        ├─ paid with a credential this Workspace owns? ──► ① MODEL USAGE
                        │                                                   recorded, not charged
                        └─ paid with the platform's credential ──────────► ② CREDITS
                                                                            priced from the list
```

And the same money is legible at three levels of zoom, each one click from the last:

```
  HOME        "This week: 412 of 1,000 credits · $18.20 on your own model accounts"
    │           one line, no navigation
    ▼
  BILLING     three meter cards · spend by tool · by Agent · by Mission · caps · packs
    │           where it went
    ▼
  RECEIPT     6 web searches (12cr) · 2 page fetches (2cr) · 1 screenshot (4cr) · 0 cached
                the exact calls that spent it
```

Three phases, each independently shippable and each leaving `develop` green:

- **P1 — Separate the meters.** Every metered call is classified at the moment it happens,
  priced from a published list, and shown per Run, per tool, per Agent and per Mission. Model
  usage stops drawing credits.
- **P2 — Caps that stop.** Workspace, per-Agent and per-Mission ceilings that refuse spend, a
  monthly maximum on auto-recharge, and a decision in **My Decisions** whenever a cap stops work.
- **P3 — Add-ons.** The third meter: flat monthly lines for provisioned units, pro-rated on the
  day they are added and removed, with a standing guarantee that they never touch credits.

---

## 1. Overview

A Workspace owner sees exactly **three meters** and never has to reconcile them against each
other. **Model usage** is paid by the owner's own provider accounts; Ever Works records what
each Run consumed and adds nothing to it. **Credits** pay for the research and tooling calls
Ever Works makes on the owner's behalf — web searches, page fetches, content extraction,
screenshots, enrichment lookups, ranking and listing data, page audits, ad-library lookups —
priced from a **published credit price list** that says what each kind of call costs _before_ it
is made, with a monthly included allowance that expires and purchased packs that never do.
**Add-ons** are flat monthly lines for provisioned units — an agent inbox, a dedicated Node, an
extra seat — pro-rated on the day they are added or removed, and they never consume credits.

The same three numbers appear at three levels of zoom: a one-line summary of the current week on
Home, a full breakdown by tool, by Agent and by Mission in Billing, and a line-by-line
itemisation on each Run's receipt. Every one of those lines traces back to the exact Run that
spent it.

On top of all three sits one control the owner can actually rely on: a **cap**. A cap is a
refusal, not a notification. When a Workspace, an Agent or a Mission reaches its ceiling, the
next call that would cross it does not happen, the Run that needed it stops with an explicit
reason, and a decision appears in **My Decisions** offering the only two honest choices — raise
the ceiling, or leave it stopped.

---

## 2. Why now

### 2.1 The user's question

> _"Last month cost me $340. What did I buy, which of my agents bought it, and how do I stop it
> happening again without turning everything off?"_

That is three questions, and today's product answers none of them cleanly. It answers a fourth
question the owner did not ask — _"what is your total?"_ — and leaves the rest as an exercise.

### 2.2 What they do today, and why it does not answer the question

| To answer…                                                            | Today they must…                                                                                            | What breaks                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "How much of this was thinking, and how much was searching?"          | Open **Usage → Costs**, read the per-model panel, and mentally subtract it from the total.                  | Everything platform-metered — model calls, searches, screenshots, extraction, email — converts into **one** credits debit at settlement. There is no stored fact saying which kind of spend a credit paid for, so the subtraction is not available even in principle.                                                              |
| "What does a web search cost?"                                        | Nothing.                                                                                                    | Credits are derived after the fact from a provider's own cost multiplied by a service margin. There is no price a user can read before spending. The Usage page tells them a margin percentage exists; it cannot tell them what any single call costs.                                                                             |
| "Was that call served from cache? Did I pay for the one that failed?" | Nothing.                                                                                                    | The Costs page carries a standing note that cached reads are not recorded at all. Failed provider calls that still returned pricing are metered like successful ones.                                                                                                                                                              |
| "Which Mission ate the budget?"                                       | Nothing.                                                                                                    | Usage groups by day, model, Agent and Work. A usage row records the Run and the Task the call was made for, but nothing carries the Mission that Task belongs to, so spend never reaches the standing initiative that caused it.                                                                                                   |
| "I brought my own key — am I being charged twice?"                    | Trust the label.                                                                                            | Own-key spend is exempted from the debit, but the exemption is worked out **at settlement time** by re-resolving where each plugin's key came from. When that resolution is unavailable the platform bills the full platform rate, and the code says so in a standing TODO. The owner has no way to see which of the two happened. |
| "Cap my Agent at $20 a month."                                        | They cannot.                                                                                                | The per-Agent budget exists as a data shape with no way to set it, and the one place that reads it computes current spend as a hard-coded zero. The Agent's Budgets tab therefore always says "no cap configured", and always will.                                                                                                |
| "Cap my Workspace."                                                   | Set an unrelated cap on the autonomous Work Agent's own preferences page, which governs a different engine. | There is no Workspace-wide ceiling on agent spend anywhere in Billing or Usage.                                                                                                                                                                                                                                                    |
| "Make sure auto-recharge can never run away."                         | They cannot.                                                                                                | Auto-recharge has a trigger threshold, a fixed pack and a single-flight guard — and **no monthly maximum**. A pathological loop that burns a pack an hour is bounded only by the card.                                                                                                                                             |
| "What am I paying for that is not usage?"                             | Read the invoice.                                                                                           | Seats are a subscription quantity; everything else that is provisioned rather than called — inboxes, Nodes — has no line at all, no pro-ration, and no statement that it does not also draw credits.                                                                                                                               |
| "What did _this_ Run spend, itemised?"                                | Open the receipt and read one total.                                                                        | AW-09 gives a Run a cost block. Without a per-call meter classification and a price list, the block can only show a sum.                                                                                                                                                                                                           |

### 2.3 The four gaps this epic closes

1. **One meter is doing three jobs.** A blended balance cannot answer "on what?". Classification
   has to happen at the moment of the call, when the platform still knows whose credential paid
   and what kind of work it was — not reconstructed at settlement.
2. **There is no price before the spend.** A margin over an invisible provider cost is not a
   price. A published list of what each kind of call costs is the difference between a budget an
   owner can plan and a bill they can only regret.
3. **Caps are inert.** Per-Agent caps cannot be set and read zero spend. There is no
   Workspace-wide ceiling. Auto-recharge has no monthly maximum. Every one of these is a
   promise the product makes in its own vocabulary and does not keep.
4. **Money is not where the work is.** Spend lives three clicks deep in Settings while the work
   lives on Home, on the Task board and in Runs. An owner should meet the number where they
   already are.

### 2.4 Why this epic is additive only

Per [program rule 1](../README.md#5-rules-every-epic-spec-in-this-program-must-follow), nothing
is removed or renamed. The Billing page, the Usage page and its Costs tab, the credit ledger,
the packs, pay-as-you-go, invoices and seats all keep working exactly as they do. The existing
per-Work budgets keep their shape and their optional overage switch. The Fleet's per-Node daily
model-spend ceiling keeps its own control and is surfaced, read-only, alongside the new caps
rather than replaced by them. What changes is that every _new_ usage record carries a meter, and
that the new Workspace-level caps have no overage switch at all.

---

## 3. User scenarios

### 3.1 Primary scenarios

**S1 — The Monday glance.**
**Given** an owner whose agents worked over the weekend,
**when** they open Home,
**then** one line reads _"This week: 412 of 1,000 credits · $18.20 on your own model accounts ·
$30.00 in add-ons"_, with the credit figure showing a proportion bar against the included
allowance, and choosing any of the three numbers opens Billing scrolled to that meter.

**S2 — Finding out what a tool costs before using it.**
**Given** an owner about to hand an Agent a research Task,
**when** they open **Billing → Credit price list**,
**then** they see every priced kind of call with its credit cost, the current price-list version,
and the date it took effect — for example _"Web search — 2 credits per query"_, _"Page fetch —
1 credit"_, _"Screenshot — 4 credits"_, _"Page audit — 10 credits"_ — and a note that cached
results and failed calls cost nothing.

**S3 — Reading where the month went.**
**Given** a month that cost more than expected,
**when** the owner opens **Billing** and looks at _Where the credits went_,
**then** they see three ranked breakdowns — by tool, by Agent, by Mission — each showing credits,
share of the period, and a jump into the filtered Run list, and the by-Mission list names the one
Mission whose Tasks consumed 61% of the month.

**S4 — Itemised on the Run.**
**Given** one Run from a Task that Mission raised,
**when** the owner opens its receipt,
**then** the cost block lists, per meter: model usage as tokens and the provider account that
paid for it, credits as one line per priced call kind with counts and credits, and add-ons as
_"Not applicable to a single Run"_ — plus, on each credit line, how many of those calls were
served from cache at no cost.

**S5 — Bringing your own key stops the charge, visibly.**
**Given** a Workspace that has connected its own model account,
**when** a Run uses it,
**then** the receipt reads _"Billed by your provider to your account 'Company key'. Ever Works
adds nothing."_, the credits line for that Run is `0`, and the Workspace's credit balance is
untouched.

**S6 — Capping an Agent.**
**Given** an Agent that costs more than the owner intends,
**when** they open **Billing → Caps**, add a cap of `$20 per calendar month` on that Agent for
the credits meter, and save,
**then** the cap is live within 30 seconds, the Agent's own Budgets tab shows the same cap and
the real spend against it, and no confirmation is needed to make it stricter.

**S7 — A cap actually stops something.**
**Given** an Agent that has consumed $20.00 of its $20.00 cap,
**when** its next Run reaches a credit-metered call,
**then** the call does not happen, the Run stops with the reason _"Agent spend cap reached"_, a
**My Decisions** item appears reading _"Nova reached its $20.00 monthly cap. Raise the cap, or
leave it stopped until 1 October?"_, and no partial debit is written.

**S8 — Auto-recharge stays inside its ceiling.**
**Given** auto-recharge set to buy the 1,000-credit pack whenever the balance drops below 200,
with a monthly maximum of $100,
**when** the tenth pack of the month would be bought,
**then** the purchase does not happen, the balance is allowed to fall, a **My Decisions** item
reads _"Auto-recharge reached its $100.00 monthly maximum. Raise the maximum, or top up
manually?"_, and no card is charged.

**S9 — Adding an add-on.**
**Given** an owner adding a second agent inbox on the 16th of a 30-day month,
**when** the add-on is confirmed,
**then** the confirmation states the pro-rated amount for the remainder of the period and the
full amount from the next period, the line appears immediately in **Billing → Add-ons**, and the
credits balance is unchanged and stated to be unchanged.

**S10 — Removing an add-on.**
**Given** that inbox is deleted on the 20th,
**when** the deletion completes,
**then** the add-on line moves to _Removed_, the next invoice carries the pro-rated credit, and
the Add-ons list states _"Removed 20 Sep — you are not billed for this from the next period."_

**S11 — The Workspace ceiling.**
**Given** a Workspace cap of `$150 per calendar month` on the credits meter,
**when** spend crosses 75%, 90% and 100%,
**then** each threshold produces exactly one notification per period, the 100% crossing stops all
credit-metered calls across every Agent, and Billing shows one banner naming the cap, the amount
and the date it resets.

**S12 — Raising a cap from the decision.**
**Given** a stopped Workspace,
**when** the owner answers the **My Decisions** item with _"Raise to $250"_,
**then** the cap is updated, the stop is lifted within 30 seconds, every Run parked on that cap
is eligible to resume on its next dispatch, and the change is recorded in the activity log
against the acting user.

### 3.2 Unhappy paths, races, denials and empty states

**S13 — Payments are not configured on this deployment.**
**Given** a deployment with no payment provider configured,
**when** the owner opens Billing,
**then** the three meter cards still render with real usage numbers, the price list is readable,
caps are fully functional, and only the money-moving controls — buy a pack, auto-recharge,
add-ons — are replaced with _"Card payments are not enabled on this deployment. Usage, caps and
the price list still work."_ No control is shown enabled that would always fail.

**S14 — The balance runs out with no cap in sight.**
**Given** a Workspace with 0 credits, no purchased packs and auto-recharge off,
**when** an Agent reaches a credit-metered call,
**then** the call is refused, the Run stops with _"Out of credits"_, a **My Decisions** item
offers _"Buy credits"_, _"Turn on auto-recharge"_ and _"Wait for the allowance on 1 October"_,
and no debit is written that would take the balance below zero.

**S15 — A call fails after the provider was reached.**
**Given** a search call that reaches the provider and returns an error,
**when** the Run continues,
**then** the usage record is written with outcome _failed_ and **0 credits**, the receipt shows
the attempt with _"Failed — no charge"_, and the failure still counts toward the Agent's error
budget as it does today.

**S16 — A call is served from cache.**
**Given** a page fetch whose result is already cached and inside its freshness window,
**when** the Agent asks for it,
**then** the usage record is written with outcome _cached_ and **0 credits**, and the receipt
line reads _"3 page fetches — 1 charged, 2 from cache"_.

**S17 — The Agent forces a fresh pull.**
**Given** the same page and a Skill that requires current data,
**when** the Agent requests it with freshness forced,
**then** the call is made live and charged at the full list price, the receipt marks the line
_"Forced fresh"_, and the next request inside the freshness window is free again.

**S18 — Two Runs cross the same cap at the same instant.**
**Given** an Agent one credit below its cap and two Runs settling concurrently,
**when** both would cross,
**then** exactly one crossing takes effect, exactly one stop is recorded, exactly one decision is
raised, and the second is a no-op — never two decisions, never a double stop, never a balance
below the cap by two calls' worth.

**S19 — The cap is lowered below what has already been spent.**
**Given** an Agent that has spent $18.00 this month,
**when** the owner lowers its cap to $10.00,
**then** the save succeeds, the cap shows _"Already exceeded — $18.00 of $10.00"_, all further
credit-metered calls for that Agent stop immediately, and nothing already spent is reversed or
re-billed.

**S20 — Two people edit the same cap.**
**Given** two people with permission open the same cap,
**when** the second saves after the first,
**then** the second is told _"This cap was changed to $250.00 by Dana a moment ago. Reload to see
the current value."_ and their write is refused rather than silently overwriting.

**S21 — A cap on an Agent that has been archived.**
**Given** a cap on an Agent that is later archived,
**when** the owner opens Caps,
**then** the cap is listed with the Agent labelled _Archived_, its historical spend still
resolves, and the row offers _Remove cap_ only — never an edit that would have no effect.

**S22 — Credential provenance cannot be determined.**
**Given** a metered call whose paying credential cannot be resolved,
**when** the usage record is written,
**then** it is classified to the credits meter (the platform assumes it paid), the receipt line
carries _"We could not confirm which account paid for this call"_ with a link to raise it with
support, and the platform records the event for its own alerting. It is never silently treated
as free.

**S23 — Old usage has no meter.**
**Given** usage recorded before this epic shipped,
**when** the owner selects a period that includes it,
**then** breakdowns show a row labelled _"Recorded before meters were separated"_ with its total,
excluded from the per-meter cards rather than guessed into one of them, and a one-line note gives
the date meters began.

**S24 — Itemised usage has aged out.**
**Given** a Run older than the 12-month usage retention window,
**when** the receipt is opened,
**then** the settled total still shows and the itemisation is replaced by _"Itemised usage for
this Run is older than 12 months and is no longer retained. The total is unchanged."_

**S25 — A teammate with read access.**
**Given** a teammate who can view the Workspace but not change its settings,
**when** they open Billing,
**then** every number, breakdown and price is visible, and every control that changes money or a
cap is disabled with _"You need billing permission to change this."_ Answering a spend decision
is likewise disabled with the same explanation.

**S26 — Someone else's Workspace.**
**Given** a cap, an add-on or a usage record belonging to another account or Organization,
**when** it is requested directly by URL or by id,
**then** the response is identical to the response for something that does not exist.

**S27 — A breakdown request fails.**
**Given** the by-Mission breakdown request errors while the by-tool one succeeds,
**when** Billing loads,
**then** the meter cards and the two working breakdowns render, the failing panel shows _"We
could not load spend by Mission"_ with **Retry**, and no other panel is blanked.

**S28 — The price list changed mid-period.**
**Given** a price-list version that took effect on the 12th,
**when** the owner reads a period spanning the change,
**then** every historical line is priced at the version in force when the call happened, the
price list states _"In effect since 12 September. Earlier calls were priced at version 3."_, and
no historical figure is re-priced.

**S29 — Nothing has been spent yet.**
**Given** a Workspace whose agents have never made a metered call,
**when** the owner opens Billing,
**then** each meter card shows a zero with an explanatory sentence rather than an empty box —
_"No model usage yet. Connect a model account to keep this at zero on our side."_, _"No credits
used yet. Your allowance renews on 1 October."_, _"No add-ons."_ — and the price list is still
fully readable.

**S30 — Export is too large.**
**Given** a selected period resolving to more than 50,000 usage rows,
**when** the owner exports,
**then** the export is refused before it starts with _"That is more than 50,000 rows. Narrow the
period and try again."_ — never a truncated file presented as complete.

---

## 4. Functional requirements

Every requirement below is testable. Every default, limit, threshold and cadence is a number.

### 4.1 The three meters

- **FR-1** The system MUST classify every unit of spend into exactly one of three meters:
  **model usage**, **credits**, **add-ons**. No unit may appear in two meters, and no unit may
  appear in none.
- **FR-2** Classification MUST happen at the moment the spend occurs — at the metered call for
  meters 1 and 2, and at provisioning for meter 3 — and MUST be stored on the record. It MUST NOT
  be recomputed at settlement or at read time.
- **FR-3** The classification rule MUST be exactly: a provisioned unit is **add-ons**; a metered
  call paid with a credential the Workspace owns is **model usage**; every other metered call is
  **credits**.
- **FR-4** The set of priced kinds of call MUST be closed and published. A metered call whose kind
  has no entry in the price list MUST be recorded at **0 credits** and MUST raise a platform alert;
  it MUST NOT be billed at a guessed rate.
- **FR-5** Every stored unit of spend MUST record: its meter, the kind of call, the count of
  units, the outcome (`ok`, `cached`, `failed`), the credits charged, the price-list version used,
  the paying account class (`workspace-owned` or `platform`), and its attribution to the Run that
  made the call, the Agent that made it, and the Task that Run was dispatched for, where each
  exists.
- **FR-5a** Spend MUST roll up along exactly one path. A metered call attributes to its **Run**;
  a Run's spend rolls up to the **Task** it was dispatched for; and a Task's spend rolls up to the
  **Work**, **Mission**, **Idea**, **Team** and **Goal** its own owner fields name — any
  combination of which may be set, and each of which is independently filterable. The Mission a
  unit of spend belongs to MUST therefore be the Mission of its Task, MUST be captured when the
  usage record is written, and MUST NOT be derived any other way — in particular not from the
  Agent that happened to run it, which may be scoped to a different Mission.
- **FR-5b** Spend from a Run with no Task — a heartbeat, a chat, or a call made outside the
  Task path — has no Mission. It MUST be reported under an explicit _"Not in a Mission"_ row
  and MUST NOT be attributed to a Mission by inference.
- **FR-6** Where the paying account class cannot be determined, the record MUST be classified to
  **credits**, MUST be marked as unconfirmed, and MUST be surfaced as unconfirmed on the receipt.
- **FR-7** Unconfirmed classification MUST be counted; when it exceeds **0.1%** of metered calls
  in any rolling 24-hour window the platform MUST raise an operational alert.
- **FR-8** Records written before this epic shipped MUST NOT be back-classified by inference.
  They MUST be reported under a single explicit "before meters were separated" label.
- **FR-9** The Workspace's account currency MUST be used for every money figure on every surface,
  and MUST be stated once per surface.
- **FR-10** Credits MUST be an integer unit. The conversion between credits and money MUST be a
  single published number, defaulting to **100 credits = $1** (1 credit = 1 cent).
- **FR-11** No surface may present a meter total as the sum of two meters unless it is explicitly
  labelled as a combined figure and names the meters it combines.
- **FR-12** The three meters MUST be named identically on every surface: **Model usage**,
  **Credits**, **Add-ons**.

### 4.2 Meter 1 — model usage

- **FR-13** Model usage paid with a Workspace-owned provider account MUST NOT produce any charge
  by Ever Works, MUST NOT debit credits, and MUST NOT be included in any invoice line.
- **FR-14** Model usage paid with a Workspace-owned account MUST still be recorded and displayed,
  including input, output and cached-read token counts and the provider's own cost where the
  platform can determine it, labelled as the provider's figure and not the platform's charge.
- **FR-15** The platform MUST NOT apply any margin, markup, uplift or rounding-up to a model-usage
  figure. The displayed figure MUST be the provider's own metered cost or nothing at all.
- **FR-16** Where the platform has no cost figure for a model, the surface MUST read _"Not priced
  by this provider"_ and MUST NOT display `0`.
- **FR-17** A Run MUST record which provider account paid for each model call, by its
  user-given label, and the receipt MUST show it.
- **FR-18** Model calls made with a **platform-supplied** credential MUST be classified to the
  credits meter, priced from the price list, and labelled on every surface as _"Managed model
  access"_ so the two paths are never confused.
- **FR-19** A Workspace MUST be able to set **"Require my own model accounts"**. When set, a Run
  that would fall back to a platform-supplied model credential MUST stop before the call with the
  reason _"No model account available"_ rather than spending credits.

### 4.3 Meter 2 — credits

- **FR-20** Credits MUST pay for exactly these classes of platform-made call: web search, page
  fetch, content extraction, screenshot capture, enrichment and profile lookup, listing and review
  data pulls, ranking and keyword data, page audits, ad-library lookups, managed model access, and
  metered tool calls made through an installed Plugin's Connection using a platform credential.
- **FR-21** The credit price of a call MUST be read from the published **credit price list** and
  MUST be keyed on the **capability and operation**, never on a Plugin id, so changing the Plugin
  behind a capability never changes what the owner pays.
- **FR-22** The price list MUST be versioned. Every usage record MUST store the version used, and
  historical records MUST NEVER be re-priced when a new version takes effect.
- **FR-23** The price list MUST be readable in the product by any Workspace member, without a
  purchase and without payments being configured.
- **FR-24** A call whose outcome is `cached` MUST cost **0 credits**.
- **FR-25** A call whose outcome is `failed` MUST cost **0 credits**, regardless of whether the
  provider was reached.
- **FR-26** A cached result MUST be considered fresh for **24 hours** by default per kind of call.
  A caller that explicitly forces a fresh result MUST be charged the full list price for that call,
  and subsequent calls inside the window MUST be free again.
- **FR-27** Each plan MUST carry an included monthly allowance of credits. The shipped default for
  the standard cloud plan MUST be **1,000 credits per month**.
- **FR-28** The included allowance MUST be granted once per allowance month, anchored to the
  subscription's start date, and MUST expire unused at the end of that allowance month. It MUST NOT
  accumulate.
- **FR-29** Purchased credit packs MUST NEVER expire.
- **FR-30** Debits MUST be allocated against the soonest-expiring credits first, so that a
  purchased pack is only consumed after the current allowance is exhausted.
- **FR-31** The purchasable packs MUST be **1,000 credits for $10**, **5,500 credits for $50**
  and **25,000 credits for $200**, and their prices MUST be server-authored — a purchase request
  MUST carry a pack identifier only and MUST be refused if it carries an amount, price or credit
  quantity.
- **FR-32** Plans MAY additionally grant a small **daily** allowance; the shipped default is
  **50 credits per day**, non-accumulating, and it MUST be shown separately from the monthly
  allowance so the two are never confused.
- **FR-33** A debit MUST NOT take the balance below zero. A call that cannot be fully covered MUST
  be refused before it is made.
- **FR-34** The balance, the allowance remaining, the purchased balance and the expiry date of the
  current allowance MUST all be visible on Billing as four separate figures.

### 4.4 Meter 3 — add-ons

- **FR-35** An add-on MUST be a flat recurring charge for a provisioned unit, with a code, a unit
  price, a quantity, and a reference to the thing it pays for.
- **FR-36** Add-ons MUST NEVER consume credits, and every add-on surface MUST state this.
- **FR-37** Adding an add-on mid-period MUST be pro-rated to the remainder of the current billing
  period, and the exact pro-rated amount MUST be shown before the owner confirms.
- **FR-38** Removing an add-on MUST stop the charge from the next period and MUST produce a
  pro-rated credit for the unused remainder of the current period.
- **FR-39** The add-on kinds shipped by this epic MUST be: **agent inbox**, **dedicated Node**,
  and **extra seat**. Seats MUST continue to be managed by the existing seat control; the Add-ons
  list MUST show them read-only with a link to it rather than offering a second way to change them.
- **FR-40** Deleting the underlying provisioned unit MUST remove its add-on within **60 seconds**,
  and an add-on whose underlying unit no longer exists MUST be reported as an orphan rather than
  billed indefinitely.
- **FR-41** A Workspace MUST be able to set a maximum number of billable add-on units per kind;
  the shipped default MUST be **25** per kind, and a request to provision beyond it MUST be
  refused with the number in the message.

### 4.5 Caps

- **FR-42** A cap MUST be a **refusal**. When a cap is reached, the next unit of spend that would
  cross it MUST NOT happen. A cap MUST NOT be satisfiable by a notification alone.
- **FR-43** Caps MUST be settable at four scopes: **Workspace**, **Agent**, **Mission**, and
  **Work**. Each cap MUST name the meter it governs, or **all meters**. A **Mission** cap MUST be
  measured over the spend that reaches that Mission through its Tasks (FR-5a). A Mission is a cap
  target because it is a standing source of Tasks, never because it is itself a unit of work.
- **FR-44** A cap MUST have a period of **one calendar month** in the Workspace's timezone, with
  per-Agent caps additionally supporting **hour**, **day** and **week** rolling periods anchored
  at creation.
- **FR-45** Workspace caps MUST NOT offer an overage switch. Existing per-Work and per-Agent
  budgets MUST keep their existing optional overage switch, and the Caps surface MUST label which
  is which in plain words.
- **FR-46** When several caps apply to one unit of spend, the **strictest** MUST win, and the
  refusal message MUST name which cap refused.
- **FR-47** A cap change MUST take effect within **30 seconds** across every executing Agent, with
  no restart and no redeploy.
- **FR-48** Crossing **75%**, **90%** and **100%** of a cap MUST each produce exactly one
  notification per cap per period.
- **FR-49** Reaching 100% of a cap MUST additionally raise exactly one item in **My Decisions**,
  naming the cap, the amount, the period reset date, and offering at minimum _Raise the cap_ and
  _Leave it stopped_.
- **FR-50** Concurrent crossings of the same cap MUST result in exactly one stop, one notification
  and one decision.
- **FR-51** Lowering a cap below current-period spend MUST be permitted, MUST take effect
  immediately, MUST show the exceeded state, and MUST NOT reverse or re-bill anything already
  spent.
- **FR-52** A Run stopped by a cap MUST record a classified reason distinguishing `budget-stop`
  (a cap refused it) from `credits-exhausted` (the balance was empty), and the receipt MUST name
  the specific cap for the former.
- **FR-53** A Run stopped by a cap MUST NOT be silently retried. It MUST become eligible again
  only after the cap is raised or the period rolls over.
- **FR-54** The per-Agent cap MUST be creatable, readable, editable and removable through the
  product, and its current-period spend MUST be computed from real recorded usage — never from a
  constant.
- **FR-55** Caps MUST be listed on one surface showing, per cap: scope, target, meter, period,
  cap amount, spend so far, percentage, and state (`ok`, `warning`, `stopped`, `exceeded`).
- **FR-56** The Fleet's existing per-Node daily model-spend ceiling MUST be listed on that same
  surface, read-only, linking to the Fleet control that owns it. This epic MUST NOT create a
  second way to set it.
- **FR-57** Every cap creation, change and removal MUST be recorded in the activity log against
  the acting user, with the old and new values.

### 4.6 Auto-recharge

- **FR-58** Auto-recharge MUST have a **monthly maximum** expressed in money, enforced as a hard
  refusal.
- **FR-59** The shipped default monthly maximum MUST be **$100**, the minimum settable **$10**,
  and the maximum settable **$2,000**.
- **FR-60** Auto-recharge MUST NOT be enablable without a monthly maximum set.
- **FR-61** The monthly maximum MUST reset at the start of each calendar month in the Workspace's
  timezone, and the amount consumed so far this month MUST be visible beside it.
- **FR-62** A recharge that would cross the monthly maximum MUST NOT be attempted — no card is
  contacted — and MUST raise exactly one decision per month.
- **FR-63** At most **one** auto-recharge may be in flight at a time; a second threshold crossing
  while one is in flight MUST be a no-op.
- **FR-64** After **3** consecutive failed auto-recharge attempts, auto-recharge MUST disable
  itself, MUST say so on Billing, and MUST require an explicit re-enable.

### 4.7 Visibility: the three levels of zoom

- **FR-65** Home MUST show one line covering the **current week** — the last 7 days ending now in
  the viewer's timezone — with the credits used against the included allowance, the model usage
  paid to the viewer's own accounts, and the monthly add-on total.
- **FR-66** Each of the three figures on Home MUST link into Billing scrolled to that meter.
- **FR-67** The Home line MUST refresh at most once every **60 seconds** and MUST NOT poll while
  the browser tab is hidden.
- **FR-68** Billing MUST show three meter cards for the selected period, each with its total, its
  headroom against any cap, and a one-sentence explanation of what the meter pays for.
- **FR-69** Billing MUST show three ranked breakdowns for the selected period — **by tool**, **by
  Agent**, **by Mission** — each showing credits, money, share of the period, and a link into the
  filtered Run list.
- **FR-70** Billing periods MUST be: the current calendar month, the previous calendar month, and
  rolling **7**, **30** and **90** days. There is no custom range in this epic.
- **FR-71** Each breakdown MUST show at most **10** rows plus an aggregated _"Everything else"_
  row, and MUST offer a full list on demand.
- **FR-72** A Run receipt MUST itemise that Run's spend per meter: model usage as tokens plus the
  paying account label; credits as one line per kind of call with counts, of which cached and
  failed, and credits charged; add-ons as not applicable.
- **FR-73** Receipt itemisation MUST reconcile exactly to the Run's settled total, and where it
  cannot the receipt MUST say so rather than showing an inconsistent sum.
- **FR-74** Figures for a Run that has not reached a terminal state MUST be labelled _"so far"_.

### 4.8 Scope, permissions, export and retention

- **FR-75** Every read and write MUST be scoped to the acting user and, when an Organization is
  selected, to that Organization. There MUST be no request parameter by which a caller can name a
  different user, Organization or tenant.
- **FR-76** A record the caller may not read MUST produce the same response as a record that does
  not exist.
- **FR-77** Viewing costs MUST require Workspace read access. Changing a cap, buying credits,
  changing auto-recharge, or adding or removing an add-on MUST require billing permission, and the
  controls MUST render disabled with an explanation for anyone who lacks it.
- **FR-78** Answering a spend decision in **My Decisions** MUST require the same billing
  permission as making the change directly.
- **FR-79** Usage MUST be exportable as CSV for the selected period, streamed rather than
  buffered, one row per usage record, including meter, kind of call, outcome, units, credits,
  money, price-list version, the Run, Agent and Task it is attributed to, and the Mission and
  Work that Task rolls up to.
- **FR-80** Export MUST be refused, before any work starts, when the resolved set exceeds
  **50,000** rows or the period exceeds **92** days.
- **FR-81** Itemised usage MUST be retained for **12 months**; settled totals on Runs, the credit
  ledger and invoices MUST NOT be pruned by this epic.
- **FR-82** No surface may display a secret, a credential, or a provider key, even when an error
  message from a provider echoes one.

### 4.9 Honesty, correctness and performance

- **FR-83** A quantity the platform has not measured MUST be rendered as an explicit "—" with an
  explanation. It MUST NEVER be rendered as `0`.
- **FR-84** A metering failure MUST NEVER fail a Run. A usage record that cannot be written MUST
  be counted as a platform error and MUST NOT silently drop the run's work.
- **FR-85** A refused call MUST be distinguishable on every surface from a call that was made and
  cost nothing.
- **FR-86** The credits debit for a Run MUST be idempotent: a retried settlement MUST NEVER
  produce a second debit for the same Run.
- **FR-87** The Home line MUST return in under **300 ms** at the 95th percentile; each Billing
  breakdown MUST return in under **800 ms** at the 95th percentile for a 90-day period; a cap check
  on the metered path MUST add no more than **15 ms** at the 95th percentile.
- **FR-88** This epic MUST NOT introduce a second word for anything in the
  [program vocabulary](../README.md#1-vocabulary--no-new-synonyms). It reads Runs, Agents,
  Missions, Tasks, Works, Plugins, Connections, Nodes and Organizations as they already exist.

---

## 5. Key entities

| Concept                                        | New or existing                                                   | What it is here                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Meter**                                      | **New — a classification, not a table**                           | Which of the three ways a unit of spend is paid for. Stored on every usage record. It is a property of spend, not an object anyone creates, so it gets no surface of its own beyond the three cards.                                                                                                                                                                   |
| **Usage record**                               | **Existing** (extended)                                           | One metered call, already attributed to user, Work, Agent, Task and Run and already carrying capability, Plugin, model, units and cost. This epic adds the meter, the kind of call, the outcome, the credits charged, the price-list version, the paying account class, and the Mission of the row's Task — captured when the row is written, not joined at read time. |
| **Credit price list**                          | **New — a published, versioned price table, not a stored record** | What each kind of call costs in credits. Server-authored and versioned; a price change is a shipped change, never a setting an operator can drift. Read by the pricing path and by the product surface that displays it.                                                                                                                                               |
| **Credit ledger entry**                        | **Existing**                                                      | The append-only record of every credit movement, with allowance buckets that expire and purchased buckets that never do. Unchanged in shape; this epic only narrows what produces a consumption entry.                                                                                                                                                                 |
| **Spend cap**                                  | **Existing concept, new Workspace scope**                         | The user-facing name for the whole family of ceilings. Ever Works already has per-Work and per-Agent budgets; this epic adds the missing Workspace scope, adds a meter to all of them, and makes all of them refuse. "Budget" remains the name in the data model — this introduces no second word for an existing thing.                                               |
| **Add-on**                                     | **New**                                                           | A flat recurring charge for a provisioned unit — an agent inbox, a dedicated Node, an extra seat — with a code, a quantity, a unit price, a reference to the unit, and a state.                                                                                                                                                                                        |
| **Billing profile**                            | **Existing** (extended)                                           | The bridge between the Workspace and the payment provider, already holding the payment-method summary and auto-recharge state. Gains the auto-recharge monthly maximum and the amount used against it this month.                                                                                                                                                      |
| **Model account**                              | **Existing (AW-16)**                                              | A Workspace-owned provider credential. Read here to determine the paying account class and to label the receipt. This epic never creates or edits one.                                                                                                                                                                                                                 |
| **Run / Agent / Task / Mission / Work / Node** | **Existing**                                                      | Attribution and cap targets. A Run and its Task are attributed directly; the Mission, Work and Goal are reached through that Task's own owner fields (FR-5a). All read unchanged.                                                                                                                                                                                      |
| **Approval / Escalation ("My Decisions")**     | **Existing (AW-03)**                                              | The queue a cap stop and an auto-recharge ceiling stop raise a decision into. This epic writes items; it does not change the queue.                                                                                                                                                                                                                                    |

> **New nouns introduced by this epic:** **Meter**, **Credit price list**, **Add-on**. Each is a
> thing the product genuinely did not have. Per
> [program rule 2](../README.md#5-rules-every-epic-spec-in-this-program-must-follow), the
> vocabulary table in the program README gains a row for each in the same pull request.

### 5.1 The meter classification, as a total function

```
                          ┌───────────────────────────┐
   a unit of spend  ───►  │  Is it provisioned, not   │  yes
                          │  called?                  │ ─────►  ③ ADD-ONS
                          └───────────────────────────┘         state: pending → active → removed
                                       │ no
                                       ▼
                          ┌───────────────────────────┐
                          │  Which credential paid?   │
                          └───────────────────────────┘
                             │                     │
                 workspace-owned            platform-supplied
                             │                     │
                             ▼                     ▼
                     ① MODEL USAGE            ② CREDITS
                     recorded, never          priced from the list,
                     charged, no margin       debited from the balance
                                                        │
                                            unresolvable credential
                                                        │
                                                        ▼
                                            ② CREDITS, marked unconfirmed
                                            (counted, alerted above 0.1%)
```

### 5.2 Cap lifecycle

```
      created
         │
         ▼
   ┌──────────┐  spend ≥ 75%   ┌──────────┐  spend ≥ 100%   ┌──────────┐
   │    ok    │ ─────────────► │ warning  │ ──────────────► │ stopped  │
   └──────────┘                └──────────┘                 └──────────┘
         ▲                           ▲                            │
         │                           │                            │ raise the cap
         │      period rolls over    │                            │ or period rolls
         └───────────────────────────┴────────────────────────────┘

   A cap lowered below spend already made enters `exceeded` directly:
   it refuses everything further, and nothing already spent is reversed.

   Notifications:  one per (cap, threshold, period).
   Decisions:      one per (cap, period), raised on entering `stopped` or `exceeded`.
```

### 5.3 Add-on lifecycle

```
   provisioned ──► pending ──(provider confirms)──► active ──(unit deleted)──► removed
                      │                                │                          │
                      │ provider declines              │ unit vanished            │ pro-rated
                      ▼                                ▼  without a delete        ▼  credit
                   failed                            orphan  (reported, not billed on)
```

---

## 6. UX

Every string below is the exact user-visible English and is an i18n key (see
[plan.md §8](./plan.md#8-i18n)).

### 6.1 Home — the one-line week (mounted by AW-19)

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  This week                                                                         │
│  ████████████░░░░░░░░░░░░  412 of 1,000 credits    $18.20 own models   $30.00 add-ons│
│  Allowance renews 1 Oct · 588 left                                                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `This week` · `{used} of {allowance} credits` · `{amount} own models` ·
`{amount} add-ons` · `Allowance renews {date} · {remaining} left`

Loading: the bar renders as a neutral track with `Loading this week's spend…`.
Empty: `Nothing spent this week.` with the allowance line still shown.
Error: `We could not load this week's spend.` with `Retry`. The rest of Home is unaffected.
Over a cap: the bar turns to a striped over-limit fill and the line reads
`Stopped — {capName} reached. [ Open decisions ]`.

Keyboard: the three figures are links in tab order; `Enter` follows.

### 6.2 Billing — three meter cards

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Billing                                     Period  [ This month ⌄ ]   Currency USD │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────┐ ┌────────────────────────┐ ┌────────────────────────┐     │
│ │ ① MODEL USAGE          │ │ ② CREDITS              │ │ ③ ADD-ONS              │     │
│ │                        │ │                        │ │                        │     │
│ │        $61.40          │ │       2,140 cr         │ │       $30.00 / mo      │     │
│ │  paid to your own      │ │  1,000 allowance used  │ │  2 agent inboxes       │     │
│ │  provider accounts     │ │  1,140 from packs      │ │  1 dedicated computer  │     │
│ │                        │ │  3,860 left · no expiry│ │                        │     │
│ │  We add nothing to     │ │  Cap $150 · 41% used   │ │  Never draws credits.  │     │
│ │  this figure.          │ │                        │ │                        │     │
│ │  [ Model accounts ]    │ │  [ Buy credits ]       │ │  [ Manage add-ons ]    │     │
│ └────────────────────────┘ └────────────────────────┘ └────────────────────────┘     │
│                                                                                      │
│  Each unit of spend belongs to exactly one of these three. They never overlap.       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Model usage` · `Credits` · `Add-ons` ·
`paid to your own provider accounts` · `We add nothing to this figure.` ·
`{used} allowance used` · `{used} from packs` · `{left} left · no expiry` ·
`Cap {amount} · {percent}% used` · `Never draws credits.` ·
`Each unit of spend belongs to exactly one of these three. They never overlap.`

Payments not configured: the `Buy credits` and `Manage add-ons` buttons are replaced by
`Card payments are not enabled on this deployment. Usage, caps and the price list still work.`

Empty: `No model usage yet. Connect a model account to keep this at zero on our side.` ·
`No credits used yet. Your allowance renews on {date}.` · `No add-ons.`

### 6.3 Billing — where the credits went

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Where the credits went          This month · 2,140 credits · $21.40                 │
│                                                                                      │
│  BY TOOL                    BY AGENT                     BY MISSION                  │
│  ─────────────────────      ─────────────────────        ─────────────────────       │
│  Web search      910  43%   Nova           1,204  56%    Weekly market scan 1,301 61%│
│  Page fetch      420  20%   Wren             612  29%    Support triage       402 19%│
│  Page audit      300  14%   Research           190   9%  Inbox triage         240 11%│
│  Screenshot      210  10%   Everything else    134   6%  Not in a Mission     197  9%│
│  Extraction      180   8%                                                            │
│  Everything else 120   5%                                                            │
│                                                                                      │
│  [ See all tools ]          [ See all agents ]           [ See all missions ]        │
│                                                                                      │
│  ⓘ 84 credits are from records made before meters were separated (before 6 Sep).     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Where the credits went` · `By tool` · `By Agent` · `By Mission` ·
`Everything else` · `Not in a Mission` · `See all {dimension}` ·
`{credits} credits are from records made before meters were separated (before {date}).`

A Mission row totals the spend of the Tasks that Mission raised. `Not in a Mission` totals the
rest — Tasks filed against no Mission, and Runs that had no Task at all (heartbeats and chats).

Each row is a link into the Run list filtered to that dimension and period.
Loading: three skeleton lists. One panel failing shows
`We could not load spend by {dimension}.` with `Retry`; the other two stay.

Keyboard: `j` / `k` move within a panel, `Tab` moves between panels, `Enter` follows a row.

### 6.4 Billing — the credit price list

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Credit price list                            Version 4 · in effect since 12 Sep 2026│
│  What one call costs. Cached results and failed calls cost nothing.                  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  RESEARCH                                                                            │
│    Web search                                            2 credits   per query       │
│    Page fetch                                            1 credit    per page        │
│    Content extraction                                    3 credits   per page        │
│    Screenshot                                            4 credits   per capture     │
│  DATA                                                                                │
│    Enrichment or profile lookup                          5 credits   per lookup      │
│    Listing and review pull                               4 credits   per source      │
│    Ranking or keyword data                               6 credits   per query       │
│    Live rank check                                       2 credits   per keyword     │
│    Ad-library lookup                                     4 credits   per query       │
│  ANALYSIS                                                                            │
│    Page audit                                           10 credits   per page        │
│  MODELS                                                                              │
│    Managed model access — fast tier         1 credit per 1,000 tokens                │
│    Managed model access — balanced tier     3 credits per 1,000 tokens                │
│    Managed model access — frontier tier    12 credits per 1,000 tokens                │
│    Your own model accounts                            not charged by us              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Earlier calls were priced at version 3. Nothing is ever re-priced.                   │
│  100 credits = $1.00.                                                                │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Credit price list` · `Version {n} · in effect since {date}` ·
`What one call costs. Cached results and failed calls cost nothing.` ·
`not charged by us` · `Earlier calls were priced at version {n}. Nothing is ever re-priced.` ·
`{credits} credits = {money}.`

### 6.5 Billing — caps

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Caps                                                              [ + Add a cap ]   │
│  A cap is a refusal. When it is reached, the next call does not happen.               │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  SCOPE      TARGET          METER      PERIOD    CAP      SPENT     STATE            │
│  ─────────────────────────────────────────────────────────────────────────────────── │
│  Workspace  —               Credits    Month     $150.00  $61.40    ok        41%    │
│  Workspace  —               Model      Month     $400.00  $61.40    ok        15%    │
│  Agent      Nova            Credits    Month      $20.00  $20.00    stopped  100% ⛔ │
│  Agent      Wren            All        Day        $10.00   $2.10    ok        21%    │
│  Mission    Weekly scan     Credits    Month      $40.00  $37.60    warning   94% ⚠  │
│  Work       Directory site  Credits    Month     $100.00  $12.00    ok  (overage on) │
│  Node       build-01        Model      Day        $25.00   $9.40    ok   read-only ↗ │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ⛔ Nova is stopped. [ Open the decision ]                                            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Caps` · `A cap is a refusal. When it is reached, the next call does not happen.` ·
`Add a cap` · `Workspace` · `Agent` · `Mission` · `Work` · `Node` ·
`ok` · `warning` · `stopped` · `exceeded` · `overage on` · `read-only` ·
`{target} is stopped.` · `Open the decision`

Row states: `overage on` appears only on the pre-existing per-Work and per-Agent budgets that
carry the switch, with the tooltip
`This older budget warns instead of stopping. Workspace caps always stop.`
The Node row's arrow opens the Fleet control that owns it; the row is never editable here.

Empty: `No caps yet. Nothing is stopping your agents from spending.` with `Add a cap`.
Error: `We could not load your caps.` with `Retry`.

### 6.6 Add a cap

```
┌────────────────────────────────────────────────────────────┐
│  Add a cap                                            [ ✕ ]│
│                                                            │
│  Scope     ( ) Workspace  (•) Agent  ( ) Mission  ( ) Work │
│  Target    [ Nova                                       ⌄ ]│
│  Meter     [ Credits                                    ⌄ ]│
│  Period    [ Calendar month                             ⌄ ]│
│  Cap       [ $ 20.00                                      ]│
│                                                            │
│  ⓘ This is a hard stop. Nova will stop spending on this    │
│    meter when it reaches $20.00, until 1 October.          │
│                                                            │
│                       [ Cancel ]  [ Add the cap ]          │
└────────────────────────────────────────────────────────────┘
```

Copy: `Add a cap` · `Scope` · `Target` · `Meter` · `Period` · `Cap` ·
`This is a hard stop. {target} will stop spending on this meter when it reaches {amount}, until {date}.` ·
`Add the cap`

Validation copy: `Enter an amount of at least $1.00.` ·
`{target} already has a cap on this meter. Edit that one instead.` ·
`{target} has already spent {amount} this period. This cap will stop it immediately.`

Keyboard: `Esc` closes, `Enter` submits when the form is valid, focus is trapped while open and
returns to the control that opened it.

### 6.7 Add-ons

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Add-ons                          $30.00 per month · never draws credits             │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Agent inbox — nova@…                     $10.00 / mo   active     [ Remove ]        │
│  Agent inbox — wren@…                     $10.00 / mo   active     [ Remove ]        │
│  Dedicated computer — build-01            $10.00 / mo   active     [ Remove ]        │
│  Extra seats — 3                          included      read-only  [ Manage seats ↗ ]│
│  Agent inbox — support@…                  $10.00 / mo   removed 20 Sep               │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Adding one now costs $5.33 for the rest of this period, then $10.00 per month.      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Add-ons` · `{amount} per month · never draws credits` ·
`Agent inbox` · `Dedicated computer` · `Extra seats` · `active` · `removed {date}` ·
`Manage seats` · `Adding one now costs {prorated} for the rest of this period, then {full} per month.`

Removal confirmation: `Remove this add-on? You will be credited {amount} for the rest of this
period, and you will not be billed for it from {date}.`
Orphan row: `This add-on's inbox no longer exists. It has not been billed since {date}.`
`[ Remove the line ]`

### 6.8 A Run receipt's cost block (fills AW-09's Cost block)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  COST                                                                                │
│                                                                                      │
│  ① Model usage        18,420 in · 3,110 out · 9,000 cached read                      │
│                       Billed by your provider to your account "Company key".         │
│                       Ever Works adds nothing.                       $0.31 provider  │
│                                                                                      │
│  ② Credits                                                                  17 cr    │
│     Web search           6 calls   4 charged · 2 from cache                  8 cr    │
│     Page fetch           3 calls   2 charged · 1 failed, no charge           2 cr    │
│     Screenshot           1 call    forced fresh                              4 cr    │
│     Content extraction   1 call                                              3 cr    │
│                                                                                      │
│  ③ Add-ons            Not applicable to a single run.                                │
│                                                                                      │
│  Priced at credit price list version 4.                                              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `Model usage` · `Credits` · `Add-ons` ·
`Billed by your provider to your account "{label}". Ever Works adds nothing.` ·
`{n} charged · {n} from cache` · `{n} failed, no charge` · `forced fresh` ·
`Not applicable to a single run.` · `Priced at credit price list version {n}.`

Unconfirmed line: `We could not confirm which account paid for this call.` `[ Tell us ]`
Not terminal: every figure is suffixed `so far`.
Aged out: `Itemised usage for this Run is older than 12 months and is no longer retained. The
total is unchanged.`
Reconciliation mismatch: `These lines do not add up to the settled total. We are showing both.`

### 6.9 The cap decision in My Decisions

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⛔ Nova reached its $20.00 monthly cap                            2 minutes ago      │
│                                                                                      │
│  Nova stopped mid-run on "Pull this week's listing data". Its credits cap            │
│  for September is fully used. The cap resets on 1 October.                           │
│                                                                                      │
│  [ Raise to $30.00 ]   [ Raise to a different amount ]   [ Leave it stopped ]        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Copy: `{target} reached its {amount} {period} cap` ·
`{target} stopped mid-run on "{task}". Its {meter} cap for {month} is fully used. The cap resets on {date}.` ·
`Raise to {amount}` · `Raise to a different amount` · `Leave it stopped`

The auto-recharge variant:
`Auto-recharge reached its {amount} monthly maximum` ·
`We did not charge your card. Your balance is {credits} credits.` ·
`[ Raise the maximum ]  [ Buy a pack now ]  [ Leave it off until {date} ]`

Denied variant for a viewer without billing permission: the buttons render disabled with
`You need billing permission to change this.`

### 6.10 Keyboard affordances, all surfaces

| Key                 | Where                        | Does                                    |
| ------------------- | ---------------------------- | --------------------------------------- |
| `Tab` / `Shift+Tab` | everywhere                   | move through controls in reading order  |
| `Enter`             | any row or figure            | follow it                               |
| `Esc`               | any dialog                   | close it and return focus to the opener |
| `j` / `k`           | breakdown panels, caps table | next / previous row                     |
| `/`                 | Caps, Add-ons                | focus the filter box                    |
| `p`                 | Billing                      | open the period selector                |
| `?`                 | Billing                      | show the shortcut sheet                 |

No single-key shortcut fires while a text input has focus. Every dialog traps focus while open.
Every state change that matters — a cap stopping, a decision arriving — is announced to assistive
technology politely, and every state (`ok`, `warning`, `stopped`, `exceeded`) is distinguishable
without relying on colour.

---

## 7. Out of scope

- **Changing what a Run does.** This epic prices and stops spend; it never changes an Agent's
  behaviour, its model choice, its prompt or its tools.
- **Model accounts themselves.** Registering, ordering, health-checking and failing over between
  provider accounts is [AW-16](../README.md). This epic only reads which account paid.
- **Run receipts as a surface.** The receipt, its layout and its navigation are
  [AW-09](../AW-09-runs-receipts/spec.md). This epic fills its cost block.
- **Home's layout.** [AW-19](../README.md) owns Home. This epic ships the week line as a
  self-contained card and Home mounts it; until AW-19 lands, the same card renders at the top of
  Billing.
- **The decision queue itself.** [AW-03](../README.md) owns **My Decisions**. This epic writes
  two kinds of item into it.
- **Email send caps.** The per-inbox daily send ceiling is [AW-05](../AW-05-agent-email/spec.md).
  This epic owns only the flat monthly charge for an inbox and the guarantee that sends and
  receives never draw credits.
- **Run time limits and schedule timeouts.** Owned by [AW-09](../AW-09-runs-receipts/spec.md) and
  [AW-16](../README.md).
- **The Fleet per-Node daily ceiling.** It already exists and stays where it is; this epic
  displays it read-only.
- **Changing plan prices, plan structure, invoices, tax, dunning or the payment provider.**
  Untouched.
- **Retiring pay-as-you-go.** The existing overflow-metering path and its monthly cap keep
  working exactly as they do. This epic does not migrate anyone onto or off it.
- **Cost forecasting, anomaly detection, and pre-flight cost estimates.** Estimating what a Task
  will cost before it is dispatched, or what a Mission will cost across the Tasks it raises, is
  worth doing; not here. See §9.
- **Per-Agent or per-Mission invoicing, chargeback or cost centres.** Breakdown is reporting,
  not billing.
- **Changing the credit conversion rate or the pack prices.** They are what they are.
- **A second usage taxonomy.** Breakdowns group by the capability and operation the platform
  already records. This epic does not invent a parallel classification of what a call was "for".

---

## 8. Acceptance criteria

A reviewer can run this list against the merged change.

**The three meters**

- [ ] Every usage record written after the cut-over carries a meter, an outcome, a credits
      charged figure, a price-list version and a paying account class.
- [ ] A usage record's Mission is the Mission of the Task its Run served, captured when the row is
      written and never taken from the Agent; a record whose Run had no Task carries no Mission.
- [ ] A call paid with a Workspace-owned credential produces `0` credits and no ledger movement.
- [ ] A call paid with a platform credential produces credits exactly equal to the price list.
- [ ] No usage record can be produced that belongs to two meters, and none with no meter.
- [ ] A usage record whose kind has no price-list entry is charged `0` and raises an alert.
- [ ] Records written before the cut-over are reported under one explicit label and are excluded
      from the per-meter cards.
- [ ] Model usage is never marked up: the displayed figure equals the provider's own cost, or
      reads "Not priced by this provider".
- [ ] With **Require my own model accounts** set, a Run that would use a platform model
      credential stops before the call.

**Credits**

- [ ] The price list is readable by any member with no payment provider configured.
- [ ] A cached call costs `0`; a failed call costs `0`; a forced-fresh call costs full price.
- [ ] A second identical call inside 24 hours costs `0`.
- [ ] The monthly allowance is granted once per allowance month and expires at its end.
- [ ] A purchased pack has no expiry and is consumed only after the allowance.
- [ ] A checkout request carrying an amount, price or credit quantity is refused.
- [ ] A debit can never take the balance below zero.
- [ ] Changing the price-list version does not change any historical figure.

**Add-ons**

- [ ] Adding an inbox mid-period shows the pro-rated amount before confirmation and bills it.
- [ ] Removing it produces a pro-rated credit and stops the charge from the next period.
- [ ] No add-on ever produces a credit-ledger movement.
- [ ] Deleting the underlying unit removes the add-on within 60 seconds.
- [ ] Provisioning a 26th unit of a kind is refused with the limit stated.
- [ ] Seats appear read-only with a link to the existing seat control.

**Caps**

- [ ] A per-Agent cap can be created, read, edited and removed from the product.
- [ ] The Agent's Budgets tab shows real current-period spend, never zero.
- [ ] A cap at 100% refuses the next call; the Run stops with `budget-stop` naming the cap.
- [ ] An empty balance stops the Run with `credits-exhausted`, which is a different reason.
- [ ] The strictest of several applicable caps wins and is named in the refusal.
- [ ] A cap change takes effect within 30 seconds with no restart.
- [ ] 75%, 90% and 100% each notify exactly once per cap per period.
- [ ] Two concurrent crossings produce one stop, one notification and one decision.
- [ ] Lowering a cap below spend succeeds, shows `exceeded`, and reverses nothing.
- [ ] A second person's save on a stale cap is refused with the current value named.
- [ ] The Node ceiling row is read-only and links to Fleet.
- [ ] Every cap change appears in the activity log with old and new values.

**Auto-recharge**

- [ ] Auto-recharge cannot be enabled without a monthly maximum.
- [ ] A recharge that would cross the maximum contacts no card and raises one decision per month.
- [ ] The maximum resets on the 1st and the amount used is displayed beside it.
- [ ] Three consecutive failures disable it and require an explicit re-enable.

**Visibility**

- [ ] Home shows the week line with all three figures, each linking into Billing.
- [ ] Billing shows three meter cards, and each states what it pays for.
- [ ] By-tool, by-Agent and by-Mission breakdowns each render, rank, cap at 10 rows plus
      "Everything else", and link into the filtered Run list.
- [ ] Spend on a Task raised by a Mission appears in that Mission's row; spend from a Run with no
      Task appears under "Not in a Mission" and in no Mission's row.
- [ ] A Run receipt itemises credits per kind of call with charged, cached and failed counts.
- [ ] The itemisation reconciles to the settled total, or says it does not.
- [ ] A non-terminal Run's figures are labelled "so far".
- [ ] A Run older than 12 months shows the retention notice and keeps its total.

**Scope, permissions and honesty**

- [ ] No endpoint accepts a user, Organization or tenant selector from the caller.
- [ ] A record the caller may not read is indistinguishable from one that does not exist.
- [ ] A read-only teammate sees every number and no enabled money or cap control.
- [ ] CSV export streams, and is refused above 50,000 rows or 92 days before any work starts.
- [ ] No unmeasured quantity renders as `0`.
- [ ] A metering failure never fails a Run.
- [ ] A retried settlement never produces a second debit.
- [ ] Home returns under 300 ms p95; a 90-day breakdown under 800 ms p95; a cap check adds under
      15 ms p95.

---

## 9. Open questions

- **[NEEDS CLARIFICATION: managed model tiers]** Meter 2 prices managed model access by tier
  (fast / balanced / frontier). Who owns the mapping from a concrete model to a tier, and what
  happens on the day a provider ships a model we have not tiered yet — refuse the call, or charge
  the frontier rate and alert? The spec currently implies "no price-list entry means 0 credits and
  an alert", which would give that model away.
- **[NEEDS CLARIFICATION: whose cap in an Organization]** When a Workspace belongs to an
  Organization, does the Workspace cap belong to the Organization (one ceiling, shared) or to each
  member (per-member ceilings that sum)? The current design treats it as one ceiling per
  Organization scope; this needs confirming against how seats are sold.
- **[NEEDS CLARIFICATION: what a stopped Workspace may still do]** A Workspace at its cap
  refuses credit-metered calls. Should it also refuse Runs that would only use the owner's own
  model accounts — spend we do not charge for? Stopping them is safer and simpler to explain;
  allowing them means the product keeps working when the only thing exhausted is our meter.
- **[NEEDS CLARIFICATION: the legacy usage ledger]** A second, schedule-run-centric usage ledger
  exists alongside the credit ledger. Is it still written to? If it is, it needs a meter too; if it
  is not, it should be documented as historical before this epic's reporting is trusted.
- **[NEEDS CLARIFICATION: pre-flight estimates]** Should a Task show an estimated credit cost
  before it is dispatched, and should a Mission show the same estimate rolled up over the Tasks it
  has raised? It is the natural next step from a published price list, it is the thing most likely
  to prevent a surprise, and it is deliberately not in this epic.
- **[NEEDS CLARIFICATION: cache ownership]** The 24-hour freshness window is stated per kind of
  call. Is the cache scoped per Workspace, per Organization, or global? A global cache is cheaper
  and faster; a Workspace-scoped one avoids one Workspace's query telling another Workspace's
  agent that a page was already fetched.
- **[NEEDS CLARIFICATION: the existing service margin]** The platform currently applies a
  configurable percentage margin at debit time. Under a published price list the margin lives
  inside the published prices. Does the configurable percentage stay for self-hosted deployments
  that want to re-price, and if so, does it re-price the published list (breaking the promise that
  the list is the price) or only the managed-model tiers?

---

## 10. Constitution alignment

- **I — Plugin-first.** No new plugin package. Every priced call already flows through an existing
  capability facade; pricing reads the capability and operation, never a Plugin package.
- **II — Capability-driven.** The price list is keyed on capability and operation, never on a
  Plugin id, so swapping the Plugin behind a capability cannot change a price.
- **III — Source-of-truth repos.** Untouched. Money is platform metadata, not Work content.
- **IV — Job runtime.** Cap evaluation, add-on reconciliation and the historical backfill all run
  as background work through the configured job-runtime provider.
- **V — Migrations.** Three additive, forward-only migrations, each shipping with its schema
  change in the same pull request.
- **VI — Tests.** Unit, controller and end-to-end coverage named in [plan.md §10](./plan.md#10-test-plan).
- **VII — Secrets.** No surface displays a credential; the paying account is shown by its label
  only.
- **VIII — Plugin counts.** Unchanged; no plugin is added or removed.
- **IX — Behaviour-first.** This document names no class, file, endpoint or column.
- **X — Backwards compatible.** Existing endpoints keep their shapes; every new field is additive
  and optional; the existing budgets keep their overage switch; the existing ledger, packs,
  pay-as-you-go and invoices are unchanged.

## 11. References

- Program: [`../README.md`](../README.md) · tracker [`../TRACKER.md`](../TRACKER.md)
- Blocking dependency: [`../AW-09-runs-receipts/spec.md`](../AW-09-runs-receipts/spec.md)
- Sibling epics this integrates with: AW-03 My Decisions, AW-05 Agent email, AW-15 Connections
  and scopes, AW-16 Model accounts, AW-19 Home, AW-24 Safety rails
- Implementation: [`./plan.md`](./plan.md) · ordered work: [`./tasks.md`](./tasks.md)
