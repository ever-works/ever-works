---
id: work-templates
title: 'Work Templates'
sidebar_label: 'Work Templates'
---

# Work Templates

A **Work Template** is a pre-baked starter for a new [Work](./creating-a-work.md):
a pointer to a real GitHub boilerplate repository you can fork into your
own Work. Work Templates power the **"Work Templates"** tab on the
Templates page, alongside [Website Templates](./website-templates.md) and
[Mission Templates](./mission-templates.md).

This page covers the Work Template **catalog kind**, the **built-in
starters**, and how a Work Template is **used**. For the full REST surface
(list / add / fork / customize), see the
[Template Catalog API](/api/template-catalog).

**Key sources:**

- `packages/agent/src/works/work-template.config.ts` — the built-in Work Template catalog
- `packages/agent/src/template-catalog/template-catalog.service.ts` — seeding + fork flow
- `apps/api/src/template-catalog/template-catalog.controller.ts` — `/api/templates*` endpoints

## Template kinds

The catalog is a single system that serves several **kinds**, filtered so
each surface shows only its own. The `TemplateKind` union is
`'website' | 'work' | 'mission' | 'company'`, and the catalog reader
filters by kind so the tabs never cross-pollute:

| Kind      | Tab                | Backing config                        |
| --------- | ------------------ | ------------------------------------- |
| `website` | Website Templates  | `website-template.config.ts`          |
| `work`    | **Work Templates** | `work-template.config.ts`             |
| `mission` | Mission Templates  | `mission-template.config.ts`          |
| `company` | _(no seed in v1)_  | the `+ New` Company chip → [register-company](../advanced/teams-and-organizations.md#the-register-company-flow) |

A Work Template config mirrors the website/mission shape (owner / repo /
branch + id / name / description) so the seed path treats every kind
uniformly. Unlike the website kind — which _infers_ its framework label
from the repo name — a Work Template states its `framework` **explicitly**
in config, so e.g. an Astro starter is never mislabelled by a repo-name
heuristic.

## Built-in starters

`listWorkTemplates()` returns the two built-in Work Templates that
`TemplateCatalogService` seeds on boot as `kind: 'work'` catalog rows
(verified in `work-template.config.ts`):

| Id                          | Name                          | Repo (`ever-works/…`)             | Framework |
| --------------------------- | ----------------------------- | --------------------------------- | --------- |
| `starter-directory`         | Starter Directory             | `directory-web-template`          | Next.js   |
| `starter-directory-minimal` | Starter Directory (Minimal)   | `directory-web-minimal-template`  | Astro     |

- **Starter Directory** — a Next.js directory boilerplate; a
  batteries-included starting point for a new directory Work.
- **Starter Directory (Minimal)** — a minimal Astro directory boilerplate;
  a lightweight, content-first starting point.

Seeding is idempotent (upsert), and the service deactivates any older
built-in row that points at the same `(owner, repo)` under a different id,
so a curated entry never renders as a duplicate card.

## Using a Work Template

The Templates catalog is a gallery in the dashboard's **Templates**
section. For a built-in Work Template, the **Fork** action
(`TemplateCatalogService.forkTemplateForUser`) forks the boilerplate
repository into a GitHub account or organization you select, then:

1. Creates a `custom` template row that points at your new fork (recording
   `forkedFromTemplateId` so the UI can re-run a customization later).
2. Sets that fork as your **default** template for the `work` kind.

The forked repository is now yours to launch a Work from. You can also add
your own Work Template by repository URL via **Add Custom Template**
(`POST /api/templates/custom` with `kind: 'work'`), the same flow used for
website and mission templates.

:::note Only standard templates can be forked
Forking is restricted to `built_in` templates — a custom template is
already your own repo, so it doesn't need forking again
(`forkTemplateForUser` rejects non-built-in sources).
:::

## Related pages

- [Creating a Work](./creating-a-work.md) — the Work concept.
- [Website Templates](./website-templates.md) and
  [Mission Templates](./mission-templates.md) — the sibling kinds.
- [Template Catalog API](/api/template-catalog) — list / add / fork /
  customize endpoints.
