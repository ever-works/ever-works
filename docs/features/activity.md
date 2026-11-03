---
id: activity
title: Activity
sidebar_label: Activity
---

# Activity

**Activity** is the record of what the platform has done for your account — every generation, deployment, import, plugin change, schedule run, and sign-in, newest first. Reach for it when you want to know what happened and when, whether something is still running, or why a Work no longer looks the way you left it.

The page lives at `/activity` and holds two views: **Log** (what already happened) and **Schedules** (what is set to happen).

## Which view you want

| You want to…                                                     | Go to…                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| See everything that happened across all your Works               | **Activity → Log**                                   |
| See everything happening on **one** directory, visitors included | that Work's own **Activity Feed** tab                |
| See what is going to run next, and when                          | **Activity → Schedules**                             |
| Stop a generation that is running right now                      | **Activity → Log**, then **Stop** on the running row |
| Pull the history into a spreadsheet                              | **Export CSV**, in the Log view                      |

The Log and the per-Work Activity Feed are not the same list — see [Per-Work feed vs the global Log](#per-work-feed-vs-the-global-log).

## The Log view

Entries are ordered newest first and paginated **25 to a page**. In the Log view the page refreshes itself every 5 seconds: the summary cards always, and the table rows when you are in Table view. The timer stops while the browser tab is in the background and fires an immediate refresh when you come back, so a running generation updates without you touching anything.

### Columns

| Column          | What it holds                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Date / Time** | When the entry was recorded.                                                                                                                      |
| **Work**        | The Work it belongs to, as a link. Account-level events (login, signup) show `—`.                                                                 |
| **Type**        | The kind of event.                                                                                                                                |
| **Summary**     | A one-line description. A completed generation summarises what it added and changed, or reports no item changes — with the item total either way. |
| **Status**      | Pending, In Progress, Completed, Failed, or Cancelled.                                                                                            |

Click any row to expand it. The panel shows the exact **Action**, the status, the creation time, and — when the entry carries them — **Details**, **Metadata**, and a **Raw JSON** dump. While an expanded row is still **In Progress**, the platform re-fetches that one entry every 3 seconds (paused when the tab is hidden); for a running generation that is where **Live Logs** stream in.

### Table and Board

The **Table** / **Board** switch sits in the page header. Board groups the same entries into five status columns (Pending, In Progress, Completed, Failed, Cancelled); each column shows 15 cards with a button below it that reveals 15 more at a time, and clicking a card opens the same detail panel as a dialog.

:::caution Board reads at most the newest 500 entries, and it does not poll
Board has no pagination. It loads the newest matching entries in batches of 100 — the API's maximum page size — and stops at **500**. The number on each column header counts only the cards that were loaded, so on an account with more than 500 matching entries those numbers sit below the number of entries that actually match.

Board is also outside the 5-second refresh: it reloads only when you change a filter or switch views, while the summary cards above it keep updating. A Board left open drifts out of step with them — switch to Table and back to reload it. Stopping a generation from a Board card refreshes the table and the cards, not the board.
:::

Your Table/Board choice and your Log/Schedules choice are remembered in the browser. The filters and page number live in the URL instead (`?actionType=…&status=…&search=…&page=…`, plus `?view=schedules`), so a filtered view is a link you can share or bookmark.

### Stopping a running generation

Rows whose type is **Generation** and whose status is **In Progress** carry a red **Stop** button, in both the table row and the Board detail dialog.

:::warning Stop acts on the first click
There is no confirmation dialog. The cancel request goes out as soon as you click, and the button locks for 10 seconds afterwards. If the run happened to finish in the meantime, nothing is cancelled and the list simply refreshes. See [Generation Cancellation](./generation-cancellation.md) for what the platform does with the request.
:::

## Summary cards

Five cards sit above the filters — In Progress, Completed, Pending, Failed, Cancelled. Clicking one applies that status as a filter; clicking it again clears it.

:::caution The card counts ignore your filters
The counts are always your account-wide totals per status. They do **not** shrink when you type in Search or pick a Type — only the list below them responds. A search that returns three rows can still sit under a card reading "Completed 4,812".

The "Showing 1 to 25 of …" line below the list _does_ give you the filtered total — but it appears only when the filtered result runs to more than one page, and never in Board view. When the result fits on a single page, the rows on screen are the count.
:::

## Filters

| Filter     | What it matches                                                                               |
| ---------- | --------------------------------------------------------------------------------------------- |
| **Search** | The entry's summary **or** the Work's name. Case-insensitive, matches anywhere in the text.   |
| **Type**   | One event type, chosen from the dropdown.                                                     |
| **Status** | Pending, In Progress, Completed, Failed, or Cancelled — the same values as the summary cards. |

The three combine with AND: a search of `deploy` with Type **Deployment** and Status **Failed** returns only failed deployments whose summary or Work name contains "deploy". Search is applied after a short pause in typing, so results settle a moment after you stop. A **Clear filters** button appears next to the filters whenever any of them is set.

The Type dropdown offers: Generation, Comparison, Deployment, Work Created, Work Updated, Work Deleted, Plugin Enabled, Plugin Disabled, Plugin Configured, Member Invited, Schedule Executed, Import, Login, and Signup.

:::caution The Type dropdown lists fewer types than the log records
The platform records many more event kinds than the dropdown offers — item changes, settings updates, data-sync outcomes, template and knowledge-base events, member role changes, and schedule create/update/delete among them. Those entries appear normally in the list and in the export, but you cannot select them in the Type filter. Use **Search** to find them by their summary text.

Whether one of these entries still gets a readable badge depends on a separate label list, not on the dropdown: a member role change reads **Role Changed**, while a website-ingested signup has no label at all and falls back to the raw value with underscores turned into spaces — **Website User Registered**.
:::

:::caution No date-range control
The underlying API accepts a date range, but the Activity page never sends one and exposes no date picker. The Date / Time column is not sortable either. The list is already newest first, so the only ways to reach a particular period are to page back through it, or to export to CSV and filter there.
:::

## Exporting to CSV

**Export CSV** sits in the page header in the Log view (it is hidden while you are on Schedules). It downloads a file named `activity-log.csv`.

**The export reflects the filters you have applied.** Search, Type and Status are all carried into the download, so what you get matches what you are looking at — not your whole history.

It exports **every matching row, not just the current page**, with these six columns:

| Column          | Contents                                                         |
| --------------- | ---------------------------------------------------------------- |
| **Date**        | Full ISO 8601 timestamp in UTC, e.g. `2026-08-14T09:31:07.482Z`. |
| **Action Type** | The event type as a raw value (`generation`, `work_created`, …). |
| **Action**      | The specific action recorded for the entry.                      |
| **Status**      | `pending`, `in_progress`, `completed`, `failed`, or `cancelled`. |
| **Work**        | The Work's name, or empty for account-level events.              |
| **Summary**     | The same one-line summary shown in the list.                     |

Two things about the file are worth knowing before you open it:

- **Action Type and Status are raw values, not the labels on screen.** The CSV says `in_progress` where the page says "In Progress". Build spreadsheet formulas against the raw values.
- **A leading apostrophe may appear on some cells.** Every column except Date passes through a formula-injection guard: a value beginning with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` so spreadsheet software renders it as text instead of running it as a formula. The apostrophe is not part of your data.

:::caution The export stops at 10,000 rows
A single download returns at most 10,000 matching entries, and it gives you no warning when it truncates. If your log is larger than that, narrow the filters — by Type or Status — and take several exports rather than one.
:::

## The Schedules view

The **Schedules** toggle in the page header swaps the log for everything scheduled to run across your account, gathered from every source in one list: **Recurring task**, **Agent heartbeat**, **Work schedule**, **Mission tick**, **Source validation**, **Data sync**, and **Inbound trigger**.

Each row shows **Owner** (a link to the thing that owns the schedule), **Cadence**, **Next run**, and **Status** — Active, Paused, Disabled, Error, or Ended. Filter chips across the top narrow the list by source and carry a count each; a source with nothing scheduled gets no chip at all. An **Active only** checkbox hides everything currently switched off. The list is fetched once when you open the view — there is no polling here; reopen the view to refresh it.

:::caution Schedules is a read-only list
You cannot pause, edit, or delete a schedule from this page. Follow the Owner link to the Work, Agent, Mission, or Task that owns it and change it there. The one exception is Inbound triggers, below.
:::

### Inbound triggers

Below the schedules list is the **Inbound triggers** panel — signed webhooks that spawn a Task when something external fires them. Here you can create a trigger, pause or resume it, rotate its signing secret, and delete it. Creating one gives you the webhook URL, the signing secret, and a ready-to-run signed-request example.

:::warning The signing secret is shown exactly once
Copy it before closing the reveal panel — it is never displayed again.

**Rotate secret** is deliberately not a hard cutover. It mints a new secret, demotes the current one to _previous_, and the previous one keeps verifying signatures for **24 hours** — so callers can roll over on their own schedule instead of failing the moment you click. After that window only the new secret is accepted. There is no confirmation step, and the new secret is revealed the same once-only way.

Rotating twice inside the same 24 hours does **not** give you two live old secrets: each rotation overwrites the stored previous one, so the older secret stops working immediately. Roll your callers over before rotating again.

**Delete** does ask for confirmation, and it kills the webhook URL for good.
:::

## Per-Work feed vs the global Log

Every Work has its own **Activity Feed** tab, and it is a different list from `/activity`:

|         | **Activity → Log**                               | **Work → Activity Feed**                                                            |
| ------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Scope   | Everything across all your Works                 | One Work                                                                            |
| Sources | The platform activity log                        | The platform activity log, that Work's generation history, and deployed-site events |
| Filters | Search, Type, Status — all applied by the server | Category chips (server-side), Status (browser-side)                                 |
| Export  | CSV                                              | None                                                                                |
| Paging  | Numbered pages, 25 per page                      | 25 per page over what is loaded; **Next** fetches the next batch at the end         |

The feed's category chips are All, Generation, Items, Deployment, Settings, Comparisons, Community PR, Users, Submissions, Reports, and Sync. A **Refresh** button forces an immediate reload; otherwise the feed polls every 5 seconds and backs off — up to six times the interval — while the API keeps failing.

### Where the deployed site's events land

Each Work carries an **activity sync mode**, set on the Work's Settings page (and in `works.yml` as `activity_sync.mode`). It decides how visitor events from the deployed directory site reach the platform — and therefore whether they also show up in the global Log:

- **Pull** (the default) — the platform fetches events from the deployed site over an HMAC-signed request. Nothing is stored, so those events appear **only** in that Work's Activity Feed tab. The fetch happens on every feed request, not once per visit: because the feed polls every 5 seconds, an Activity Feed tab left open on screen keeps hitting your deployed site on that interval. It is skipped for the chips that have no deployed-site events to ask for — Generation, Deployment, Settings, Comparisons, Community PR and Sync.
- **Push** — the deployed site POSTs each event to `/api/activity-log/ingest`. They become ordinary activity-log rows attributed to the Work's owner, with status Completed, so they **do** appear in the global Log alongside everything else.
- **Disabled** — the deployed site is never consulted. The Users, Submissions and Reports chips are empty unless the Work was in push mode earlier: rows ingested then are ordinary activity-log rows, and switching the mode does not remove them.

The ingest endpoint enforces the mode: a push aimed at a Work that is not in push mode is rejected as a mode mismatch rather than quietly recorded.

:::caution The feed's Status filter only narrows what is already loaded
Unlike the Log, the per-Work feed filters by status **in the browser**, over the entries fetched so far — it does not go back to the server for more. Selecting "Failed" on page 1 will not surface a failed entry that lives further back in the history; page forward first to load it.

Pull-mode entries fetched from the deployed site carry no status at all, so they vanish from every status selection except **All**. Push-mode website events are ordinary log rows with a status of Completed, so they behave like everything else.
:::

If a pull-mode Work's deployed site cannot be reached, a banner names the reason, tells you what to do about it, and shows when the last successful sync was. Push-mode and disabled Works never raise it. When the problem is one that will not clear on its own, the Users, Submissions, and Reports chips are dimmed so you do not keep clicking into empty tabs.

## Known layout trap

:::caution On a narrow window, the AI chat drawer covers the page
Below 768px — phones and split-screen — the AI chat drawer stops being a side panel and opens as a full-screen overlay on top of the page, including **Export CSV** and the Table/Board switch in the header. Close the drawer or widen the window if a button will not take a click.
:::

## Related

- [Generation Cancellation](./generation-cancellation.md) — what happens after you press **Stop**.
- [Scheduled Updates](./scheduled-updates.md) — setting up the Work schedules that show in the Schedules view.
- [Missions](./missions.md) — Mission ticks are one of the schedule sources listed here.
- [Work Changelog](./work-changelog.md) — the per-Work record of content changes.
- [Data Management](./data-management.md) — exporting and moving your data more broadly.
