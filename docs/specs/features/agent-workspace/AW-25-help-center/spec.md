# AW-25 — Help centre in product · Product Spec

**Epic:** `AW-25-help-center` · **Program:** [Agent Workspace](../README.md)
**Status:** Draft v1 · **Owner:** Product · **Date:** 2026-09-06
**Audience:** Product, Engineering (backend + frontend), Design
**Size:** S · **Blocking dependencies:** [AW-01](../AW-01-command-palette/spec.md) (command palette)
**Soft dependencies:** [AW-14](../AW-14-whats-new/spec.md) (the manual links to What's new, and What's new links back)

> **Additive-only (program rule #1, NN #20).** This epic removes nothing. The existing Help
> drawer keeps all four of its tabs, all of its copy, and its external links. The `?` shortcut
> keeps working. The sidebar user menu keeps every entry it has. This epic adds **one new tab
> in front of the existing four**, **one new full page**, **one shipped article catalogue**, and
> **one link type** that any empty state or error message in the product can point at.
>
> **New nouns, declared up front.** This epic introduces **Help article**, **Help section**,
> **Help link** and **Article feedback**. §5 justifies each one and fences it off from Knowledge
> Base document, Memory, Skill and Changelog entry — none of which it duplicates or renames.

---

## 1. Overview

The product manual, shipped inside the product. A person presses `?` (or the Help control in the
top bar, or types into the command palette) and gets a searchable manual that describes the
build they are actually running: what a Mission is, how to brief an Agent, what a Run receipt
tells them, what to do when something is stuck. Articles are short, written in plain language,
and grouped into six sections. Search runs locally over an index that ships with the build, so it
answers instantly and works with no network at all. Every article has a stable address, so an
empty state can say "How missions work" and an error banner can say "Why am I seeing this?" and
both land the reader on the exact heading that answers them, in a panel over the screen they were
already on — without a new tab, without leaving the product, and without a login wall.

The mechanism that makes this trustworthy is deliberately boring: **the manual is part of the
build artefact**. There is no content management screen, no publishing workflow, no second system
to keep alive, and no way for the manual to describe a screen the running build does not have —
the release refuses to build if an article names a screen that is not there, or if a help link
anywhere in the product points at an article that does not exist.

## 2. Why now

**The user's question this answers:** *"How does this work — and why is this screen telling me
this?"* The [program overview](../README.md#0-why-this-program-exists) frames the gap as
legibility. Every other epic in this program adds a surface; this epic is how a person finds out
what a surface is for, at the moment they are looking at it.

### 2.1 What our users do today

There is one in-product help surface: a slide-over drawer with four tabs. Its total content is:

| Tab | What is actually in it |
| --- | --- |
| Tips | Four sentences. Two of them are about creating a Work; one is about the AI generator; one explains how to reopen the drawer. |
| Shortcuts | Three rows. One of them, "Search works", describes a keystroke that does not open a search — it navigates to a list page and focuses that page's filter box. |
| FAQ | Three questions and three answers. |
| Resources | Four links that leave the product: documentation, the source repository, the issue tracker, the discussion board, plus an environment chip. |

Everything else a person might need to know is on the public documentation site — off-product,
behind a browser tab switch, organised by contributor topic rather than by "what am I looking at",
and written against whatever the site was last built from rather than against the build in front
of them.

### 2.2 The concrete gaps

| Gap | What it costs |
| --- | --- |
| **Help is not where the confusion is.** | A person staring at an empty Missions list gets an empty state with a "Create" button and no explanation of what a Mission is for. The answer exists; it is three clicks and one tab-switch away, and nothing on the screen points at it. |
| **Error messages explain nothing.** | The degraded-background-work banner tells a person that background work is not configured. It cannot tell them what that means for the Agent they just started, or what to do. Its only link is off-product. |
| **The manual can disagree with the build.** | We have already lived this. Constitution VIII exists *because* four different pages each carried a different plugin count. Our own testing documentation describes a CI trigger policy that changed months ago, and our testing overview omits an entire application. Documentation that ships on a different cadence to the code drifts, silently, always. |
| **Self-hosted and air-gapped installs have no manual at all.** | Every help link we ship today points at an external origin. An operator running their own build inside a closed network has an in-product Help drawer containing four tips and four dead links. |
| **Support answers the same question repeatedly.** | The answer is usually "yes, on the screen you are already on" — and there is nowhere in the product to point that reads better than a chat reply. |
| **Discovery does not scale with the product.** | This program adds roughly two dozen surfaces to a product whose navigation is a sidebar with fourteen entries. A surface nobody can find out about is indistinguishable from a surface that was never built. |
| **Translation drift makes half-help worse than no help.** | We ship 21 locales with an English deep-merge fallback. A manual that silently renders half in one language and half in another teaches people not to trust it. |

### 2.3 Why it is cheap

Nearly everything this epic needs already exists and is already proven in the product: a
slide-over panel pattern, a top-bar control that opens it, a global keyboard shortcut that opens
it, a build-identity endpoint that already reports the running version and commit to the
dashboard footer, a shared empty-state component used across the product, a route map that is
already the single source of truth for paths, and — the moment [AW-01](../AW-01-command-palette/spec.md)
lands — a palette that any additional result kind can register into. The work here is a content
pipeline, one panel, one page, and a link type. Sized S.

And it gets **cheaper the earlier it lands**: from that point on, "document it" is a paragraph
written in the same change that ships the feature, reviewed by the same reviewer, released by the
same deploy — instead of a retrospective archaeology exercise across two dozen shipped surfaces.

## 3. User scenarios

### 3.1 Happy paths

**S-1 — Help is one keystroke away, from anywhere.**
**Given** a person is anywhere in the dashboard and focus is not in a text field,
**When** they press `?`,
**Then** the Help panel opens over the current screen within 150 ms with the search box focused,
showing an "On this screen" group naming the articles that document the screen they were on, a
"Recently opened" group, and the six section headings. The screen behind is not navigated away
from and its state is not lost.

**S-2 — Search answers instantly.**
**Given** the Help panel is open,
**When** the person types `cap`,
**Then** matching articles appear within 120 ms of the last keystroke, grouped by section, at most
20 results, with the matched words highlighted in the title or summary. No network request is
made.

**S-3 — Open an article and read it in place.**
**Given** search shows "What it costs and how to cap it",
**When** the person presses `Enter`,
**Then** the panel replaces the results with the article: section label, title, a last-reviewed
date, an "On this page" list of the article's headings, the body, a "Related" list, and a
"Was this helpful?" control. `Esc` returns to the results, not to the closed state.

**S-4 — An empty state explains itself.**
**Given** a person opens the Missions list on a new workspace and it is empty,
**When** the empty state renders,
**Then** it carries a "How this works" link next to its primary action, and activating that link
opens the Help panel directly at the *Missions* article — over the Missions screen, in place, with
no navigation and no new browser tab.

**S-5 — An error message explains itself.**
**Given** the degraded-background-work banner is showing,
**When** the person activates its "Why am I seeing this?" link,
**Then** the Help panel opens at the "When background work is not running" article, scrolled to
the heading that describes that exact banner, with the article's other headings still reachable
from "On this page".

**S-6 — The palette reaches the manual.**
**Given** [AW-01](../AW-01-command-palette/spec.md) has shipped and the person presses the palette
shortcut and types `stuck`,
**When** results render,
**Then** a **Help** group appears alongside the other result groups containing up to 5 matching
articles, and `Enter` on one closes the palette and opens the Help panel at that article.

**S-7 — A link a person can share.**
**Given** a person is reading an article in the panel,
**When** they activate "Copy link",
**Then** an absolute URL of the form `/help/<article>#<heading>` is copied, a toast reads "Link
copied", and pasting that URL into a fresh browser tab opens the same article as a full page with
the dashboard shell around it and the heading scrolled into view.

**S-8 — The manual states which build it describes.**
**Given** an operator is running a self-hosted deployment,
**When** they open Help,
**Then** the panel footer reads "Manual for build 0.4.2 · a1b2c3d", using the same version and
commit the dashboard footer already shows, so it is unambiguous which build the manual describes.

**S-9 — It works with no network.**
**Given** the browser reports no connectivity,
**When** the person opens Help, searches, and opens an article,
**Then** everything works exactly as it does online, because the catalogue and the search index
were delivered with the page. Only the "Was this helpful?" control is affected (S-17).

**S-10 — Feedback that closes the loop.**
**Given** a person has finished reading an article,
**When** they choose "No" under "Was this helpful?",
**Then** an optional one-line note field appears reading "What was missing? (optional)", sending
is one action, the control is replaced by "Thanks — that helps.", and choosing again for the same
article replaces their previous answer rather than counting twice.

**S-11 — The manual only describes screens this person can reach.**
**Given** a person without owner access opens an article whose "Open the screen" button targets a
settings page they cannot reach,
**When** the article renders,
**Then** the article body renders in full and the button renders disabled with the trailing note
"Needs owner access". Nothing about the article is hidden — only the shortcut into a screen they
would be bounced out of.

### 3.2 Unhappy paths, races and empty states

**S-12 — Nothing matches.**
**Given** the person searches for `zzzqqq`,
**When** zero articles match,
**Then** the panel shows "No results for “zzzqqq”." followed by exactly three actions — "Browse
all articles", "Ask the assistant about this", "Contact support" — and a fourth, quieter control
reading "Tell us what you were looking for". The raw query text is **not** recorded anywhere
unless the person uses that control (S-13).

**S-13 — Telling us what was missing is an explicit act.**
**Given** the no-results state is showing,
**When** the person activates "Tell us what you were looking for", types up to 200 characters and
sends,
**Then** the note is stored against no article, the control is replaced by "Thanks — we'll use
this to fill the gap.", and nothing else about their query has been recorded.

**S-14 — A bookmark from a newer build.**
**Given** a person follows `/help/agent-computers` on a deployment whose build does not contain
that article,
**When** the page loads,
**Then** it renders "That article isn't in this build." with the sub-line "This deployment is
running 0.4.2. The article you followed may have been added later, or removed." plus a "Browse
all articles" action and up to 3 nearest-title suggestions from the articles that *are* in this
build. It is not a generic 404 shell, and it never redirects to a different article.

**S-15 — A heading that no longer exists.**
**Given** a shared link points at `#writing-a-brief` and that heading was renamed in this build,
**When** the article opens,
**Then** the article opens at its top rather than at a missing anchor, and a single dismissible
line reads "That section has moved. Here's the whole article." The link is not treated as broken.

**S-16 — A help link in the product points at nothing.**
**Given** an article was removed but a screen still carries a link to it (a case CI is supposed to
prevent),
**When** that screen renders in production,
**Then** the link is **not rendered at all** — the empty state or banner renders exactly as it
would have before this epic, with no dead link, no empty gap and no error. In development the
console carries one warning naming the unresolved link.

**S-17 — Feedback while offline.**
**Given** the browser reports no connectivity,
**When** the person chooses "Yes" or "No",
**Then** the control stays enabled, a muted line reads "Sending feedback needs a connection.", and
nothing is queued for later. Reading the manual is unaffected.

**S-18 — Feedback rate limit.**
**Given** a person has submitted 20 feedback responses in the last 60 minutes,
**When** they submit a 21st,
**Then** the response is rejected and the control reads "That's a lot of feedback in one go. Try
again in a few minutes." Already-recorded responses are unaffected.

**S-19 — A note that contains a credential.**
**Given** a person pastes an API key into the "What was missing?" note,
**When** they send it,
**Then** the note is rejected before it is stored, the control reads "Please remove any keys or
tokens from your note before sending.", the text stays in the field so they can edit it, and no
part of the rejected note is written to storage or to any log.

**S-20 — The search index fails to load.**
**Given** the network drops the search index chunk mid-load,
**When** the person types,
**Then** search degrades to matching article titles and summaries only — which are already in the
panel — results still appear, and a muted footer line reads "Search is limited right now —
matching titles only." The panel does not show an error screen and browsing is unaffected.

**S-21 — The panel is opened while the palette is open.**
**Given** the command palette is open with results on screen,
**When** the person activates a Help result,
**Then** the palette closes first, the Help panel opens with focus in the article, and `Esc` from
the Help panel returns focus to the screen underneath — **not** to the palette.

**S-22 — Two help surfaces cannot both be open.**
**Given** the Help panel is open,
**When** the person presses `?` again,
**Then** nothing happens — it is a no-op that does not reset the panel's scroll position or the
search query.

**S-23 — Nothing has been written yet for a section.**
**Given** a section exists in the build with zero articles,
**When** the person browses,
**Then** that section heading is not rendered at all. There is no "coming soon" row and no empty
section.

**S-24 — A very long article on a narrow screen.**
**Given** a viewport narrower than 768 px,
**When** an article opens,
**Then** the panel renders full-screen, the "On this page" heading list collapses into a single
expandable control, code and command examples scroll horizontally inside their own container, and
the page body itself never scrolls sideways.

**S-25 — The article is only in English.**
**Given** a person whose interface language is not English opens an article,
**When** the article renders,
**Then** the panel chrome (labels, buttons, section names, states) is in their language and a
single line above the body reads "This article is available in English only." The body is not
machine-translated at render time and is not blank.

**S-26 — Signed out mid-read.**
**Given** the session expires while the Help panel is open,
**When** the person activates any control that reaches the server (feedback),
**Then** the read experience continues to work — the manual needs no session — and only the
feedback control reports "Sign in to send feedback."

**S-27 — Printing an article.**
**Given** a person is on the full page for an article,
**When** they print,
**Then** the article prints as the article: title, body, headings and the build stamp, with the
sidebar, top bar, panel chrome and feedback control omitted.

## 4. Functional requirements

### 4.1 What the manual is, and how it stays true

- **FR-1** The manual ships **inside the build artefact**. No article text, article list, or
  search index is fetched from any origin other than the running deployment's own web app, at any
  time, in any state.
- **FR-2** A **Help article** consists of: a stable identifier, exactly one section, a title, a
  one-line summary, up to 12 keywords, the list of screens it documents, an ordered body, an
  ordered list of headings that are addressable link targets, a last-reviewed date, and up to 5
  related articles.
- **FR-3** Limits, all enforced at build time:

  | Thing | Limit |
  | --- | --- |
  | Articles in the whole product | ≤ 200 |
  | Article identifier | lowercase letters, digits and hyphens, 3–64 characters, unique across the product, never reused for a different article |
  | Title | ≤ 70 characters |
  | Summary | ≤ 200 characters |
  | Body | ≤ 20 000 characters |
  | Addressable headings per article | 1–12, each id 2–64 characters, unique within the article |
  | Keywords | ≤ 12, each ≤ 32 characters |
  | Screens documented per article | ≤ 8 |
  | Related articles | ≤ 5, each must exist |

- **FR-4** There are exactly **6** sections, a closed set, in this order: **Start here**,
  **Running the loop**, **Your agents**, **Set-up and connections**, **Money and limits**,
  **When something goes wrong**. Adding a seventh is a deliberate change to this spec.
- **FR-5** The release **must fail to build** when any of these is true:
  1. Two articles share an identifier, or an article has two headings with the same id.
  2. An article names a screen that does not exist in this build's route map, or names a route
     the codebase already documents as dead.
  3. A **help link** used anywhere in the product does not resolve to an article — and, when it
     names a heading, to a heading — that exists in this build.
  4. An article's related-article reference does not resolve.
  5. Any limit in FR-3 is exceeded.
  6. An article is not reachable from its section index.
  7. A link inside an article body (FR-27) points at an article or heading this build does not
     have, at a screen that is not in this build's route map, or at an external address that
     is not a secure (`https`) absolute web address.
- **FR-6** An article may only be added in the same change that ships — or in a change after the
  one that shipped — the screen it documents. There is no state in which the manual describes a
  screen the build does not contain (guaranteed by FR-1 and FR-5.2, not by discipline).
- **FR-7** Every article carries a **last-reviewed date**. An article whose last-reviewed date is
  more than **180 days** old produces a build **warning**, never a build failure, and is reported
  in the weekly content-health summary (FR-40). Staleness is never shown to the reader as a
  warning badge.
- **FR-8** The Help panel and the full page both show the running build's version and short
  commit, taken from the same build identity the dashboard footer already displays. When the build
  identity is unknown, the stamp is omitted entirely rather than showing a placeholder.
- **FR-9** At the point this epic ships, the manual contains **at least 18 articles**, **at least
  2 in every section**, and **at least one article for each of the 12 most-visited dashboard
  screens**.

### 4.2 Getting to the manual

- **FR-10** The manual is reachable by all of the following, from every authenticated dashboard
  screen:
  1. Pressing `?` when focus is not in an input, textarea, select or editable region (the
     existing binding — its target changes, the binding does not).
  2. The persistent Help control in the top bar.
  3. The command palette, in two ways: a command that opens Help, and a **Help** result group
     containing matching articles (FR-16).
  4. The "Help & Docs" entry in the sidebar user menu, which now opens the manual; the external
     documentation link is preserved beside it as a second row.
  5. Any help link (FR-19).
  6. The direct address `/help` and `/help/<article>`.
- **FR-11** Opening Help from inside the product opens a **panel over the current screen**. It
  does not navigate, does not open a browser tab, and does not discard unsaved input on the screen
  beneath.
- **FR-12** The panel becomes visible within **150 ms** of activation at p95, because its
  catalogue is already in the page.
- **FR-13** The manual's four existing Help-drawer tabs — Tips, Shortcuts, FAQ, Resources — remain
  exactly as they are, with their existing copy and links. The manual is added as a **new first
  tab**. No existing tab, string or external link is removed or reworded by this epic.
- **FR-14** `/help` and `/help/<article>` render inside the dashboard shell as ordinary
  authenticated screens. They are not public.
- **FR-15** Opening Help when Help is already open is a no-op: the query, scroll position and
  currently open article are preserved.

### 4.3 Search

- **FR-16** Search runs **entirely in the reader's browser** against an index delivered with the
  build. It issues no request, works offline, and returns results for the palette's **Help** group
  and for the panel from the same index.
- **FR-17** The index is loaded lazily the first time Help is opened in a session, is cached for
  the life of the page, and is **≤ 250 KB compressed**. Loading it completes within **400 ms** at
  p95 on a warm cache; until it resolves, search matches titles and summaries only.
- **FR-18** Search behaviour:
  1. Queries are debounced **120 ms**.
  2. Queries shorter than **2** trimmed characters return no results and leave the browse view in
     place.
  3. Matching is case-insensitive and diacritic-insensitive for Latin scripts.
  4. At most **20** results total, at most **6** per section, grouped by section in the FR-4
     order, except that a section containing a score-100 result is promoted to the top.
  5. Every result carries a deterministic score in `0..100`:

     | Match | Score |
     | --- | --- |
     | Query equals the article title | 100 |
     | Title starts with the query | 90 |
     | An addressable heading starts with the query | 80 |
     | Query equals a keyword | 75 |
     | Title contains the query | 65 |
     | Summary contains the query | 45 |
     | A heading contains the query | 40 |
     | The body contains the query | 25 |

     One additive boost, capped at 100: **+5** when the article documents the screen the reader is
     currently on.
  6. Ties break by: higher score → article documents the current screen → section order → title
     ascending, case-insensitive.
  7. A result whose best match was in a heading opens the article at that heading; every other
     result opens it at the top.
- **FR-19** Search never records the query text (FR-37).

### 4.4 Help links — the part other screens use

- **FR-20** A **help link** is an address of the form `<article>` or `<article>#<heading>`. It is
  the only way a screen elsewhere in the product refers to the manual. Screens never hardcode a
  URL, a title, or a section.
- **FR-21** Activating a help link from inside the product opens the Help panel at that article,
  scrolled to that heading, over the current screen (FR-11). Activating the same address pasted
  into a browser opens the full page.
- **FR-22** A help link whose target does not resolve at runtime renders **nothing at all** — no
  link, no placeholder, no error (S-16). This is a runtime safety net; FR-5.3 means it should be
  unreachable.
- **FR-23** At the point this epic ships, at least **14** surfaces carry a help link, including:
  every empty state on a top-level list screen (Missions, Tasks, Agents, Works, Ideas, Skills,
  Teams, Memory, Knowledge Base, Plugins, Schedules), the degraded-background-work banner, and
  every kind of home-screen attention item that exists in the build (agent error, generation
  failed, task blocked, budget exceeded).
- **FR-24** Help-link copy is one of exactly **two** phrases, so it is recognisable anywhere it
  appears: **"How this works"** on an empty state, **"Why am I seeing this?"** on an error,
  warning or degraded state. Both are translated.
- **FR-25** A help link is never the primary action of the surface it sits on. It never replaces,
  displaces or visually competes with the surface's own call to action.

### 4.5 Reading an article

- **FR-26** An article renders: its section label, title, last-reviewed date, an "On this page"
  list of its addressable headings when it has more than one, the body, related articles when it
  has any, and the feedback control.
- **FR-27** An article body supports exactly these block kinds: paragraph, ordered list, unordered
  list, heading, note/callout, keyboard-shortcut row, code or command block, and a link. Links may
  point at another article, at a screen in this product, or at an external address. External
  links are marked as leaving the product.
- **FR-27a** A **link** is its own block: one line holding one label and one target, nothing
  else. Its label is plain text of 1–80 characters. Its target is exactly one of:
  1. **another article**, optionally at a heading — opens in place, in the panel or on the full
     page, exactly as a help link does (FR-22);
  2. **a screen in this product**, named the same way an article names the screens it documents
     — never as a literal address — and subject to the same reachability rule as "Open the
     screen" (FR-29);
  3. **an external address**, which must be an absolute `https` address with no embedded
     credentials. It opens in a new tab, never passes the current page as a referrer, and is
     visibly and audibly marked as leaving the product.
  A link written inside a paragraph, a link with no label, a literal in-product address, or an
  external address using any other scheme is a build error naming the article and the line
  (FR-5.7). If a link that passed the build somehow reaches the reader with an unsafe or
  unresolvable target, its label renders as plain text with no link at all.
- **FR-28** Article bodies are rendered from structured content produced at build time. No article
  content is ever injected into the page as raw markup.
- **FR-29** An article's "Open the screen" action, when present, resolves through the same route
  map the rest of the product uses. When the reader cannot reach that screen in their current
  scope, the action renders disabled with the trailing reason "Needs owner access" and is skipped
  by keyboard navigation.
- **FR-30** The panel keeps a per-browser list of the **5** most recently opened articles, shown
  in the browse view under "Recently opened". Entries older than **90 days** are discarded. A
  storage failure in any browser must degrade to an absent list, never to an error.
- **FR-31** "Copy link" copies the absolute address of the current article and heading and shows
  a "Link copied" confirmation.

### 4.6 Feedback

- **FR-32** Every article carries "Was this helpful?" with a **Yes** and a **No**. Choosing either
  records one response for that person and that article. Choosing again **replaces** the previous
  response for that person and article — a person can never contribute two responses to the same
  article.
- **FR-33** Choosing **No** reveals an optional note of **≤ 500 characters**. Choosing **Yes**
  does not.
- **FR-34** A person may submit at most **20** feedback responses per **60 minutes**. Exceeding
  this is rejected with the copy in §6.9 and changes nothing that was already recorded.
- **FR-35** A note that matches a credential-shaped pattern is rejected before storage. No part
  of a rejected note is stored, logged, or included in any error report (Constitution VII).
- **FR-36** Feedback responses are retained for **400 days** and then deleted. Aggregate counts
  per article are visible to platform administrators only. No individual response, and no note, is
  ever shown to another workspace member.
- **FR-37** The raw text of a search query is **never** recorded — not in analytics, not in logs,
  not in a database. Only the query **length**, the **result count**, whether it returned zero
  results, and which sections matched are recorded. The single exception is the explicit "Tell us
  what you were looking for" action (S-13), which stores at most 200 characters, subject to FR-35.

### 4.7 Language, accessibility and layout

- **FR-38** All panel and page chrome is translated into every locale the product ships. Leaf
  message names are camelCase and contain no literal dot.
- **FR-39** Article bodies are English in this epic. When the reader's language is not English, a
  single line above the body reads "This article is available in English only." Article bodies are
  never machine-translated at render time.
- **FR-40** Keyboard model:

  | Key | Behaviour |
  | --- | --- |
  | `?` | Open Help (outside text fields) |
  | `Esc` | In an article: back to browse or results. In browse: close and restore focus to the element that had it |
  | `↑` / `↓` | Move the selected search result |
  | `Enter` | Open the selected result |
  | `Home` / `End` | First / last result |
  | `/` | Focus the search box from anywhere inside the panel |
  | `Tab` / `Shift+Tab` | Cycle focus within the panel; focus never escapes to the screen beneath |

- **FR-41** The panel is a modal dialog with a focus trap; content beneath is inert while it is
  open. The search input and results follow the combobox-with-listbox pattern with the active
  result announced via active-descendant. The settled result count is announced politely once per
  settled result set, not per keystroke.
- **FR-42** Article headings are real headings in document order; the "On this page" list is a
  navigation landmark; no information is conveyed by colour alone; every focusable element has a
  visible focus indicator meeting 3:1 contrast in both themes.
- **FR-43** On viewports narrower than **768 px** the panel is full-screen, controls meet a 44 px
  minimum touch target, and the "On this page" list collapses into one expandable control. Wide
  content (command blocks, tables) scrolls inside its own container; the page never scrolls
  horizontally.
- **FR-44** The panel is **480 px** wide on viewports of 768 px and above.
- **FR-45** The full page prints as the article alone: title, body, headings, build stamp. Shell
  chrome, panel chrome and the feedback control are omitted from print.
- **FR-46** The manual is fully usable in right-to-left locales: chrome, lists and the "On this
  page" navigation mirror; article bodies remain left-to-right English blocks within a mirrored
  frame.

### 4.8 Content health

- **FR-47** Once per week the platform produces a **content-health summary** for platform
  administrators containing, per article: response count, the share that were "No", and whether
  its last-reviewed date is older than 180 days (FR-7). It also contains the count of zero-result
  searches for the period and any notes submitted through the S-13 control.
- **FR-48** An article whose responses over the period are **≥ 10** and at least **40%** negative
  is flagged in that summary. The flag is an internal signal only; it is never shown to readers.
- **FR-49** The content-health summary is produced as background work; it never runs inside a
  request.

## 5. Key entities

### 5.1 New — declared and justified (program rule #2)

**A. Help article** *(new)*
The unit a reader opens: one topic, one address, one place in the manual. It is **not** a
Knowledge Base document — a Knowledge Base document is one of the *user's own* documents, scoped
to one Work and living in a repository the user owns; a Help article is our product manual and
ships in our build. It is **not** Memory — Memory is what an agent knows about this workspace. It
is **not** a Skill — a Skill is a capability an agent can execute. It is **not** a Changelog entry
([AW-14](../AW-14-whats-new/spec.md)) — a Changelog entry says *what changed on a date*, a Help
article says *how the current build works*; they link to each other and neither can replace the
other.

*States:* an article is either **in this build** or **not in this build**. There is no draft,
published, scheduled or archived state, because there is no publishing step — an article exists
exactly when the build that contains it is running. This is the whole point of the epic.

*Transitions:* `absent → in this build` when a release containing it is deployed;
`in this build → absent` on a rollback or a removal. A reader holding a link to an absent article
sees S-14.

**B. Help section** *(new)*
One of exactly six groupings (FR-4). It has a name, an order, and the articles that belong to it.
It is a content taxonomy, not a permission, a workspace scope, or a navigation entry in the
sidebar. Stateless.

**C. Help link** *(new, internal)*
A stable address (`<article>` or `<article>#<heading>`) that any screen in the product can carry
in order to point at the manual. It exists so that a screen never encodes a URL, a title, or a
section, and so that the release can prove every one of them resolves (FR-5.3). Readers never see
the address itself — they see the two phrases in FR-24.

*States:* **resolvable** (renders as a link) or **unresolvable** (renders as nothing, S-16). CI
makes the second state unreachable in a released build.

**D. Article feedback** *(new)*
One record per person per article: helpful yes/no, an optional note, when it was given, and which
build it was given against. It is the only thing in this epic that is stored per person, and it
is the only reason this epic touches a database at all.

*States and transitions:* `none → helpful` / `none → not helpful`; either may be replaced by the
other or by itself with a new note (FR-32); every record is deleted 400 days after it was written
(FR-36). There is no "resolved", "answered" or "triaged" state — feedback is a signal, not a
queue, and specifically **not** an Approval, an Escalation, or a My Decisions item.

### 5.2 Existing — read or extended, never changed

| Entity / surface | How this epic touches it |
| --- | --- |
| **Build identity** (version + commit, already reported to the dashboard footer) | Read, to stamp the manual (FR-8). Unchanged. |
| **The dashboard screen map** | Read at build time to verify every screen an article names exists (FR-5.2). Unchanged. |
| **The existing Help drawer** (Tips, Shortcuts, FAQ, Resources) | Gains a new first tab. Its four tabs, their copy and their links are untouched (FR-13). |
| **The `?` shortcut** | Keeps its binding; its target becomes the manual (FR-10.1). |
| **Command palette** ([AW-01](../AW-01-command-palette/spec.md)) | Gains one result group and keeps its existing "Open Help" command. This epic adds a client-side result source; it changes nothing about how the palette queries anything else. |
| **Empty states on list screens** | Gain one help link each (FR-23). Their titles, descriptions and primary actions are unchanged. |
| **The degraded-background-work banner and home attention items** | Gain one help link each (FR-23). Their existing copy, severity and dismissal behaviour are unchanged. |
| **What's new** ([AW-14](../AW-14-whats-new/spec.md)) | Cross-linked: a changelog entry may point at an article, and the manual points at What's new for "what changed recently". Neither owns the other. |
| **Organization / Workspace scope** | Determines only whether an article's "Open the screen" action is enabled (FR-29). Article *content* is identical for every reader in every workspace. |

## 6. UX

### 6.1 Panel — browse (the default state)

```
┌───────────────────────────────────────────────────────────────┐
│  Help                                              Esc     ✕  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ⌕  Search the manual…                                   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ON THIS SCREEN                                               │
│  ›  Missions: hand out work and watch it land                 │
│     One piece of delegated work, from brief to done.          │
│  ›  When a mission is waiting on you                          │
│                                                               │
│  RECENTLY OPENED                                              │
│  ›  What it costs and how to cap it                           │
│  ›  Connecting accounts and what an agent may touch           │
│                                                               │
│  BROWSE                                                       │
│  ▸  Start here                                    5 articles  │
│  ▸  Running the loop                              5 articles  │
│  ▸  Your agents                                   6 articles  │
│  ▸  Set-up and connections                        4 articles  │
│  ▸  Money and limits                              2 articles  │
│  ▸  When something goes wrong                     4 articles  │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│  Manual for build 0.4.2 · a1b2c3d              Open full page │
└───────────────────────────────────────────────────────────────┘
```

Notes: "On this screen" is omitted entirely when no article documents the current screen.
"Recently opened" is omitted when the list is empty (a new reader, or a browser that refuses
storage). A section with zero articles is not rendered (S-23).

### 6.2 Panel — search results

```
┌───────────────────────────────────────────────────────────────┐
│  Help                                              Esc     ✕  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ⌕  cap                                              ✕   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  MONEY AND LIMITS                                             │
│  ▸  What it costs and how to **cap** it                       │
│     Set a ceiling per agent, per workspace, per month.        │
│  ▸  Credits, plans and invoices                               │
│                                                               │
│  YOUR AGENTS                                                  │
│  ▸  Agents: who they are and what they can do                 │
│     → in "Giving an agent a spending **cap**"                 │
│                                                               │
│  6 results                                                    │
├───────────────────────────────────────────────────────────────┤
│  Manual for build 0.4.2 · a1b2c3d              Open full page │
└───────────────────────────────────────────────────────────────┘
```

A result whose best match was a heading shows that heading beneath the title with a `→` prefix and
opens the article there (FR-18.7).

### 6.3 Panel — reading an article

```
┌───────────────────────────────────────────────────────────────┐
│  ‹ Back to Help                                    Esc     ✕  │
│                                                               │
│  RUNNING THE LOOP                                             │
│  Missions: hand out work and watch it land                    │
│  Reviewed 12 Aug 2026                                         │
│                                                               │
│  ON THIS PAGE                                                 │
│  ·  What a mission is        ·  When it needs you             │
│  ·  Writing a good brief     ·  Stopping one                  │
│                                                               │
│  A mission is one piece of delegated work. You describe the   │
│  outcome; an agent breaks it into tasks and works through     │
│  them, coming back to you only for the decisions that are     │
│  yours to make.                                               │
│                                                               │
│  What a mission is                                            │
│  ─────────────────                                            │
│  …                                                            │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Open Missions                                          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  RELATED                                                      │
│  ›  Tasks: the steps inside a mission                         │
│  ›  My Decisions: answering what only you can answer          │
│                                                               │
│  Was this helpful?   [ Yes ]  [ No ]           Copy link      │
├───────────────────────────────────────────────────────────────┤
│  Manual for build 0.4.2 · a1b2c3d              Open full page │
└───────────────────────────────────────────────────────────────┘
```

### 6.4 Panel — loading the index (first open only)

```
┌───────────────────────────────────────────────────────────────┐
│  Help                                              Esc     ✕  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ⌕  Search the manual…                                   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  BROWSE                                                       │
│  ▸  Start here                                    5 articles  │
│  ▸  Running the loop                              5 articles  │
│  ▸  Your agents                                   6 articles  │
│  ▸  Set-up and connections                        4 articles  │
│  ▸  Money and limits                              2 articles  │
│  ▸  When something goes wrong                     4 articles  │
│                                                               │
│  ░░░░░░░░░░░  preparing search…                               │
├───────────────────────────────────────────────────────────────┤
│  Manual for build 0.4.2 · a1b2c3d              Open full page │
└───────────────────────────────────────────────────────────────┘
```

Browsing is fully usable while the index loads; the only thing gated is body-text matching.

### 6.5 Panel — no results

```
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ⌕  zzzqqq                                           ✕   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  No results for “zzzqqq”.                                     │
│                                                               │
│  ›  Browse all articles                                       │
│  ›  Ask the assistant about this                              │
│  ›  Contact support                                           │
│                                                               │
│  Tell us what you were looking for                            │
```

After activating the last control:

```
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ What were you trying to do?                    0 / 200  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                     [ Skip ]      [ Send ]    │
```

…and after sending: `Thanks — we'll use this to fill the gap.`

### 6.6 Panel — search degraded

```
│  MONEY AND LIMITS                                             │
│  ▸  What it costs and how to cap it                           │
│                                                               │
│  1 result                                                     │
│  Search is limited right now — matching titles only.          │
```

### 6.7 Full page — `/help`

```
┌──────────────┬────────────────────────────────────────────────┐
│  ⌕ Search…   │  Help                                          │
│              │  The manual for the build you're running.      │
│  Start here  │                                                │
│  Running…    │  START HERE                                    │
│  Your agents │  ›  What this product does for you             │
│  Set-up…     │     The shortest possible explanation.         │
│  Money…      │  ›  Your first hour                            │
│  When…       │  ›  How to brief an agent so it lands          │
│              │                                                │
│              │  RUNNING THE LOOP                              │
│              │  ›  Missions: hand out work and watch it land  │
│              │  ›  Tasks: the steps inside a mission          │
│              │  …                                             │
│              │                                                │
│              │  Manual for build 0.4.2 · a1b2c3d              │
└──────────────┴────────────────────────────────────────────────┘
```

### 6.8 Full page — article not in this build

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│   That article isn't in this build.                           │
│                                                               │
│   This deployment is running 0.4.2. The article you followed  │
│   may have been added later, or removed.                      │
│                                                               │
│   Did you mean?                                               │
│   ›  Computers an agent can use                               │
│   ›  Agents: who they are and what they can do                │
│                                                               │
│   [ Browse all articles ]                                     │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Suggestions are omitted entirely when no title is a near match; the "Browse all articles" action
is always present.

### 6.9 A help link in situ — an empty state and an error banner

```
┌───────────────────────────────────────────────────────────────┐
│                          (icon)                               │
│                    No missions yet                            │
│      Hand out your first piece of work and watch it land.     │
│                                                               │
│              [ New Mission ]     How this works               │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│ ⚠  Background work isn't configured                        ✕  │
│    Scheduled and long-running jobs won't run until it is.     │
│    Why am I seeing this?    ·    Open job runtime settings    │
└───────────────────────────────────────────────────────────────┘
```

The help link is always secondary: plain text-weight, never a filled button, never first in the
action row (FR-25).

### 6.10 Feedback control — every state

```
resting        Was this helpful?   [ Yes ]  [ No ]
after Yes      Thanks — that helps.
after No       Thanks — that helps.
               ┌───────────────────────────────────────────┐
               │ What was missing? (optional)      0 / 500  │
               └───────────────────────────────────────────┘
                                    [ Skip ]      [ Send ]
sent           Thanks — that helps.
offline        Was this helpful?   [ Yes ]  [ No ]
               Sending feedback needs a connection.
rate limited   That's a lot of feedback in one go. Try again in
               a few minutes.
credential     Please remove any keys or tokens from your note
               before sending.
signed out     Sign in to send feedback.
```

### 6.11 Exact user-visible copy

| Where | Copy |
| --- | --- |
| Panel title | `Help` |
| Top-bar control tooltip | `Help — press ?` |
| Search placeholder | `Search the manual…` |
| Group heading | `On this screen` |
| Group heading | `Recently opened` |
| Group heading | `Browse` |
| Section names | `Start here` · `Running the loop` · `Your agents` · `Set-up and connections` · `Money and limits` · `When something goes wrong` |
| Article count | `{count} articles` / `1 article` |
| Result count | `{count} results` / `1 result` |
| Back control | `Back to Help` |
| Article meta | `Reviewed {date}` |
| Article headings list | `On this page` |
| Related list | `Related` |
| Screen action | `Open {screen}` |
| Screen action, blocked | `Needs owner access` |
| Copy link | `Copy link` → toast `Link copied` |
| Build stamp | `Manual for build {version} · {commit}` |
| Full-page link | `Open full page` |
| Full-page subtitle | `The manual for the build you're running.` |
| English-only notice | `This article is available in English only.` |
| Moved heading notice | `That section has moved. Here's the whole article.` |
| No results | `No results for “{query}”.` |
| No-results actions | `Browse all articles` · `Ask the assistant about this` · `Contact support` |
| No-results report control | `Tell us what you were looking for` |
| Report placeholder | `What were you trying to do?` |
| Report sent | `Thanks — we'll use this to fill the gap.` |
| Degraded search | `Search is limited right now — matching titles only.` |
| Index loading | `preparing search…` |
| Feedback prompt | `Was this helpful?` · `Yes` · `No` |
| Feedback note prompt | `What was missing? (optional)` |
| Feedback sent | `Thanks — that helps.` |
| Feedback offline | `Sending feedback needs a connection.` |
| Feedback rate-limited | `That's a lot of feedback in one go. Try again in a few minutes.` |
| Feedback credential | `Please remove any keys or tokens from your note before sending.` |
| Feedback signed out | `Sign in to send feedback.` |
| Not in this build — title | `That article isn't in this build.` |
| Not in this build — body | `This deployment is running {version}. The article you followed may have been added later, or removed.` |
| Not in this build — suggestions | `Did you mean?` |
| Not in this build — action | `Browse all articles` |
| Help link — empty state | `How this works` |
| Help link — error/warning | `Why am I seeing this?` |
| Send / Skip | `Send` · `Skip` |

### 6.12 Keyboard affordances

| Context | Key | Behaviour |
| --- | --- | --- |
| Anywhere in the dashboard | `?` | Open Help (outside text fields) |
| Anywhere in the dashboard | palette shortcut | Open the palette; the **Help** group is one of its result groups |
| Panel, browse or results | `/` | Focus the search box |
| Panel, results | `↑` `↓` | Move the selection, skipping section headings |
| Panel, results | `Home` `End` | First / last result |
| Panel, results | `Enter` | Open the selected article |
| Panel, article | `Esc` | Back to results, or to browse when there was no query |
| Panel, browse | `Esc` | Close and return focus to the element that opened it |
| Panel, anywhere | `Tab` `Shift+Tab` | Cycle focus inside the panel only |
| Full page | standard document navigation | — |

## 7. Out of scope

1. **Authoring in the product.** There is no editor, no publish button, no preview mode, no
   scheduling and no per-workspace content. Articles are written in the repository and released
   with the code. This is the mechanism, not a limitation to fix later.
2. **Per-workspace or per-customer manuals.** Every reader on a build sees the same articles.
3. **Video, images and animated walkthroughs.** Text, lists, callouts, keyboard rows and command
   blocks only.
4. **An interactive product tour.** Onboarding is [AW-20](../README.md#3-epics).
5. **Translating article bodies.** Chrome is translated; bodies are English (FR-39). Revisit when
   the manual stabilises — see Q-2.
6. **Answering questions with a model over the manual.** The no-results state offers "Ask the
   assistant about this", which hands the question to the existing assistant. This epic adds no
   retrieval, no embedding and no model call of its own.
7. **Serving the manual to other clients.** The CLI, the desktop app and the machine-facing
   interfaces do not get the manual in this epic. See Q-4.
8. **A public, unauthenticated help site.** The published documentation site keeps existing,
   untouched. A generated mirror of the manual onto it is P3 and optional.
9. **Replacing the existing Help drawer tabs.** Tips, Shortcuts, FAQ and Resources stay exactly as
   they are (FR-13). Folding their content into articles is a later, separate decision.
10. **A support desk, live chat, or a contact form.** "Contact support" points at the existing
    external support destination the Resources tab already uses.
11. **Per-article read state and an unread badge.** That is [AW-14](../AW-14-whats-new/spec.md)'s
    model for changelog entries, and it is wrong for a manual — a manual is a reference, not a
    feed.
12. **Analytics on reading behaviour.** No dwell time, no scroll depth, no heatmaps.

## 8. Acceptance criteria

A reviewer can run this list against a build.

**Reaching it**
- [ ] `?` opens the Help panel from the home screen, a list screen, a detail screen and a settings
      screen, and does nothing while the caret is in a text field.
- [ ] The top-bar Help control opens the same panel; its tooltip reads `Help — press ?`.
- [ ] The palette's `Open Help` command opens the panel, and typing a word that appears in an
      article title produces a **Help** group.
- [ ] The sidebar user menu's `Help & Docs` opens the panel, and the external documentation link
      is still present as a separate row.
- [ ] `/help` and `/help/<article>` load inside the dashboard shell; both require a session.
- [ ] Opening Help while Help is open changes nothing.

**Not disagreeing with the build**
- [ ] Adding an article that names a screen which does not exist fails the build with a message
      naming the article and the screen.
- [ ] Adding a help link to a screen for an article identifier that does not exist fails the
      build.
- [ ] Two articles with the same identifier fail the build; two headings with the same id inside
      one article fail the build.
- [ ] The panel footer and the full page both show the same version and commit as the dashboard
      footer.
- [ ] With the build identity unset, the stamp is absent — not `undefined`, not a placeholder.
- [ ] An article-body link to a missing article or heading, to a screen not in the route map, to a
      literal in-product address, or to a non-`https` external address fails the build with a
      message naming the article and the line.

**Searching**
- [ ] Typing 1 character produces no results and leaves browse in place; 2 characters searches.
- [ ] Searching produces zero network requests (verify in the network panel).
- [ ] A term that matches an article title outranks a term that matches only a body paragraph.
- [ ] At most 20 results and at most 6 per section are shown.
- [ ] Blocking the search index chunk still yields title matches plus the degraded footer line.
- [ ] With the browser offline, the panel opens, searches and renders an article normally.

**Deep links**
- [ ] At least 14 surfaces carry a help link; each opens the panel in place at the right article
      and heading, without navigating.
- [ ] Every help link uses exactly one of the two approved phrases.
- [ ] Pointing a help link at a removed article renders no link at all, and the surrounding
      surface renders unchanged.
- [ ] Pasting an article URL into a new tab opens the full page at the right heading.
- [ ] A URL naming a heading that no longer exists opens the article at the top with the
      "That section has moved" line.
- [ ] A URL naming an article this build does not have shows the "not in this build" page with the
      running version, never a generic 404 and never a redirect.

**Reading**
- [ ] An article renders section, title, reviewed date, "On this page", body and related list.
- [ ] A link block to another article opens it in place; a link block to a screen navigates there
      and is disabled with `Needs owner access` when unreachable; a link block to an external
      address opens a new tab, sends no referrer, and is announced as opening outside the app.
- [ ] The "Open {screen}" action is disabled with `Needs owner access` for a reader who cannot
      reach it, and is skipped by arrow-key navigation.
- [ ] "Copy link" copies an absolute URL and toasts `Link copied`.
- [ ] The five most recently opened articles appear under "Recently opened"; with storage
      disabled, the group is simply absent and nothing throws.

**Feedback**
- [ ] Yes and No each record one response; choosing the other replaces it rather than adding one.
- [ ] The note field appears only after No, and caps at 500 characters.
- [ ] The 21st response in an hour is rejected with the rate-limit copy.
- [ ] A note containing a credential-shaped string is rejected, the text is preserved in the
      field, and nothing about it appears in server logs.
- [ ] Offline, the control reports it needs a connection and queues nothing.

**Language, accessibility, layout**
- [ ] Every string in §6.11 comes from the message catalogue in every shipped locale; no key name
      contains a literal dot.
- [ ] A non-English locale shows translated chrome and the English-only notice above the body.
- [ ] The panel traps focus; `Esc` restores focus to the element that opened it.
- [ ] Arrow keys move through results and skip section headings; the result count is announced
      once per settled result set.
- [ ] At 375 px wide the panel is full-screen, touch targets are ≥ 44 px, and the page does not
      scroll horizontally on any article.
- [ ] In a right-to-left locale the chrome mirrors and nothing overlaps.
- [ ] Printing an article page produces the article without shell or feedback chrome.

**Content health**
- [ ] The weekly summary reports per-article response counts, negative share, staleness, the
      zero-result search count and any submitted notes.
- [ ] An article with 10+ responses and ≥ 40% negative is flagged in that summary and nowhere in
      the reader-facing UI.

## 9. Open questions

- **Q-1** [NEEDS CLARIFICATION: Should the manual be readable without a session? A public
  `/help` would let us answer pre-signup questions and would let a support reply link to an
  article a person can actually open — but it publishes our product manual to anyone who finds the
  URL, and for self-hosted deployments it is an unauthenticated surface on a private install.
  Proposal: authenticated in this epic (FR-14), revisit with a per-deployment switch.]
- **Q-2** [NEEDS CLARIFICATION: When do article bodies get translated, and by which pipeline? The
  automated translation pass we already run for interface strings is tuned for short strings, not
  for 20 000-character prose, and a half-translated manual is worse than an English one. Proposal:
  English-only until the corpus stops changing weekly, then a per-article, human-reviewed pass.]
- **Q-3** [NEEDS CLARIFICATION: Does "Ask the assistant about this" pre-fill the assistant with the
  failed query only, or with the query plus the titles of the nearest articles? The second is more
  useful and is also the first step towards answering from the manual, which §7.6 puts out of
  scope. Proposal: query only in this epic.]
- **Q-4** [NEEDS CLARIFICATION: Should the manual be readable by an agent? An agent that can read
  the manual can answer "how do I…" in chat without a model guess. That requires serving the
  catalogue from the API rather than only from the web build, which is a real cost and a second
  copy of the content pipeline. Proposal: out of scope here, sized separately.]
- **Q-5** [NEEDS CLARIFICATION: Should the 12 most-visited screens in FR-9 be measured from
  analytics before P1 content is written, or fixed by product judgement? Measuring is better but
  the instrumentation currently reports route groups rather than screens.]
- **Q-6** [NEEDS CLARIFICATION: Do we want an "edit this article" link for internal staff that
  deep-links to the source file in the repository? It shortens the fix loop considerably but leaks
  a repository path to every reader unless it is gated on platform-administrator status.]
- **Q-7** [NEEDS CLARIFICATION: What is the retention and access policy for the S-13 "what were you
  looking for" notes? They are free text a person typed and can therefore contain anything.
  Proposal: same 400-day retention and platform-administrator-only visibility as feedback notes
  (FR-36), with the same credential rejection (FR-35).]
