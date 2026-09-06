# AW-12 — Chat, group conversations and the organization channel

**Program:** [Agent Workspace](../README.md) · **Epic ID:** `AW-12-chat-channels`
**Feature ID:** `chat-channels` · **Branch:** `feat/chat-channels`
**Status:** `Draft` · **Size:** L · **Depends on:** —
**Created:** 2026-09-06 · **Last updated:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design

> Behaviour-first per [Constitution IX](../../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> No class names, no file paths, no code in this document — those live in [plan.md](./plan.md).
> **Additive only** (program rule #1): the single global assistant panel, its history list, its
> provider/model pins, its attachments, its dictation and its canvas all keep working exactly as
> they do today. Everything below is added on top.

**Adjacent epics:** [AW-02 Mission board](../AW-02-mission-board/) (owns the `Chat about it` card
action; this epic owns what happens when it is clicked), [AW-06 Knowledge library](../AW-06-knowledge-library/)
(owns the `#` document picker and reference resolution; this epic consumes it),
[AW-04 Live Feed](../README.md#3-epics) and [AW-13 Attention controls](../README.md#3-epics) (own
notification routing; this epic emits the events), [AW-09 Runs & receipts](../AW-09-runs-receipts/)
(owns the receipt every agent reply links to), [AW-18 Shared dashboards](../AW-18-shared-dashboards/)
(owns teammate read access to surfaces this epic creates).

---

## 1. Overview

This epic turns Ever Works' single global assistant panel into a **conversation system**: many
named **Conversations** instead of one running log, each one addressed at a specific **Agent**, a
group of Agents, or the whole **Organization**.

Concretely, a person can: start a Conversation per piece of work and give it a name; keep that
Conversation **docked** while they move around the product, resize it, navigate inside it back to
the Agent's other Conversations and sideways to another Agent's; pull a second Agent in by
**mentioning** them, which turns the Conversation into a **group** carrying its recent history with
a link back to where it came from; post once to an **organization channel** that reaches every
active Agent, or narrow that same post to two of them with a mention; **read and join** the
Conversations Agents open with each other; see, while typing, exactly which `@` words and `#`
document references will actually resolve; attach files; and **retry** a message that failed to
send instead of losing it.

The load-bearing idea is **addressing**. Ever Works can already run twenty-five Agent executions at
once and parks the rest. The moment more than one Agent can hear a message, "who is expected to
answer this?" stops being a UI nicety and becomes a spend-control question. This epic answers it
explicitly, in the product, per message, and shows the answer back to the person who sent it.

## 2. Why now

### 2.1 The questions our users cannot answer today

> *"I have eleven Agents. Which one am I talking to, where did last Tuesday's conversation about
> the pricing page go, and how do I tell all of them at once that the launch slipped?"*

They cannot answer any of the three. Here is what they do instead.

| What the user wants | What Ever Works gives them today | What they do instead |
| --- | --- | --- |
| "Talk to *this* Agent" | The assistant panel is **not addressed at an Agent at all**. A Conversation row records a user, a provider and a model — there is no Agent on it. The tool-calling assistant is a single generalist. | Open the Agent's detail page and read its run history, then come back to the panel and describe the Agent in prose. |
| "One conversation per job" | Conversations exist and persist, but a new one is created only by pressing **New chat**, which silently clears the panel. Nothing marks a Conversation as being *about* anything. | Let one Conversation run for weeks and scroll. |
| "Name this one, it matters" | Titles exist but are **machine-written only** — auto-derived from the first message, then rewritten once by a model at four messages. There is no way to set or clear a name. | Recognise threads by their first line in the history list. |
| "Keep it open while I work" | The panel does dock and does remember its width — but it holds exactly **one** live conversation, has no internal navigation, and reopening the history list replaces the whole panel body. | Keep two browser tabs open. |
| "Loop in the research Agent" | Impossible. A Conversation belongs to **one user** and has no participant concept of any kind — no second Agent, no second person. | Copy the transcript into a new Conversation and re-explain. |
| "Tell everyone the launch slipped" | Impossible. There is no broadcast of any kind. | Open eleven Conversations and paste eleven times. |
| "What are my Agents saying to each other?" | Agents can already delegate to one another through an explicit collaborator allow-list, and those child executions are real — but the coordination is only visible as separate rows in a run list. | Read two run transcripts side by side and infer the exchange. |
| "Did that reach the paused one?" | Nothing shows delivery. An Agent that is `paused`, in `error`, or parked behind the concurrency valve simply does not act, silently. | Check each Agent's status page one at a time. |
| "This `@` — will it work?" | `@`-mention parsing exists and works server-side **for Task chat**, and `@kb:` document references exist and work server-side **for the assistant panel** — but neither has any composer affordance. Nothing lights up, nothing is picked, and an unresolvable token is dropped after send, silently. | Type the mention, send, wait, notice nothing happened, retype it. |
| "That send failed" | The panel shows a generic inline error banner and the text is gone from the composer. | Retype the message from memory. |

### 2.2 Why this is the right moment

1. **The addressing machinery already exists — in the wrong room.** Task chat already parses
   `@<slug>` and `[[document]]` tokens server-side, validates each against the Agents and documents
   the caller can actually reach, **strips unresolved tokens so a model never sees a hallucinated
   reference**, and dispatches a reply execution per mentioned Agent — deduplicating against an
   Agent's already-live execution instead of double-spawning. That is the hard half of this epic,
   already built, tested, and running. It is simply confined to one object type.
2. **Multi-Agent delegation already ships.** Every Agent carries an explicit allow-list of the other
   Agents it may hand work to. Agent-to-agent coordination is therefore already a real, permissioned,
   bounded thing in this product — it just has no readable surface. This epic gives it one instead
   of inventing a new capability.
3. **Spend control already exists and is about to be stressed.** The platform admits Agent
   executions through a concurrency valve (default 10 concurrent per Work, 25 per Organization) and
   parks the overflow with a recorded reason. A broadcast that starts one execution per Agent is
   exactly the traffic shape that valve was built for — but only if the broadcast surface reports
   what the valve did. Building the broadcast without the reach receipt would be building a way to
   silently exhaust the org's concurrency budget.
4. **The panel is already the right shape.** It already docks, already resizes by pointer drag,
   already persists its width, already has a distinct mobile full-screen mode, and already restores
   the active Conversation across reloads. This epic adds navigation *inside* it, not a new panel.
5. **There is dead weight to reclaim.** Message-edit copy already exists in the message catalogue
   with no component rendering it. This epic either uses those strings or leaves them alone — it
   does not add a second vocabulary next to them.

### 2.3 The problem this epic must not create

The defining failure of a multi-Agent room is that **every Agent answers every message**. In this
product that failure is not merely noisy — it is metered. Eleven Agents replying to one
"thanks, looks good" is eleven executions, eleven model bills, and, past the concurrency valve,
a queue of parked executions that delays real work.

So the addressing rule is a **first-class functional requirement**, not a prompt-engineering
detail (§4.8), and it has two halves that must ship together:

- **The mechanism** — mentions decide who answers; unmentioned Agents may answer only under a
  stated, bounded condition.
- **The expectation** — the product says out loud, in the interface, that an Agent staying quiet is
  correct behaviour and not a fault. Without the second half the first half reads as a bug.

## 3. User scenarios

### 3.1 Primary scenarios

**S-1 — Starting a Conversation with a specific Agent.**
**Given** a person on any dashboard screen with at least one active Agent,
**when** they open the conversation panel, choose an Agent, and send a first message,
**then** a new Conversation is created addressed at that Agent, the panel shows it immediately, the
Agent's reply arrives in the same Conversation, and the Conversation appears in that Agent's
Conversation list titled by its first message.

**S-2 — Naming a Conversation.**
**Given** an open Conversation whose title was written automatically,
**when** the person clicks the name control in the header, types `Q4 pricing page`, and confirms,
**then** the Conversation is listed under that name in bold with its first-message preview beneath
it, the name survives reload, and no further automatic re-titling ever overwrites it.

**S-3 — Clearing a name.**
**Given** a Conversation the person named,
**when** they open the name control, delete the text and confirm,
**then** the Conversation reverts to showing its first-message preview as its identity, and
automatic titling is re-enabled for it.

**S-4 — The panel follows the person.**
**Given** an open Conversation docked on the right,
**when** the person navigates from the Mission board to a Work's items page to Settings,
**then** the Conversation stays docked, keeps its scroll position and its in-flight reply, and does
not close. Only the panel's close control closes it.

**S-5 — Navigating inside the panel.**
**Given** an open Conversation in the docked panel,
**when** the person uses the panel's back control,
**then** the panel body becomes that Agent's Conversation list without leaving the current screen;
**and when** they then click the participant name at the top,
**then** the panel offers the other Agents, the group Conversations and the organization channel,
and choosing one loads it in place.

**S-6 — Resizing.**
**Given** the docked panel,
**when** the person drags its left edge,
**then** it resizes live between 350 px and half the viewport and remembers the width per browser;
**and when** they double-click that same edge,
**then** it snaps back to the default width of 420 px.

**S-7 — Pulling a second Agent in.**
**Given** a Conversation addressed at one Agent,
**when** the person mentions a second Agent and sends,
**then** a group Conversation is created containing both Agents and the person, carrying the last
20 messages of the original, both Conversations show a link to each other, the mentioned Agent
replies in the group, and the original Conversation stays intact with its own history.

**S-8 — Broadcasting to the Organization.**
**Given** a person in an Organization with nine active Agents,
**when** they post to the organization channel without mentioning anyone,
**then** the message is delivered to all nine, each one decides for itself whether it has something
to add, and the message carries a receipt the person can open to see, per Agent, whether the
message was delivered, queued behind the concurrency valve, or skipped because the Agent was
paused.

**S-9 — Narrowing a broadcast.**
**Given** the same channel,
**when** the person posts and mentions exactly two Agents,
**then** only those two are addressed, the other seven receive nothing at all, and the receipt says
so explicitly rather than showing seven silent deliveries.

**S-10 — Reading and joining an Agent-to-Agent Conversation.**
**Given** two Agents that have coordinated with each other,
**when** the person opens the Agent conversations list and selects that pair,
**then** they see the full exchange in order; **and when** they type into it,
**then** their message joins the exchange attributed to them by name, and both Agents receive it.

**S-11 — Live mention and reference highlighting.**
**Given** a person typing in any conversation composer,
**when** they type `@` and two more characters,
**then** a picker appears listing at most 8 matching Agents and Organization members, and the
inserted mention renders as a highlighted chip; **and when** they type an `@` word that matches
nothing, **then** it stays plain text, so a highlight always means the mention will land.

**S-12 — Referencing a document.**
**Given** a person composing a message,
**when** they type `#` and pick a Knowledge Base document,
**then** the reference renders as the document title as a link, and when the message is sent the
addressed Agent receives that document's content in its execution context.

**S-13 — Attaching a file.**
**Given** a person composing a message,
**when** they drop three files onto the composer,
**then** each uploads immediately with a visible chip and progress, the send control stays disabled
until all uploads settle, and the addressed Agent receives the files as reference material.

**S-14 — Retrying a failed send.**
**Given** a message that failed to send because the account hit a rate limit,
**when** the person looks at the Conversation,
**then** the message is still there, marked failed, with the reason in plain language and a
**Retry** control; **and when** they press Retry,
**then** the same message is sent once — never twice — and on success it becomes an ordinary
message in place.

**S-15 — Archiving and restoring a group.**
**Given** a finished group Conversation,
**when** the person archives it from its list row,
**then** it leaves the active list, its transcript is preserved in full, and it appears under an
**Archived** entry at the bottom of the section; **and when** they restore it,
**then** it returns to the position its last activity earns it, not to the top.

**S-16 — Chatting about a Mission.**
**Given** a Mission card,
**when** the person chooses **Chat about it**,
**then** the docked panel opens a Conversation carrying that Mission as attached context, the
Mission is shown as a chip in the Conversation header, and the addressed Agent receives the
Mission's identity without the person pasting anything.

### 3.2 Edge cases, failures, races and denials

**S-17 — Mentioning an Agent the person cannot reach.**
**Given** a person composing a message,
**when** they type the name of an Agent that belongs to a different Organization or has been
archived,
**then** the picker does not offer it, a hand-typed match does not resolve, the token stays plain
text, and the message sends as ordinary prose. The response is identical to mentioning a name that
does not exist anywhere — the product never reveals that a hidden Agent exists.

**S-18 — Two mentions of the same Agent in one message.**
**Given** a message that names the same Agent twice,
**when** it is sent,
**then** exactly one reply execution is started for that Agent.

**S-19 — Mentioning an Agent that is already working on this Conversation.**
**Given** an Agent with a live execution started from this Conversation,
**when** the person mentions it again with a follow-up,
**then** the follow-up is delivered into the running execution rather than starting a second one,
and the Conversation shows that it was delivered to the run in progress.

**S-20 — Broadcast over the concurrency valve.**
**Given** an Organization already at its concurrent-execution ceiling,
**when** a person broadcasts to the organization channel,
**then** the post still succeeds, every Agent that could not start immediately is shown as
**queued** in the receipt with the reason, those replies arrive later as capacity frees, and no
message is lost.

**S-21 — Broadcast to an Organization with no active Agents.**
**Given** an Organization whose Agents are all paused, draft or archived,
**when** a person posts to the organization channel,
**then** the post is stored and visible, the receipt reads **Reached 0 of 4 — all Agents are
paused**, and the channel offers a link to the Agents list rather than failing the send.

**S-22 — Group at capacity.**
**Given** a group Conversation that already contains 8 Agents,
**when** the person mentions a ninth,
**then** the message sends as prose, the mention does not resolve, and an inline notice explains
that a group holds at most 8 Agents and offers to start a new group instead.

**S-23 — Promotion race.**
**Given** two browser tabs open on the same one-to-one Conversation,
**when** both send a message mentioning the same second Agent within the same second,
**then** exactly one group Conversation is created, both messages land in it in send order, and the
second tab follows the first tab's group rather than creating a duplicate.

**S-24 — Archiving something that cannot be archived.**
**Given** the organization channel or an Agent-to-Agent Conversation,
**when** the person opens its row menu,
**then** no archive control is offered, and a direct attempt through any other route is refused
with a plain explanation.

**S-25 — Losing Organization membership mid-session.**
**Given** a person reading the organization channel who is removed from the Organization,
**when** they send their next message,
**then** the send is refused with "You no longer have access to this Organization's channel", the
channel is removed from their sidebar on the next load, and the message text is preserved in the
composer so nothing they typed is lost.

**S-26 — No Organization at all.**
**Given** a person who has never created an Organization,
**when** they open the conversation sidebar section,
**then** there is no organization channel row, an explanatory line reads "Create an Organization to
broadcast to every Agent at once", and one-to-one and group Conversations work normally.

**S-27 — An Agent tries to talk to an Agent it may not talk to.**
**Given** two Agents where the first does not list the second as an allowed collaborator,
**when** the first attempts to open a Conversation with the second,
**then** the attempt is refused, no Conversation row is created, and the refusal is recorded against
the initiating Agent's execution rather than surfaced as a person-facing error.

**S-28 — An Agent pair that will not stop.**
**Given** an Agent-to-Agent Conversation that has reached 20 consecutive Agent-authored messages
with no person's message between them,
**when** either Agent attempts a twenty-first,
**then** it is refused, the Conversation shows a **Paused — waiting for you** state with the reason,
and it resumes only when the person posts into it.

**S-29 — Message too large.**
**Given** a person pasting 40 KB of log output into the composer,
**when** they attempt to send,
**then** the send is blocked before it leaves the browser with "This message is too long (40 KB of
16 KB). Attach it as a file instead", and the **Attach** control is offered inline.

**S-30 — A secret in the composer.**
**Given** a person pasting text that contains what looks like an API key,
**when** they send,
**then** the message is rejected before it is stored, with "This message looks like it contains a
credential. Store it in the connection's settings instead" — matching how Agent instruction files
and Task comments already behave.

**S-31 — Empty states.**
**Given** an Agent with no Conversations, a group section with no groups, an organization channel
with no posts, and an Agent conversations list with no pairs,
**when** each is opened,
**then** each shows its own explanatory empty state with the one action that resolves it, and none
of them renders an empty list frame with no explanation.

**S-32 — The reply that never comes.**
**Given** a person who posts into a group of four Agents without mentioning anyone,
**when** none of them has anything to add,
**then** the Conversation shows a quiet, non-alarming line — "No one had anything to add. Mention
someone by name to ask directly." — and no error, no spinner and no notification are produced.

**S-33 — Reading someone else's Conversation.**
**Given** a person who obtains the address of a Conversation they do not participate in,
**when** they open it,
**then** they get the same not-found response as for a Conversation that does not exist.

## 4. Functional requirements

Every number below is normative.

### 4.1 Conversations, addressing and naming

- **FR-1** A Conversation MUST have exactly one **kind**: `direct` (one person, one Agent), `group`
  (one person, 2–8 Agents), `organization channel` (one per Organization), or `agent pair` (two
  Agents, with the person as a joinable observer).
- **FR-2** A `direct` Conversation MUST be addressed at exactly one Agent, and that address MUST NOT
  change for the life of the Conversation.
- **FR-3** Sending a message from an Agent's composer while no Conversation is open MUST create a
  new Conversation rather than appending to the most recent one.
- **FR-4** Every Conversation MUST be identified in lists by its **name** when it has one, rendered
  above its first-message preview; otherwise by the first-message preview alone. A list row MUST
  NEVER render as "Untitled".
- **FR-5** A person MUST be able to set, change and clear a Conversation's name. The name is capped
  at **200 characters**.
- **FR-6** Setting a name MUST permanently disable automatic titling for that Conversation.
  Clearing the name MUST re-enable it.
- **FR-7** Clearing the name of a `group` Conversation MUST fall back to a name derived from its
  participants (e.g. "Nova, Orion & you"), never to blank.
- **FR-8** The `organization channel` and `agent pair` Conversations MUST keep their own names and
  MUST NOT be renamed or participant-derived.
- **FR-9** A Conversation MAY carry one **attached context** object — a Mission, Task, Work, Idea or
  Agent — set at creation and immutable thereafter.
- **FR-10** When a Conversation carries attached context, the addressed Agent MUST receive that
  object's identity and current summary in its execution context, and the Conversation header MUST
  show the object as a chip linking to it.
- **FR-11** The existing global assistant Conversation — no Agent address, no participants — MUST
  keep working unchanged and MUST be treated as a `direct` Conversation with no Agent.
- **FR-12** Conversation lists MUST be ordered by most recent activity, MUST default to **50** rows,
  and MUST NOT accept a page size above **200**.

### 4.2 The docked conversation panel

- **FR-13** The panel MUST persist across route changes within the dashboard and MUST NOT be closed
  by navigation, by opening a dialog, or by any action other than its own close control.
- **FR-14** The panel MUST provide three views — a Conversation, an Agent's Conversation list, and a
  participant switcher — navigable in that order by a single back control.
- **FR-15** The participant switcher MUST list the person's Agents, their group Conversations, the
  organization channel (when one exists) and an entry into the Agent conversations list.
- **FR-16** The panel MUST be resizable by dragging its left edge, bounded to **≥ 350 px** and
  **≤ 50 % of viewport width**.
- **FR-17** Double-clicking the panel's left edge MUST reset its width to **420 px**.
- **FR-18** Panel width MUST persist per browser and MUST be restored without a visible reflow on
  first paint.
- **FR-19** Below **768 px** viewport width the panel MUST render as a full-screen overlay with the
  same three views and the same close semantics; resize affordances MUST be hidden, not disabled.
- **FR-20** The panel MUST restore the last open Conversation on reload, and MUST fall back to the
  Agent's Conversation list if that Conversation is gone.
- **FR-21** Opening a Conversation from any list, card action or link elsewhere in the product MUST
  load it into the docked panel rather than navigating away from the current screen.
- **FR-22** New messages arriving in the open Conversation MUST appear without a manual refresh
  within **5 seconds**.
- **FR-23** When live delivery is unavailable, the panel MUST fall back to polling at **30 seconds**
  and MUST NOT show an error for the downgrade.
- **FR-24** The panel MUST show an unread marker on Conversations in its lists that have messages
  newer than the person's last read position, and MUST clear it when the Conversation is opened and
  scrolled to the newest message.

### 4.3 The composer — mentions, references, attachments

- **FR-25** Typing `@` in any conversation composer MUST open a mention picker.
- **FR-26** The picker MUST debounce input by **150 ms**, return at most **8** candidates, and rank
  Agents addressed most recently by this person first, then name prefix, then name substring.
- **FR-27** The picker MUST offer only Agents and Organization members the person can actually
  address in this Conversation's kind, and MUST exclude archived Agents.
- **FR-28** A mention inserted from the picker MUST render as a highlighted chip carrying the
  target's display name; two-word names MUST highlight as one unit.
- **FR-29** An `@` word that does not resolve MUST remain plain, unstyled text. A highlight MUST
  therefore always mean the mention will land.
- **FR-30** Mention matching MUST be case-insensitive and MUST require the full display name or the
  full slug — never a prefix.
- **FR-31** A message MUST carry at most **10** resolved mentions; `@` tokens beyond the tenth MUST
  stay plain text and the composer MUST say so before sending.
- **FR-32** Unresolved mention tokens MUST be stripped from what the Agent receives, so no Agent
  ever sees a reference to a participant that does not exist.
- **FR-33** Typing `#` MUST open the Knowledge Base document picker and insert a reference, per
  [AW-06](../AW-06-knowledge-library/spec.md) FR-49–FR-60. Until that epic ships, the existing
  document-reference syntax MUST continue to work unchanged in this composer.
- **FR-34** A resolved document reference MUST render to the person as the document title as a link,
  and MUST cause the referenced document's content to be supplied to the addressed Agent's
  execution.
- **FR-35** The composer MUST support attaching files by picker, drag-and-drop and paste, at most
  **10** per message, each at most **25 MB**.
- **FR-36** The send control MUST be disabled while any attachment upload is in flight, and MUST
  show which attachment is still uploading.
- **FR-37** A message body MUST NOT exceed **16 KB**. The composer MUST block a longer send locally
  with the actual size in the message and offer attachment as the alternative.
- **FR-38** A message whose body matches the platform's credential patterns MUST be rejected before
  storage, with the same wording used for Agent instruction files.
- **FR-39** The composer MUST preserve its text when a send is refused for any reason.
- **FR-40** The composer MUST keep its existing affordances — voice dictation, per-message model
  pin, provider selection — in every Conversation kind where they apply today.

### 4.4 Sending, failure and retry

- **FR-41** Every send MUST carry a client-generated identifier so that a retry of the same message
  can never create a second message.
- **FR-42** A message that fails to send MUST be shown in the Conversation in a **failed** state
  with the reason in plain language, not an error code.
- **FR-43** A failed message MUST survive a page reload and MUST remain retryable.
- **FR-44** A failed message MUST offer **Retry** and **Discard**. Retry MUST reuse the original
  identifier; Discard MUST remove it locally and permanently.
- **FR-45** The system MUST NOT retry a failed send automatically.
- **FR-46** Rate-limit failures MUST be distinguished from provider failures and from network
  failures in the person-facing text.
- **FR-47** Sends MUST be limited to **30 messages per minute per person**, and posts to the
  organization channel additionally to **10 per hour per person**.
- **FR-48** Exceeding either limit MUST produce a failed message with a retry, never a silent drop
  and never a lost composer.

### 4.5 Group Conversations

- **FR-49** A group Conversation MUST be creatable in two ways: explicitly, from a **New group**
  action; and implicitly, by mentioning an Agent inside a `direct` Conversation.
- **FR-50** Implicit creation MUST carry the last **20 messages** or the last **7 days** of the
  originating Conversation, whichever is fewer.
- **FR-51** Implicit creation MUST record a link on both Conversations pointing at each other, and
  both MUST display it.
- **FR-52** Implicit creation MUST NOT modify, move or truncate the originating Conversation.
- **FR-53** A group MUST contain the creating person plus **2 to 8** Agents.
- **FR-54** Attempting to exceed 8 Agents MUST leave the mention unresolved, send the message as
  prose, and explain the limit inline.
- **FR-55** A person MUST be able to add and remove Agents in an existing group. Removing an Agent
  MUST preserve every message it already wrote.
- **FR-56** Concurrent implicit creations from the same originating Conversation and the same
  mentioned Agent MUST produce exactly **one** group.
- **FR-57** A group MUST be archivable from its list row, and archiving MUST preserve the transcript
  in full.
- **FR-58** Archived groups MUST be listed under an **Archived** entry showing at most **100**
  entries, most recently archived first.
- **FR-59** Restoring an archived group MUST return it to the position its last activity earns it,
  not to the top of the list.
- **FR-60** An archived group MUST NOT accept new messages and MUST NOT dispatch Agent replies.
- **FR-61** A group MUST be renamable from inside the Conversation; archiving MUST be offered on its
  list row.
- **FR-62** v1 groups MUST contain exactly **one** person. Multi-person group Conversations are out
  of scope (§7).

### 4.6 The organization channel

- **FR-63** Each Organization MUST have at most **one** organization channel, created on first use.
- **FR-64** The channel MUST be pinned to the top of the Conversations section and MUST NOT be
  reordered by activity.
- **FR-65** The channel MUST NOT be archivable, renamable or deletable.
- **FR-66** Every member of the Organization MUST be able to read and post to the channel.
- **FR-67** A post with **no mentions** MUST be addressed to every Agent in the Organization whose
  status is active.
- **FR-68** A post **with mentions** MUST be addressed only to the mentioned Agents, and Agents not
  mentioned MUST receive nothing.
- **FR-69** Every channel post MUST record a **reach receipt** listing, per Agent, one of:
  `delivered`, `queued` (with the queue reason), `skipped` (with the status that caused it — paused,
  draft, error or archived), or `refused` (with the guardrail that refused it).
- **FR-70** The reach receipt MUST be visible from the message itself and MUST show a summary count
  ("Reached 7 of 9") without being opened.
- **FR-71** A post MUST be refused when the Organization has more than **200** active Agents, with
  an explanation and no partial delivery.
- **FR-72** A post to an Organization with **zero** addressable Agents MUST still be stored and
  displayed, with a receipt saying so.
- **FR-73** Delivery to Agents MUST happen through the platform's background job runtime, never
  inline in the request that posts the message.
- **FR-74** The post request MUST return as soon as the message is stored — it MUST NOT block on
  delivery.
- **FR-75** The channel MUST show each message's author, whether a person or an Agent.
- **FR-76** Losing Organization membership MUST remove the channel from the person's surfaces and
  MUST refuse further posts with an explanation, not a generic error.

### 4.7 Agent-to-Agent Conversations

- **FR-77** An Agent MAY open a Conversation with another Agent **only** when the second Agent is on
  the first Agent's collaborator allow-list.
- **FR-78** There MUST be at most **one** Agent-pair Conversation per unordered pair of Agents.
- **FR-79** Agent-pair Conversations MUST be listed, one row per pair, with the latest message and
  its time.
- **FR-80** A person MUST be able to open any Agent-pair Conversation in their Organization and read
  it in full.
- **FR-81** A person MUST be able to post into an Agent-pair Conversation; their message MUST be
  attributed to them by name and MUST be delivered to both Agents.
- **FR-82** An Agent-pair Conversation MUST pause after **20** consecutive Agent-authored messages
  with no person's message between them, and MUST display a **Paused — waiting for you** state
  naming the reason.
- **FR-83** A paused Agent-pair Conversation MUST resume when a person posts into it, resetting the
  counter.
- **FR-84** Agent-authored messages across all Agent-pair Conversations MUST be limited to **200 per
  day per Organization**; beyond the limit, further Agent messages MUST be refused and recorded.
- **FR-85** Agent-pair Conversations MUST NOT be archivable or deletable by a person in v1; they are
  a record of what happened.
- **FR-86** A person MUST be able to disable Agent-to-Agent Conversations for the whole Organization
  with a single setting, defaulting to **enabled**.

### 4.8 The reply contract

- **FR-87** In a `direct` Conversation the addressed Agent MUST reply to every person's message.
- **FR-88** In a `group` Conversation or the organization channel, a message **with mentions** MUST
  start a reply for each mentioned Agent and MUST NOT start one for any other participant.
- **FR-89** In a `group` Conversation or the organization channel, a message **without mentions**
  MUST be delivered to every addressable Agent, each of which independently decides whether to
  reply. Not replying is a correct outcome and MUST NOT be reported as a failure anywhere.
- **FR-90** At most **8** reply executions MUST be started from any single message; beyond that the
  remainder MUST be recorded as `queued` in the receipt.
- **FR-91** Mentioning the same Agent more than once in one message MUST start exactly one reply.
- **FR-92** A mention of an Agent that already has a live execution started from this Conversation
  MUST be delivered into that execution rather than starting a second one, and the Conversation MUST
  show that it was delivered to a run in progress.
- **FR-93** When a message addressed without mentions produces no replies at all, the Conversation
  MUST render a neutral line stating that no one had anything to add and how to ask directly.

### 4.9 Permissions, scope and privacy

- **FR-94** A Conversation MUST be readable only by its participants, and additionally — for the
  organization channel and Agent-pair Conversations — by members of the owning Organization.
- **FR-95** A request for a Conversation the caller may not read MUST be indistinguishable from a
  request for one that does not exist.
- **FR-96** Mention candidates MUST be scoped to what the caller can already see; the picker MUST
  NOT reveal the existence of any Agent, person or document otherwise hidden from them.
- **FR-97** Conversations, participants and messages MUST carry the platform's tenant and
  Organization scope, and every list MUST filter on the active scope.
- **FR-98** Switching the active Organization MUST switch which organization channel and which
  Agent-pair Conversations are visible, without leaking rows across scopes.
- **FR-99** Attachments MUST inherit the visibility of the Conversation they were posted in.
- **FR-100** Deleting a Conversation MUST delete its messages, its participants and its reach
  receipts. The organization channel MUST NOT be deletable while the Organization exists.
- **FR-101** Deleting an Agent MUST NOT delete Conversations it participated in; its messages remain
  and its participation is marked as departed.
- **FR-102** The existing "delete all my conversations" behaviour MUST continue to delete only the
  caller's own `direct` and `group` Conversations, never the organization channel and never
  Agent-pair Conversations.
- **FR-103** No message body, mention or attachment name may be written to application logs.

### 4.10 Attention, cost and receipts

- **FR-104** A person MUST be notified when they are mentioned by name in a group Conversation or
  the organization channel.
- **FR-105** An Agent's ordinary reply in a Conversation the person is currently viewing MUST NOT
  produce a notification.
- **FR-106** Notification routing, batching and quiet hours are owned by
  [AW-13](../README.md#3-epics); this epic MUST emit the events and MUST NOT implement a second
  routing mechanism.
- **FR-107** Every Agent-authored message MUST link to the execution that produced it, and that
  execution's receipt MUST show what it cost.
- **FR-108** Every organization-channel post MUST show the **total** cost of the executions it
  caused, updating as they complete.
- **FR-109** A message whose reply execution was refused for budget reasons MUST say so in the
  Conversation, naming the cap that refused it.
- **FR-110** Conversation activity MUST be recorded in the platform activity record at the
  granularity of Conversation created, named, archived, restored, and message posted — never the
  message body.

## 5. Key entities

| Concept | Status | Notes |
| --- | --- | --- |
| **Conversation** | **Exists, extended** | Today: one user, an optional machine title, a provider and a model. This epic adds a *kind*, an optional addressed **Agent**, a name that a person owns, an optional attached context object, an archived state, a last-activity time and a link to a related Conversation. No rename, no replacement. |
| **Conversation message** | **Exists, extended** | Today: role, content, parts, model, token usage. This epic adds an **author** (a person or an Agent), resolved **mentions**, **attachments**, a **send status**, a client identifier for safe retry, and — on channel posts — a **reach receipt**. |
| **Conversation participant** | **NEW** | The one genuinely new entity. Today a Conversation has exactly one user and no way to express a second party. A participant is a person or an Agent in a Conversation, with a role (`owner`, `member`, `observer`), a joined and optionally departed time, a last-read position and a mute flag. Everything in this epic that is not one-to-one needs it: group membership, channel membership, Agent pairs, unread state and read receipts. It is added to the program vocabulary table in the same change. |
| **Agent** | **Exists, unchanged** | Addressed by Conversations and by mentions. Its status lifecycle (`draft`, `active`, `running`, `paused`, `error`, `archived`) is what the reach receipt reports against. Its collaborator allow-list is what authorises an Agent pair. |
| **Run** | **Exists, extended** | An Agent reply is a Run like any other. This epic adds a link from a Run back to the Conversation message that triggered it, and a trigger kind for it. |
| **Organization** | **Exists, unchanged** | Owns exactly one organization channel and scopes Agent-pair visibility. |
| **Mention** | **Exists as a field, generalised** | Task comments already carry resolved mentions of people, Agents and documents. The same shape is reused; nothing new is invented. |
| **Reach receipt** | New **field**, not an entity | Per-Agent delivery outcome recorded on a channel post. Deliberately not a table: it is written once, read with its message, and bounded by the Agent count. |
| **Knowledge Base document** | **Exists, referenced** | The `#` reference target. Owned by [AW-06](../AW-06-knowledge-library/). |

### 5.1 Conversation states and transitions

```
                    (person sends first message)
                               │
                               ▼
   ┌──────────┐  name set  ┌──────────┐  name cleared   ┌──────────┐
   │ UNNAMED  │───────────►│  NAMED   │────────────────►│ UNNAMED  │
   │ (preview)│            │ (bold)   │                 │ (preview)│
   └──────────┘            └──────────┘                 └──────────┘
        │                        │
        │  @mention of a second Agent (direct kind only)
        ▼                        ▼
   ┌────────────────────────────────────────────┐
   │  GROUP created — carries last 20 messages, │
   │  both Conversations cross-linked           │
   └────────────────────────────────────────────┘
        │                          ▲
        │ archive (group only)     │ restore (to activity position)
        ▼                          │
   ┌──────────┐                    │
   │ ARCHIVED │────────────────────┘
   │ read-only│
   └──────────┘

  ORGANIZATION CHANNEL:  created-on-first-use ──► active (terminal; never archived)
  AGENT PAIR:            active ⇄ paused-waiting-for-you (20 consecutive Agent messages)
```

### 5.2 Message states

```
  composing ──send──► SENDING ──ok────► SENT ──(agent replies land as new messages)
                         │
                         └──error────► FAILED ──retry──► SENDING
                                          │
                                          └──discard──► (gone, locally)
```

`SENT` is terminal for a person's message. An Agent's message is `SENT` on write.

### 5.3 Reach outcomes for one channel post

```
  post ──► for each addressable Agent:
             ├── delivered   (a reply execution started)
             ├── queued      (admitted later; reason recorded, e.g. concurrency ceiling)
             ├── skipped     (Agent paused / draft / error / archived)
             └── refused     (a guardrail or a budget cap said no; the rule is named)
```

## 6. UX

Copy in this section is the **exact** user-visible text.

### 6.1 The docked panel — Conversation view

```
┌────────────────────────────────────────────────────┐
│ ‹  Nova                                    ⌄   ✕   │  ‹ = up to Nova's conversations
│    Q4 pricing page                         ✎       │  ⌄ = switch participant
│    ◈ Mission: Refresh Q4 pricing                   │  ✎ = name this conversation
├────────────────────────────────────────────────────┤
│                                                    │
│  You · 09:14                                       │
│  Can you check whether the pricing page still      │
│  claims the old trial length? #Pricing policy      │
│                                       ▲            │
│                                       └ document link
│                                                    │
│  Nova · 09:14                                      │
│  It does — three places. I have drafted the fix.   │
│  ┌──────────────────────────────────────────────┐  │
│  │ 📄 Pricing page — trial length corrections   │  │
│  │    Knowledge Base · written 09:14            │  │
│  └──────────────────────────────────────────────┘  │
│  Run receipt · 41s · $0.06                         │
│                                                    │
├────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────┐ │
│ │ Message Nova…                                  │ │
│ └────────────────────────────────────────────────┘ │
│ 📎  🎙  Auto model ⌄                    Send  ↵    │
└────────────────────────────────────────────────────┘
     ▲
     └ drag to resize · double-click to reset
```

### 6.2 The docked panel — an Agent's Conversation list

```
┌────────────────────────────────────────────────────┐
│ ‹  Nova                                    ⌄   ✕   │
├────────────────────────────────────────────────────┤
│  + New conversation                                │
├────────────────────────────────────────────────────┤
│  Q4 pricing page                          ● 09:14  │  ● = unread
│  Can you check whether the pricing page…           │
├────────────────────────────────────────────────────┤
│  Can you summarise yesterday's inbound…    Mon     │  (no name → preview only)
├────────────────────────────────────────────────────┤
│  Launch checklist                          12 Aug  │
│  Here is where we are on the launch…               │
└────────────────────────────────────────────────────┘

EMPTY
│  No conversations with Nova yet.                   │
│  Send a message to start one.                      │
│  [ Message Nova ]                                  │

LOADING
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                                │
│  ▒▒▒▒▒▒▒▒▒▒▒▒                                      │
│  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                                  │

ERROR
│  Could not load conversations.                     │
│  [ Try again ]                                     │
```

### 6.3 The docked panel — participant switcher

```
┌────────────────────────────────────────────────────┐
│ ‹  Switch                                      ✕   │
├────────────────────────────────────────────────────┤
│  Search agents and conversations…                  │
├────────────────────────────────────────────────────┤
│  ◆ Organization channel                    2h      │
│    Everyone — launch moved to the 14th             │
├────────────────────────────────────────────────────┤
│  AGENTS                                            │
│  ● Nova            Research               09:14    │
│  ● Orion           Content                Mon      │
│  ○ Piper           Support        Paused  12 Aug   │
├────────────────────────────────────────────────────┤
│  GROUPS                                            │
│  ● Launch week                            11:02    │
│  ● Nova, Orion & you                      Fri      │
├────────────────────────────────────────────────────┤
│  Agent conversations                         ›     │
├────────────────────────────────────────────────────┤
│  Archived (3)                                ›     │
└────────────────────────────────────────────────────┘
```

`●` = active Agent, `○` = not currently addressable, `◆` = the pinned organization channel.

### 6.4 The Conversations section in the sidebar

```
▾ Conversations                                 + ⌄
  ◆ Organization channel                        2h
  ● Launch week                              11:02
  ● Nova, Orion & you                          Fri
  ● Nova                                     09:14
    Archived (3)                               ›

NO ORGANIZATION
  Create an Organization to broadcast to every Agent
  at once.                        [ Create Organization ]

EMPTY
  No conversations yet.                [ Start one ]
```

### 6.5 The name control

```
┌────────────────────────────────────────────────────┐
│  Name this conversation                            │
│  ┌──────────────────────────────────────────────┐  │
│  │ Q4 pricing page                              │  │
│  └──────────────────────────────────────────────┘  │
│  Clearing the name shows the first message         │
│  instead.                                          │
│                        [ Cancel ]  [ Save ]        │
└────────────────────────────────────────────────────┘

OVER LIMIT
│  Names are at most 200 characters. This one is 214.│
```

### 6.6 Composer — mention picker and live highlighting

```
┌────────────────────────────────────────────────────┐
│  Nova, can you get @or| to check the copy?         │
│                     ┌─────────────────────────────┐│
│                     │ ● Orion         Content     ││
│                     │ ○ Ordering desk  Support    ││
│                     ├─────────────────────────────┤│
│                     │ ↑↓ move · ↵ insert · esc ✕  ││
│                     └─────────────────────────────┘│
└────────────────────────────────────────────────────┘

AFTER INSERT — the chip is highlighted, the plain word is not
┌────────────────────────────────────────────────────┐
│  Nova, can you get (@Orion) to check the copy?     │
│  I asked @someone-else already.                    │
│            ╰── stays plain: this will not be a     │
│                mention                             │
└────────────────────────────────────────────────────┘

PICKER — NO MATCH
│  No agent or teammate matches "zz".                │
│  Keep typing, or press esc to leave it as text.    │

PRE-SEND HINTS (under the composer, non-blocking)
ⓘ Mentioning Orion will start a group conversation with Nova and Orion.
ⓘ Only 10 mentions land in one message. The rest stay as plain text.
ⓘ A group holds up to 8 agents. This one is full — start a new group?
```

### 6.7 The organization channel

```
┌──────────────────────────────────────────────────────────────┐
│ ‹  ◆ Organization channel                            ⌄   ✕   │
│    One message to every active agent                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  You · 08:02                                                 │
│  Launch moves to the 14th. If you are mid-mission on          │
│  anything that assumes the 7th, say so here before you        │
│  change course.                                              │
│                                                              │
│  ✓ Reached 7 of 9                                       ⌄    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Delivered                                              │  │
│  │   Nova · Orion · Iris · Kai · Devon                     │  │
│  │ Queued — organization is at its run ceiling            │  │
│  │   Sasha · Quinn                                        │  │
│  │ Skipped — paused                                       │  │
│  │   Piper                                                │  │
│  │ Skipped — archived                                     │  │
│  │   Halcyon                                              │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ 5 replies · $0.31 so far                               │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Nova · 08:03                                                │
│  Mission "Launch email" assumes the 7th. Rescheduling.       │
│  Run receipt · 12s · $0.04                                   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Message everyone… mention someone to narrow it           │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 📎  🎙                                          Send  ↵      │
└──────────────────────────────────────────────────────────────┘

NARROWED POST
│  ✓ Reached 2 of 9 — you mentioned Nova and Orion        ⌄    │

NO ADDRESSABLE AGENTS
│  ⚠ Reached 0 of 4 — every agent is paused.                   │
│    [ Open agents ]                                           │

OVER LIMIT
│  This organization has 214 active agents. Broadcasts reach   │
│  at most 200. Mention the agents you need instead.           │

NO LONGER A MEMBER
│  You no longer have access to this Organization's channel.   │
│  Your message is still in the box.                           │
```

### 6.8 Group Conversation

```
┌──────────────────────────────────────────────────────────────┐
│ ‹  Launch week                                       ⌄   ✕   │
│    Nova · Orion · Iris · you                         ✎  ⋯    │
│    ↩ Continued from your conversation with Nova              │
├──────────────────────────────────────────────────────────────┤
│  ⓘ Carried the last 20 messages from that conversation.      │
│                                                              │
│  You · 10:58                                                 │
│  (@Orion) can you take the copy pass on this?                │
│                                                              │
│  Orion · 10:58                                               │
│  On it. First draft in about ten minutes.                    │
│  Run receipt · 8s · $0.01                                    │
│                                                              │
│  You · 11:02                                                 │
│  Anything anyone wants to flag before we lock this?          │
│                                                              │
│  ⌁ No one had anything to add. Mention someone by name to    │
│    ask directly.                                             │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Message the group…                                       │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘

ROW MENU (⋯)
┌──────────────────────────┐
│  Rename                  │
│  Add an agent…           │
│  Remove an agent…        │
├──────────────────────────┤
│  Archive                 │
└──────────────────────────┘

ARCHIVED VIEW
│  This conversation is archived. Restore it to reply.         │
│                                           [ Restore ]        │
```

### 6.9 Agent conversations (Agent-to-Agent)

```
┌──────────────────────────────────────────────────────────────┐
│ ‹  Agent conversations                               ⌄   ✕   │
│    What your agents say to each other                        │
├──────────────────────────────────────────────────────────────┤
│  Nova ⇄ Orion                                        11:40   │
│  Orion: sending you the corrected copy now                   │
├──────────────────────────────────────────────────────────────┤
│  Nova ⇄ Iris                                         Mon     │
│  Nova: the source list is stale, can you refresh it?         │
├──────────────────────────────────────────────────────────────┤
│  Kai ⇄ Devon                              ⏸ waiting for you  │
│  Devon: I still think we should hold. Kai?                   │
└──────────────────────────────────────────────────────────────┘

EMPTY
│  Your agents have not needed to talk to each other yet.      │
│  They will appear here when they do.                         │

INSIDE A PAIR
┌──────────────────────────────────────────────────────────────┐
│ ‹  Nova ⇄ Orion                                          ✕   │
├──────────────────────────────────────────────────────────────┤
│  Nova · 11:38                                                │
│  The pricing page copy is wrong in three places.             │
│                                                              │
│  Orion · 11:40                                               │
│  Sending you the corrected copy now.                         │
│                                                              │
│  You · 11:41                                                 │
│  Hold on — check with me before publishing.                  │
│  ╰── your message, attributed to you, delivered to both      │
├──────────────────────────────────────────────────────────────┤
│ │ Step in…                                                 │ │
└──────────────────────────────────────────────────────────────┘

PAUSED
│  ⏸ Paused — waiting for you.                                 │
│    Kai and Devon exchanged 20 messages without you. Post to   │
│    continue.                                                 │
```

### 6.10 Failed send and retry

```
┌──────────────────────────────────────────────────────────────┐
│  You · 09:31                                          ⚠      │
│  Can you pull the last quarter's numbers?                    │
│  ⚠ Not sent — you are sending faster than the rate limit     │
│    allows. Nothing was lost.                                 │
│                              [ Retry ]   [ Discard ]         │
└──────────────────────────────────────────────────────────────┘

OTHER REASONS (same shape, different line)
⚠ Not sent — the model provider is unavailable right now.
⚠ Not sent — you are offline.
⚠ Not sent — this message looks like it contains a credential.
  Store it in the connection's settings instead.
⚠ Not sent — this message is too long (40 KB of 16 KB).
  [ Attach as a file ]

RETRY IN FLIGHT
│  ↻ Sending…                                                  │
```

### 6.11 Budget refusal inside a Conversation

```
│  ⚠ Nova did not reply — the agent's spend cap for this        │
│    period was reached. [ Open caps ]                          │
```

### 6.12 Keyboard affordances

| Key | Where | Effect |
| --- | --- | --- |
| `Enter` | Composer | Send |
| `Shift`+`Enter` | Composer | New line |
| `Esc` | Composer with picker open | Dismiss the picker, keep the text |
| `Esc` | Composer, no picker | Move focus out of the composer; never closes the panel |
| `@` | Composer | Open the mention picker |
| `#` | Composer | Open the document picker |
| `↑` `↓` | Picker open | Move the selection |
| `Enter` / `Tab` | Picker open | Insert the highlighted candidate |
| `↑` | Empty composer | Focus the last message for keyboard reading |
| `Alt`+`←` | Panel | Back one panel view (Conversation → list → switcher) |
| `Alt`+`↑` / `Alt`+`↓` | Panel list | Previous / next Conversation |
| `Ctrl`/`Cmd`+`Enter` | Failed message focused | Retry |
| `Tab` | Panel edge handle | Focus the resize handle; `←`/`→` resize by 16 px; `Home` resets |

Every control named in §6 is reachable by keyboard, has an accessible name, and the panel traps
nothing — focus can always leave it with `Tab`.

## 7. Out of scope

- **Multi-person group Conversations.** A group holds one person and up to 8 Agents. Two people in
  one Conversation is a teammate-access question owned by [AW-18](../AW-18-shared-dashboards/).
- **Message editing, deletion, reactions and quoting.** Existing unused edit strings are left
  exactly where they are; this epic neither uses nor removes them.
- **Threaded replies inside a group or the channel.** Group and channel Conversations are flat.
- **Full-text search across Conversations.** [AW-01](../AW-01-command-palette/) reaches Conversation
  names; searching message bodies is explicitly deferred.
- **Conversation export.** Owned by [AW-22](../README.md#3-epics).
- **The `#` document picker itself.** Owned by [AW-06](../AW-06-knowledge-library/); this epic
  consumes it and keeps today's reference syntax working until it lands.
- **Notification routing, batching, quiet hours and digests.** Owned by
  [AW-13](../README.md#3-epics); this epic only emits.
- **Bridging Conversations to external messaging surfaces.** The existing external chat bridge keeps
  working exactly as it does today and is not extended, rewired or given participants.
- **Changing the assistant's tool-calling behaviour, its tool gating, its canvas or its provider and
  model resolution.** Untouched.
- **Voice or video calls, presence and typing indicators.** Not in v1.
- **Retention or truncation policies for Conversations.** Nothing is auto-deleted by this epic.
- **Per-Conversation model or provider overrides beyond what ships today.**

## 8. Acceptance criteria

**Conversations and naming**

- [ ] A message sent from an Agent's composer with nothing open creates a new Conversation addressed
      at that Agent.
- [ ] A Conversation list row shows a bold name over a preview when named, and a preview alone when
      not; no row ever reads "Untitled".
- [ ] Setting a name stops automatic titling permanently; clearing it restarts it.
- [ ] A 201-character name is refused with the count shown.
- [ ] A group with no custom name displays a participant-derived name.
- [ ] The organization channel and Agent-pair Conversations cannot be renamed.
- [ ] A Conversation opened from a Mission card shows the Mission chip and the Agent receives the
      Mission as context.

**The panel**

- [ ] Navigating across five screens does not close the panel and does not lose the scroll position.
- [ ] The back control walks Conversation → Agent's list → switcher, and the switcher lists Agents,
      groups, the channel and Agent conversations.
- [ ] Dragging the edge resizes between 350 px and 50 % of the viewport; double-clicking resets to
      420 px; the width survives reload with no visible reflow.
- [ ] Below 768 px the panel is a full-screen overlay with the same three views.
- [ ] A new message in the open Conversation appears within 5 seconds without a refresh, and the
      surface degrades to a 30-second poll with no error shown.

**Composer**

- [ ] `@` opens a picker within 150 ms of the second character, showing at most 8 candidates.
- [ ] An inserted mention is highlighted; a hand-typed non-matching `@` word is not.
- [ ] A two-word name highlights as a single unit.
- [ ] The eleventh mention in one message stays plain and the composer says why.
- [ ] `#` opens the document picker and the referenced document reaches the Agent's execution.
- [ ] Eleven attachments are refused; a 26 MB attachment is refused; send stays disabled while an
      upload is in flight.
- [ ] A 40 KB body is blocked in the browser with the real size in the message.
- [ ] A body containing a credential pattern is rejected before storage.
- [ ] Every refusal leaves the composer text intact.

**Failure and retry**

- [ ] A failed send shows a failed message with a plain-language reason, a Retry and a Discard.
- [ ] The failed message survives reload.
- [ ] Retrying twice in quick succession produces exactly one delivered message.
- [ ] The 31st message in a minute fails with a rate-limit reason and a working Retry.

**Groups**

- [ ] Mentioning a second Agent in a one-to-one Conversation creates a group carrying 20 messages,
      cross-linked both ways, leaving the original intact.
- [ ] Two simultaneous promotions from the same Conversation create exactly one group.
- [ ] The ninth Agent cannot be added and the limit is explained inline.
- [ ] Archiving preserves the transcript, removes the group from the active list, and lists it under
      Archived.
- [ ] Restoring returns it to its activity position, not the top.
- [ ] An archived group refuses new messages and starts no executions.

**The organization channel**

- [ ] Exactly one channel exists per Organization and it is pinned first.
- [ ] It cannot be archived, renamed or deleted.
- [ ] An unmentioned post reaches every active Agent; a mentioned post reaches only those named, and
      the receipt distinguishes the two cases in words.
- [ ] The receipt separates delivered, queued, skipped and refused, and names the reason for each
      non-delivery.
- [ ] Posting with the Organization at its run ceiling still succeeds and shows queued Agents.
- [ ] Posting with zero addressable Agents shows "Reached 0 of N" and a link to the Agents list.
- [ ] An Organization with 201 active Agents refuses the broadcast with an explanation and delivers
      nothing.
- [ ] The post request returns before delivery completes.
- [ ] A person removed from the Organization is refused with the stated message and keeps their
      composer text.

**Agent conversations**

- [ ] An Agent cannot open a Conversation with an Agent that is not on its collaborator allow-list.
- [ ] Exactly one Conversation exists per pair.
- [ ] A person can read any pair in their Organization and post into it; their message is attributed
      to them and reaches both Agents.
- [ ] After 20 consecutive Agent messages the pair pauses with the stated reason and resumes on a
      person's post.
- [ ] Disabling Agent-to-Agent Conversations for the Organization stops new pairs being created.

**The reply contract**

- [ ] A mentioned Agent replies; an unmentioned Agent in the same group is not dispatched.
- [ ] An unmentioned post reaches every addressable Agent and produces zero, one or several replies
      without any of those being reported as an error.
- [ ] Mentioning one Agent twice starts one reply.
- [ ] Mentioning an Agent with a live execution from this Conversation delivers into it and the
      Conversation says so.
- [ ] A message that produces no reply renders the neutral "no one had anything to add" line.

**Permissions and cost**

- [ ] A Conversation the caller does not participate in is indistinguishable from one that does not
      exist.
- [ ] Switching Organizations switches the channel and the Agent pairs with no cross-scope leakage.
- [ ] Every Agent message links to a Run receipt showing its cost.
- [ ] A channel post shows the running total cost of the executions it caused.
- [ ] A budget-refused reply says which cap refused it.
- [ ] No message body appears in any log line.

## 9. Open questions

- **[NEEDS CLARIFICATION: should Agents be able to post to the organization channel unprompted?]**
  This spec allows an Agent to *reply* in the channel but does not let one *start* a channel post.
  Allowing it would make the channel a genuine team feed; refusing it keeps the channel a
  person-initiated broadcast. The reach receipt is defined only for person-authored posts today.
- **[NEEDS CLARIFICATION: what exactly is an "active" Agent for broadcast purposes?]** This spec
  reads it as status `active` or `running`. An Agent in `error` is treated as skipped. Product
  should confirm that an Agent that auto-paused after repeated failures should be skipped rather
  than queued for later delivery.
- **[NEEDS CLARIFICATION: does a broadcast reach an Agent that becomes active later?]** Today's rule
  is point-in-time: the receipt is computed at post time and never re-evaluated. A "catch-up on
  resume" rule would need a durable pending-delivery record.
- **[NEEDS CLARIFICATION: should groups be per-person or per-Organization?]** v1 makes a group
  belong to its creator. If two people in an Organization each pull the same two Agents into a
  group, they get two groups. AW-18 may want one shared group instead.
- **[NEEDS CLARIFICATION: how much history should a promoted group carry?]** 20 messages / 7 days is
  a guess calibrated on the 16 KB body cap and typical context budgets. It should be validated
  against real transcript lengths once the surface has usage.
- **[NEEDS CLARIFICATION: unread semantics for the organization channel.]** With every Organization
  member reading the same Conversation, an unread count is per-person, but a very active channel
  could produce a permanently non-zero badge. A "mark all read" is specified; whether the channel
  should badge at all is a Design call, coordinated with AW-13.
- **[NEEDS CLARIFICATION: should the 200-per-day Agent-message ceiling be per Organization or per
  pair?]** Per Organization is specified because that is where the spend lives, but it means one
  chatty pair can consume another pair's allowance.
- **[NEEDS CLARIFICATION: what happens to a group when its last Agent is archived?]** The group
  currently persists as a read-only record. Product may prefer auto-archiving it.
</content>
</invoke>
