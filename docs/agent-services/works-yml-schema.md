---
title: works.yml schema
description: The schema for .works/works.yml — the file that describes a Work to the Ever Works platform.
---

# `.works/works.yml`

Every Work's **Data Repository** may carry a `.works/works.yml`. It is how a
repository describes itself to the platform: what the Work is called, what
kind of Work it is, and any kind-specific configuration.

The file is **optional and always partial**. It overrides platform defaults;
it is never a complete description of a Work. That is why every field below
is optional — a `works.yml` containing only `name:` is valid.

## Editor support

The published JSON Schema drives completion and inline validation:

```yaml
# yaml-language-server: $schema=https://api.ever.works/api/schema/works.yml.schema.json
name: Awesome Chairs
kind: directory
```

The schema is generated from the same definition the server validates
against, so the two cannot drift. It is served publicly and cached for five
minutes:

```
GET https://api.ever.works/api/schema/works.yml.schema.json
```

## Envelope

```yaml
version: 2 # optional, advisory
kind: directory # optional, defaults to "default"
name: Awesome Chairs
initial_prompt: A curated directory of ergonomic office chairs
model: anthropic/claude-sonnet-4
website_repo: ever-works/awesome-chairs-website
schedule_cadence: weekly # hourly | daily | weekly | monthly
deploy_provider: vercel
activity_sync:
    mode: pull # pull | push | disabled
spec: {} # kind-specific, see below
```

| Field              | Type   | Notes                                                                      |
| ------------------ | ------ | -------------------------------------------------------------------------- |
| `version`          | int    | Advisory only. Absent means v1. See [Versioning](#versioning).             |
| `kind`             | string | `website`, `landing-page`, `blog`, `directory`, `awesome-repo`, `company`. |
| `name` / `title`   | string | Display name of the Work.                                                  |
| `initial_prompt`   | string | Seeds generation. Capped at 8000 characters.                               |
| `model`            | string | Preferred model id.                                                        |
| `website_repo`     | string | `owner/repo` of the Work Repository.                                       |
| `schedule_cadence` | enum   | How often scheduled generation runs.                                       |
| `deploy_provider`  | string | Deployment plugin id. `deployProvider` is accepted as an alias.            |
| `activity_sync`    | object | Activity Feed transport. See ADR-004.                                      |
| `spec`             | object | Kind-specific configuration.                                               |

## Versioning

`version` is **advisory and never gating**:

- **Absent** → treated as v1. Every file written before `spec` existed keeps
  working untouched.
- **Newer than the server understands** → a warning is recorded and the file
  is parsed anyway. Refusing to read a file written by a newer server would
  strand your own repository.

**Unknown keys are always preserved.** The platform round-trips this file
back into your repository, so any key it does not recognise — including one
written by a newer build, or by hand — survives a write. Nothing is silently
deleted.

Likewise, a `kind` the server does not recognise is preserved verbatim: its
`spec` is carried through untouched rather than validated or erased.

## Per-kind `spec`

`spec` holds the configuration that only some kinds of Work need. Its
accepted shape depends on `kind`.

### `website`

```yaml
kind: website
spec:
    kind: website
    template: web
    pages:
        - path: /pricing
          title: Pricing
          prompt: Three tiers, emphasise the free plan
    nav:
        header:
            - { label: Docs, href: /docs }
    branding: { logo: /logo.svg, theme: slate, locale: en }
    seo: { title: …, description: …, keywords: [...] }
    analytics: { provider: plausible }
```

### `landing-page`

```yaml
kind: landing-page
spec:
    kind: landing-page
    hero:
        headline: Ship your directory in an afternoon
        cta: { label: Join the waitlist, href: '#signup' }
    sections:
        - { type: features, title: Why us }
    capture: { enabled: true, destination: hello@example.com }
```

### `blog`

```yaml
kind: blog
spec:
    kind: blog
    content_dir: content/posts
    authors:
        - { name: Jane Doe, bio: Writes about agents }
    taxonomies: { categories: [engineering], tags: [ai] }
    feed: { enabled: true }
    pagination: { per_page: 10 }
    generation:
        cadence: weekly
        topics_prompt: Summarise notable AI agent releases
        posts_per_run: 3
```

### `directory`

```yaml
kind: directory
spec:
    kind: directory
    categories: [Ergonomic, Budget]
    item_fields:
        - { name: price, type: number }
    sources:
        - { url: https://example.com/chairs }
    submissions: { enabled: true, moderation: manual }
    comparisons: { enabled: true }
```

### `awesome-repo`

```yaml
kind: awesome-repo
spec:
    kind: awesome-repo
    source: { repo: sindresorhus/awesome, branch: main, file: readme.md }
    sync: { cadence: weekly }
    readme:
        header: '# Awesome Chairs'
        toc: true
        badges: [awesome]
    enrich: { enabled: true }
```

### `company`

```yaml
kind: company
spec:
    kind: company
    organization: acme
    company_manifest: .works/company.yml
    departments:
        - { name: Engineering }
    staffing:
        - { role: Tech writer, agent: docs-bot }
```

## Validation behaviour

Validation is **advisory at read time**. `.works/works.yml` lives in your
repository, so a schema complaint must never be able to take a Work offline:
the platform reads the fields it can, logs what did not match, and carries
on.

- A **known** `kind` has its `spec` validated strictly — a wrong type or an
  out-of-range enum is reported.
- An **unknown** `kind` is not validated, only preserved.
- A malformed root (not a YAML object) is the one hard error.

## See also

- [`works-config` feature docs](../features/works-config.md)
- [Repository management](./repository-management.md)
