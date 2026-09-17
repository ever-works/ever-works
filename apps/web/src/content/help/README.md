# The in-product manual

The Help drawer's **Manual** tab, `/help` and `/help/<article>` render the manual that ships with
the running build. The manual is not a second copy of our documentation: every article **is** a
page of the documentation site under `docs/`. This folder only decides which pages are articles and
how the product finds them.

## How it fits together

| Piece                                    | What it is                                                                                                                                    | Committed |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `docs/**.md`                             | The article text. Edit it there, as you would for the documentation site.                                                                     | yes       |
| `manual.json` (this folder)              | Which pages are articles, and the metadata the product needs about each one.                                                                  | yes       |
| `scripts/build-help-catalog.mjs`         | The generator.                                                                                                                                | yes       |
| `src/lib/help/help-catalog.generated.ts` | Metadata for every article — ids, sections, titles, headings. Help links are type-checked against it.                                         | yes       |
| `public/help-content/<id>.json`          | Each article body in the manual's structured grammar, written by the generator on every `build` and `dev` start and served by the deployment. | no        |

After changing `manual.json` or any page it lists, run:

```bash
pnpm --filter ever-works-web help:build
```

`src/lib/help/help-catalog.unit.spec.ts` fails in CI when the committed catalog no longer matches the
documentation, and `pnpm --filter ever-works-web help:check` answers the same question locally.

## Adding an article

Add one entry to `manual.json`:

| Field        | Rule                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`     | Path of a Markdown page under `docs/`. The article id is the page's front-matter `id` (or its file name) — 3–64 lowercase letters, digits and hyphens, never reused. |
| `section`    | Exactly one of `start-here`, `running-the-loop`, `your-agents`, `setup-and-connections`, `money-and-limits`, `when-something-goes-wrong`.                            |
| `order`      | Integer position inside the section.                                                                                                                                 |
| `summary`    | One plain-language line, at most 200 characters.                                                                                                                     |
| `keywords`   | At most 12, each at most 32 characters. Words people type, not words the page already leads with.                                                                    |
| `documents`  | **Keys of `ROUTES`** in `src/lib/constants.ts` for the screens the article explains — never literal paths. At most 8. `DASHBOARD_NOTIFICATIONS` is dead and refused. |
| `related`    | At most 5 other article ids from this manual.                                                                                                                        |
| `reviewedAt` | `YYYY-MM-DD` — the day someone last checked the page against the product.                                                                                            |

The page's title (at most 70 characters) and its `sidebar_label` come from its front matter. An
article may only document a screen that exists in the same change or an earlier one.

## What a page may contain

The generator turns a page into a closed set of blocks: paragraphs, headings (`##` and `###` become
link targets), ordered and unordered lists, callouts (`:::note`, `:::tip`, `:::info`,
`:::caution`, `:::warning`, `:::danger`, and `>` quotes), tables, code blocks, and inline
**bold**, _emphasis_, `code` and links. Nothing is ever emitted as raw markup.

Anything else — raw HTML, JSX, images — is shown in a reduced form and reported as a warning, and
the catalog spec fails until the page is changed, so the manual never silently shows less than the
documentation site.

Links inside a page:

- a link to another page of `docs/` that is an article opens that article in place;
- a link to any other page of `docs/` opens the published documentation site in a new tab;
- `[label](https://…)` opens in a new tab, marked as leaving the product; `http:`, `mailto:`,
  `javascript:`, `data:` and addresses with credentials render as plain text;
- `[label](help:<article>#<heading>)` and `[label](route:<ROUTES key>)` are also understood, for
  pages written with the product in mind.

Do not restate a plugin count or a plugin list in a page — link to
`docs/plugin-system/built-in-plugins.md`, the single source for that list.

## Pointing a screen at the manual

A screen never hard-codes a URL, a title or a section. It renders a help link:

```tsx
<HelpLink target="missions#creating-a-mission" variant="emptyState" />
```

`target` is checked by `tsc` against the generated catalog, so a link to an article or heading this
build does not have fails the type check. At runtime an unresolvable target renders nothing.

Help links use exactly two phrases: **"How this works"** (`variant="emptyState"`) on an empty state
and **"Why am I seeing this?"** (`variant="error"`) on an error, warning or degraded state. A help
link is always secondary — never the primary action of the surface it sits on.
