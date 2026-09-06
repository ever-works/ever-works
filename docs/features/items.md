---
id: items
title: Items (Posts, Pages)
sidebar_label: Items
description: The Items workbench on /works/:id/items — browsing, adding and editing items, the markdown body editor, taxonomy sub-views, source health, screenshots, import/export, and the MCP and CLI equivalents.
---

# Items (Posts, Pages)

**Items are the content of a [Work](./creating-a-work.md).** In a directory they are the listings; in a blog they are the posts; on a marketing website they are the pages. The **Items** tab (`/works/:id/items`) is where you see everything a generation run produced, add entries by hand, rewrite their long-form markdown, curate them into categories, tags and [collections](./collections.md), and check that every source URL still resolves.

Everything on this page writes to the Work's **data repository** in your own Git account — one commit (or one pull request) per action. There is no hidden database copy of your items.

## Where the tab is, and what it is called

The tab label and its very existence come from the per-kind capability registry (`work-capabilities.ts` in `@ever-works/contracts`), so a Work only shows the surfaces its kind actually uses:

| Work kind      | Items surface | Tab label | Taxonomy sub-views | Bulk import / export | Source validation |
| -------------- | ------------- | --------- | ------------------ | -------------------- | ----------------- |
| `directory`    | Yes           | **Items** | Yes                | Yes                  | Yes               |
| `default`      | Yes           | **Items** | Yes                | Yes                  | Yes               |
| `awesome-repo` | Yes           | **Items** | Yes                | Yes                  | Yes               |
| `blog`         | Yes           | **Posts** | Yes                | No                   | No                |
| `website`      | Yes           | **Pages** | No                 | No                   | No                |
| `landing-page` | No            | —         | No                 | No                   | No                |
| `company`      | No            | —         | No                 | No                   | No                |
| `campaign`     | No            | —         | No                 | No                   | No                |

`default` is the kind every Work created before kinds existed carries, and it deliberately shares the directory capability set exactly — the registry is a hide-list for the newer kinds, never an allow-list for the old ones.

:::note What the registry gates today

The registry decides whether the **Items / Posts / Pages** tab appears in the Work's tab strip and which Overview metric tiles you get. The sub-view strip _inside_ the Items page is not itself kind-gated yet: a Website Work still renders Categories, Tags, Collections and Source Health, and the underlying API routes are not kind-gated either. Read the last three columns above as the statement of intent — the same way [Item Import & Export](./item-import-export.md) does — and see [Work Kinds & Capabilities](./work-kinds.md) for the full matrix.

:::

## The five sub-views

| Sub-view          | What it is for                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **Browse Items**  | Search, filter and open every item; the row menu holds all per-item actions.               |
| **Categories**    | Create, rename and delete the primary classification buckets. An item carries one or more. |
| **Tags**          | Create and delete the cross-cutting labels an item can carry several of.                   |
| **Collections**   | Curated editorial groupings that cut across categories ("Editor's Picks").                 |
| **Source Health** | Turn on recurring source-URL checks and pick how often they run.                           |

The **Export**, **Import** and **Add Item** buttons in the page header are only shown while you are on **Browse Items**.

## Browsing items

The page shell — title, sub-view strip, search box, header buttons — paints immediately, then the rows fill in. Items and taxonomy are fetched client-side because the API has to clone or pull your data repository first, which on a large repo takes 10–20 seconds; while that runs you see **"Please wait, we are loading your items from the data repository of this Work…"** above a skeleton list.

Once loaded, the Browse view gives you:

- **Search** over item name and description (`Search items...`).
- A **category filter** dropdown built from the categories actually present on the items, plus **All Categories**.
- A **grid / list** view toggle. Grid shows 1 column on a narrow pane, 2 from a small pane width and 3 on a wide one. The steps are container queries on the dashboard's main pane, so the column count follows the width of that pane — collapsing the sidebar widens the grid without the browser window changing size.
- A **"Showing {current} of {total} items"** counter.
- **Sorting** you cannot change: featured items first, then by the item's `order` field, then alphabetically.
- **Virtualized rendering**, so a directory with thousands of items scrolls without stalling the browser.
- A **health badge** on any item whose last source check came back anything other than _healthy_ or _unchecked_ — it names the problem, carries the check message, and shows when the check ran.
- Per-card links to **View on website** and **Open source URL**.

A Work with no items shows the **No Items Yet** empty state and a **Generate Items** button that sends you to `/works/:id/generator`.

## How to add an item by hand

You need the **editor** role or higher on the Work — viewers see the list without the **Add Item** button or the row menu's write actions.

1. Open the Work and click the **Items** (or **Posts** / **Pages**) tab — `/works/:id/items`.
2. Stay on **Browse Items** and click **Add Item**. The **Add New Item** modal opens.
3. Paste the **Source URL** and click **Retrieve**. The platform fetches the page and uses AI to fill in name, description, tags, categories, brand and images — the toast reads _"Item details retrieved successfully"_. Skip this step and type everything yourself if you prefer.
4. Check **Name** and **Description**, and pick at least one **Category** (search the existing ones, or type a new name and click **Create**).
5. Add **Tags** — type one and press Enter for each.
6. Optionally set **Slug**, **Brand** and **Brand Logo URL**. An empty slug is generated from the name.
7. Write the **Content (Markdown, optional)** body — see [the markdown editor](#the-markdown-body-editor) below.
8. Add **Images** by URL, or click **Capture Screenshot** to grab one from the source URL (see [Screenshots](#screenshots)).
9. Toggle **Featured Item** to pin it to the top of the list and of the generated site.
10. Toggle **Create Pull Request** if you want the change proposed as a PR instead of committed straight to the default branch.
11. Click **Add Item**. The new row appears in the list immediately, and the item is committed to the data repository.

### Fields the Add Item form accepts

| Field                            | Payload key               | Required | Limits and notes                                                                                             |
| -------------------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| **Source URL**                   | `source_url`              | Yes      | `http`/`https` with a real TLD. Private, loopback, link-local and cloud-metadata hosts are rejected.         |
| **Name**                         | `name`                    | Yes      | Max 200 characters.                                                                                          |
| **Description**                  | `description`             | Yes      | Max 5,000 characters.                                                                                        |
| **Categories**                   | `categories` / `category` | Yes      | At least one; each name max 200 characters.                                                                  |
| **Tags**                         | `tags`                    | No       | Max 50 tags, each max 50 characters.                                                                         |
| **Slug (Optional)**              | `slug`                    | No       | Derived from the name when empty; whatever you type is normalised to lowercase letters, digits, `-` and `_`. |
| **Brand (Optional)**             | `brand`                   | No       | Max 200 characters.                                                                                          |
| **Brand Logo URL (Optional)**    | `brand_logo_url`          | No       | Same URL rules as the source URL — it is fetched server-side.                                                |
| **Content (Markdown, optional)** | `markdown`                | No       | Max 100,000 characters. Empty means a stub body is generated.                                                |
| **Images (Optional)**            | `images`                  | No       | Each URL is validated and fetched server-side under the same host rules.                                     |
| **Featured Item**                | `featured`                | No       | Sorts the item first in the list and on the site.                                                            |
| **Create Pull Request**          | `create_pull_request`     | No       | Proposes the change as a PR instead of a direct commit.                                                      |

## The markdown body editor

Every item has a long-form markdown body that becomes its detail page on the generated site. When you leave it empty, the platform writes a stub built from the name, description and source URL — so the site always has a page — and you can replace it at any time.

The editor is the same control in both places it appears:

- A plain textarea (**Content (Markdown, optional)** in the Add Item modal, 10 rows; **Edit content** dialog, 14 rows).
- A **Preview** button that renders the body below the textarea with GitHub-Flavoured Markdown, using typography that approximates the generated site. Click **Hide preview** to collapse it. The button is disabled while the body is empty, and the preview closes itself if you clear the text.
- The preview renderer strips any link protocol that is not `http`/`https`, and wraps wide tables in their own horizontal scroller.

Two honest limits: the preview cannot render the custom MDX components (`<Tag>`, `<TagList>`) that only exist on the site's own render path — they show as their plain-text fallback — and the body is capped at 100,000 characters, rejected by the API before any Git work starts.

### How to rewrite an existing item's body

1. Go to `/works/:id/items` → **Browse Items**.
2. Open the item's **⋮** row menu and choose **Edit content**.
3. Edit the body — the dialog opens pre-filled with whatever the item has now, stub or authored — and use **Preview** to check it.
4. Leave **Create Pull Request** off to commit directly, or switch it on to open a PR.
5. Click **Update item**.

Saving an unchanged body closes the dialog without creating a commit, so you never churn the repository with empty diffs. The body is written to `data/<slug>/<slug>.md` and mirrored onto the item's YAML `markdown` field.

## The row menu: every per-item action

| Action                 | When it appears                                                | What it does                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Edit display**       | Always                                                         | Toggles **Featured Item** and sets **Display order** — lower numbers show earlier within the featured and non-featured groups.                               |
| **Edit content**       | Always                                                         | Opens the markdown body dialog described above.                                                                                                              |
| **Re-check source**    | The item has a source URL                                      | Runs a single source-health check now and writes the verdict onto the item.                                                                                  |
| **Apply suggestion**   | The last check proposed a better source URL                    | Replaces `source_url` with the suggested one and resets the item's health to _unchecked_.                                                                    |
| **Capture screenshot** | The item has a source URL and at least one screenshot provider | Opens the provider dialog, captures the page and appends the image to the item.                                                                              |
| **Delete**             | Always (editors)                                               | Confirms with _"This will remove {name} from the repository."_, and takes an optional **Reason** (max 500 characters) plus a **Create Pull Request** toggle. |

**Edit display**, **Edit content** and **Delete** all offer the same **Create Pull Request** toggle: _"If enabled, changes are proposed via PR instead of direct commit."_

## Categories, Tags and Collections

Three sub-views, one shape: a search box, an **Add …** button, a table with an item count per entry, and a create/edit modal.

| Sub-view        | Table columns                               | Modal fields                                     |
| --------------- | ------------------------------------------- | ------------------------------------------------ |
| **Categories**  | Name, Description, Items, Priority, Actions | Name (required), Description, Icon URL, Priority |
| **Tags**        | Name, Items, Actions                        | Name (required)                                  |
| **Collections** | Name, Description, Items, Priority, Actions | Name (required), Description, Icon URL, Priority |

- **Priority** orders entries in lists — lower numbers appear first.
- Tag names should be lowercase with hyphens for multi-word tags (`open-source`, `free-tier`).
- An entry that still has items assigned **cannot be deleted** — the toast reads _"Cannot delete category with {count} items assigned"_ (likewise for tags and collections). Reassign the items first.
- Names are unique per Work, and the rule is enforced twice. The modal checks the name against the entries already loaded and refuses to submit a match, and the API checks again — so a name a colleague created while your list was open still comes back rejected, as _"A category with this name already exists"_ (likewise for tags and collections).

Categories, tags and collections are stored as YAML in the data repository, not in a database — see [Taxonomy System](./taxonomy-system.md) for the file format and [Collections](./collections.md) for how curated groupings reach the site.

## Source Health

The **Source Health** sub-view holds the **Source Health Checks** card — _"Automatically check item source URLs on a recurring schedule."_

1. Open `/works/:id/items` → **Source Health**.
2. Switch on **Enable scheduled checks**.
3. Pick a **Check frequency** — hourly, daily, weekly or monthly, limited to the cadences your plan allows.
4. Click **Save**.

Per-item checks stay available from the row menu (**Re-check source**, **Apply suggestion**) whether or not the schedule is on. [Item Source Validation](./item-source-validation.md) explains the verdicts — _Healthy_, _Needs review_, _Broken link_, _Could not verify_ — and what the scheduler does with them.

## Screenshots

Image capture runs through a screenshot plugin; the platform ships the **ScreenshotOne** and **Urlbox** screenshot plugins, and the Items page asks the API which providers are configured before offering the buttons.

When you click **Capture Screenshot** (in the Add Item form) or **Capture screenshot** (in a row menu), the **Choose screenshot provider** dialog opens: _"Select which screenshot provider to use for this item."_ Pick a configured provider and click **Capture screenshot**. The captured image is appended to the item's images. Both entry points are hidden entirely when no provider is configured — see [Plugins](./plugins.md) to add one.

## Bulk operations

There is exactly one work-scoped bulk operation on items today, and it is about images:

| Operation                | Endpoint                                  | Body                                                                                          |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| Bulk capture item images | `POST /api/works/:id/bulk-capture-images` | `mode`: `"missing"` (only items with no images) or `"all"`; optional `itemSlugs` to narrow it |

It requires the editor role, skips items without a source URL, and returns a per-item result list with `successCount` / `errorCount` and the source of each image (`screenshot`, `scraped` or `vision_selected`). If no screenshot provider is available it returns an error result rather than failing silently.

The platform's end-to-end suite probes the obvious neighbours — `items/bulk-delete`, `items/bulk-update`, `items/bulk-publish` — and treats their absence as expected: those endpoints are **not** exposed. To change many items at once, use [CSV / Excel import](./item-import-export.md), or run an AI update over the Work from the Generator tab.

Bulk image capture is also deliberately excluded from the platform chat tool registry, so an agent conversation cannot fire it off implicitly; call the endpoint, or use the Items UI.

## Export and Import

Both halves are off by default and enabled per Work under **Settings → Item Import & Export**:

- With `export_enabled` on, an **Export** dropdown appears next to **Add Item** offering **CSV** and **Excel (.xlsx)**. It is visible to anyone who can view the Work.
- With `import_enabled` on, editors also get an **Import** button that opens a five-step wizard: **Upload → Mapping → Preview → Confirm → Results**.

The full column contract, the validation rules, the row cap and the exact `.works/works.yml` keys are documented on [CSV & Excel Item Import / Export](./item-import-export.md).

## Where items actually live

A Work owns three Git repositories, and an item passes through all of them before it reaches a visitor:

```mermaid
flowchart LR
    UI["Items tab<br/>/works/:id/items"] --> D["my-work-data<br/>data/slug/slug.yml + .md"]
    G["Generation run<br/>/works/:id/generator"] --> D
    D --> M["my-work<br/>README.md + details/slug.md"]
    D -. cloned into .content at runtime .-> W["my-work-website<br/>deployable site"]
    W --> V["Deploy"]
```

Inside the data repository:

```text
.works/works.yml        Work configuration (including export_enabled / import_enabled)
categories.yml          Categories
tags.yml                Tags
collections.yml         Collections
data/
  my-item/
    my-item.yml         Item metadata (name, description, source_url, category, tags, ...)
    my-item.md          Long-form markdown body (optional; the site prefers this file)
```

The item's `slug` is the folder and file name — it is never written _inside_ the YAML. Each write also stamps `updated_at`, and an unchanged item is skipped entirely so it produces no Git diff. The markdown repository is regenerated from the data repository: a curated `README.md` plus one `details/<slug>.md` per item that has a body.

### What a generation run may overwrite

| Run                                             | Effect on your hand-edits                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update items** (`create-update`, the default) | Existing categories, tags and collections are **merged**, not replaced. Any generated item whose slug matches an existing one is rewritten — hand-edited fields on that item can be replaced. Its recorded source-health verdict is preserved. Items the run does not produce are left alone. |
| **Recreate** (`recreate`)                       | The data repository's generated files are cleared first, and the markdown repository is reset to what the generator owns. Items no longer produced are recorded as _removed_ in the [Work changelog](./work-changelog.md).                                                                    |

Two practical consequences: give a hand-written item a slug the generator is unlikely to reproduce if you want it left untouched, and treat **Recreate** as destructive to anything you added by hand. Secret-looking values in an item body are redacted on the way into the public markdown repository, so an imported or AI-authored body cannot leak a live-looking credential into a published README.

## Machine access

### MCP tools

The [MCP server](./mcp-server.md) exposes the item routes as tools, so an agent or an MCP-capable editor can manage items directly:

| Tool                   | Endpoint behind it                   | What it does                                                                   |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| `get_work_items`       | `GET /api/works/:id/items`           | Returns every item in the Work.                                                |
| `submit_item`          | `POST /api/works/:id/submit-item`    | Adds one item, with the same payload as the Add Item form.                     |
| `update_item`          | `POST /api/works/:id/update-item`    | Updates one item's `featured`, `order`, `source_url` or `markdown`.            |
| `remove_item`          | `POST /api/works/:id/remove-item`    | Removes one item by `item_slug`, with an optional `reason`.                    |
| `extract_item_details` | `POST /api/extract-item-details`     | The **Retrieve** button: AI-extracts item fields from a URL.                   |
| `update_items`         | `POST /api/works/:id/update`         | Starts an **AI update run** over the Work's existing items — not a batch edit. |
| `get_categories_tags`  | `GET /api/works/:id/categories-tags` | Reads the Work's taxonomy.                                                     |

Taxonomy writes and the import/export routes are not exposed as MCP tools — use the dashboard or the REST API for those.

### CLI

The [CLI](../cli/work-commands.md) covers the two single-item write paths interactively:

```bash
# Prompts for work, source URL, name, description, category, tags,
# brand, images and featured, then confirms before submitting.
ever-works work submit-item

# Prompts for work, item slug and an optional reason, then confirms.
ever-works work remove-item
```

Both refuse to continue unless your role on the selected Work is editor or higher.

### REST API

| Method | Path                                 | Purpose                                                                            |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET`  | `/api/works/:id/items`               | Full item list. There is no server-side pagination — the dashboard virtualizes it. |
| `GET`  | `/api/works/:id/count`               | Item, category and tag counts.                                                     |
| `GET`  | `/api/works/:id/categories-tags`     | Categories and tags for the Work.                                                  |
| `POST` | `/api/works/:id/submit-item`         | Add one item.                                                                      |
| `POST` | `/api/works/:id/update-item`         | Update `featured`, `order`, `source_url`, `markdown`.                              |
| `POST` | `/api/works/:id/remove-item`         | Remove one item.                                                                   |
| `POST` | `/api/works/:id/check-item-health`   | Run one source-health check now.                                                   |
| `GET`  | `/api/works/:id/source-validation`   | Read the scheduled-check settings.                                                 |
| `PUT`  | `/api/works/:id/source-validation`   | Enable or disable scheduled checks and set the cadence.                            |
| `POST` | `/api/works/:id/bulk-capture-images` | Bulk image capture.                                                                |
| `POST` | `/api/works/:id/categories`          | Create a category (`PUT` / `DELETE` on `/:categoryId`).                            |
| `POST` | `/api/works/:id/tags`                | Create a tag (`PUT` / `DELETE` on `/:tagId`).                                      |
| `POST` | `/api/works/:id/collections`         | Create a collection (`PUT` / `DELETE` on `/:collectionId`).                        |

Every route is authenticated and scoped to the Work: it answers `401` without credentials and `403` for someone else's Work. The two routes that address an existing item by slug — update-item and remove-item — restrict `item_slug` to lowercase letters, digits, hyphens and underscores at the DTO boundary; submit-item takes the slug as a free string and normalises it server-side to that same character set, so the value stored is always one the other two routes can address. Every write records an entry in the Work's [activity feed](./activity.md).

## Related

- [Taxonomy System](./taxonomy-system.md) — how categories and tags are stored and merged
- [Collections](./collections.md) — curated groupings and the toggles that control them
- [Item Source Validation](./item-source-validation.md) — health verdicts, the scheduler and suggested sources
- [CSV & Excel Item Import / Export](./item-import-export.md) — the bulk path in and out
- [Comparisons](./comparisons.md) — item-vs-item pages generated from your items
- [Work Kinds & Capabilities](./work-kinds.md) — which kinds have an Items surface at all
- [What a Generated Site Includes](./generated-site.md) — the three repositories and how items reach the site
- [Work Changelog](./work-changelog.md) — what each generation run added, updated or removed
