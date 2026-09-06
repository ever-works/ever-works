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

| Field              | Type   | Notes                                                                              |
| ------------------ | ------ | ---------------------------------------------------------------------------------- |
| `version`          | int    | Advisory only. Absent means v1. See [Versioning](#versioning).                     |
| `kind`             | string | `website`, `landing-page`, `blog`, `directory`, `awesome-repo`, `repo`, `company`. |
| `name` / `title`   | string | Display name of the Work.                                                          |
| `initial_prompt`   | string | Seeds generation. Capped at 8000 characters.                                       |
| `model`            | string | Preferred model id.                                                                |
| `website_repo`     | string | `owner/repo` of the Work Repository.                                               |
| `schedule_cadence` | enum   | How often scheduled generation runs.                                               |
| `deploy_provider`  | string | Deployment plugin id. `deployProvider` is accepted as an alias.                    |
| `activity_sync`    | object | Activity Feed transport. See ADR-004.                                              |
| `spec`             | object | Kind-specific configuration.                                                       |

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

### `repo`

A Repository Work wraps an existing code repository; the data repository is
that repository and nothing is generated. The spec describes how agents work
_in_ the repo rather than what to build.

```yaml
kind: repo
spec:
    kind: repo
    source: { repo: ever-works/ever-works, branch: develop }
    tasks:
        base_branch: develop
        setup: ['pnpm install --frozen-lockfile']
        checks:
            - pnpm lint
            - pnpm test
            - command: pnpm test
              mount: template
              name: Template suite
```

#### A declared command is a command your machine will run

Read that sentence literally before you turn this on. When a Work's agent
runs on your **fleet**, it runs on a PC you enrolled — your shell, your Git
credential helper, your model-CLI login, and, for the length of a run, any
`.env` files the platform delivered into the checkout. A command listed
here is executed there.

`.works/works.yml` lives inside the wrapped repository, so **anyone who can
land a commit or open a pull-request branch authors these strings** — a far
wider set than the Work's members. During a run the model itself has write
access to the checkout and can edit the file.

That is why nothing here runs by default, and why the gate is an
**allow-list** rather than a switch.

#### What a repository can declare

| Key            | Meaning                                                                           |
| -------------- | --------------------------------------------------------------------------------- |
| `tasks.setup`  | Dependency install / environment preparation. Runs **before** the model.          |
| `tasks.checks` | Acceptance checks. Run after the model; their exit codes are the gate.            |
| `command`      | The command itself, in either phase. Bare strings are the short form.             |
| `mount`        | Which repository of a multi-repo Task it runs in (`mountDir`); primary if absent. |
| `name`         | A label for run reports. Cosmetic; decides nothing.                               |

Bounds: at most 20 check commands and at most 8 setup steps, at most 500
characters each, no control characters. A ninth setup step is refused when the
run is planned, naming this file.

#### What a repository cannot declare

- **A command that is not on the Work's allow-list.** Matching is EXACT
  after whitespace is collapsed — not a prefix, not a glob, not a program
  name. Allowing `pnpm test` does **not** allow `pnpm test && curl … | sh`.
- **A check id.** Ids are generated from the declaration's position
  (`repo/check-1`, `repo/setup-2`) and carry a `/` that owner-authored ids
  cannot contain. Ids are the merge key between Work defaults and Task
  entries, so an id a repository could choose would let it replace or
  suppress a check the owner wrote.
- **`required: false`.** A repository that declares a check is asking for it
  to be enforced. There is no advisory form.
- **A `cwd`, a `timeoutSec`, an `envPassthrough` or an `envGrants`.** Extra
  keys in the file are ignored; the admitted command is rebuilt field by
  field. `mount:` covers the real need for "somewhere else", and it is a
  name resolved against the repositories the run provisioned rather than a
  path.
- **Anything, if the Work has not opted in.** Absent the opt-in, the file is
  never even fetched.

#### Turning it on

On the Work, set `repoDeclaredCommands`:

```json
{
	"mode": "allowlist",
	"allow": ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm test"]
}
```

`mode: "off"` (the default, and what every Work starts as) means the file is
not consulted for commands at all. There is deliberately no "run whatever
the repository says" mode.

Setting the Work's `checksPolicy` to `off` also stops all of this: the file is
not read and no declared command of either phase runs. The two switches are
linked deliberately, because `checksPolicy: off` is what an owner reaches for
when they want something to stop running.

#### What the allow-list does NOT bound

Read this before turning the feature on. The list freezes the command
**string**. It cannot freeze what that string **does**, because the behaviour
lives in files the repository controls and reads at execution time:

- **Lifecycle scripts.** `pnpm install --frozen-lockfile` still executes
  `preinstall` / `install` / `postinstall` / `prepare` from the repository's
  own `package.json`. Somebody who can land a commit adds a `postinstall`, and
  the allow-listed install runs it — first thing in the run, before the model.
  Add `--ignore-scripts` if that is not what you meant.
- **A committed `.npmrc`.** npm and pnpm expand `${VAR}` from the process
  environment, so a repository-committed `//host/:_authToken=${NPM_TOKEN}` can
  post a token to whoever wrote the file. This is why a repository-declared
  command **never receives the run's environment grants**. If your install
  genuinely needs a private-registry token, declare it as one of the **Work's
  own** setup steps, where you author both the command and the grant.
- **The script behind the command.** `pnpm test` runs whatever `package.json`
  says `test` is _at the moment it runs_, and the model has write access to the
  checkout for the whole run. Freezing the declaration set at dispatch stops
  the **set** from widening mid-run; it does not stop a listed command's target
  from changing.

What this feature actually gives a repository is the ability to say _which_ of
the owner's approved commands to run, in which repository, in which phase. It
does not make the repository's contents safe to execute — which is why the
mode is off by default.

#### How it is frozen, and what happens when it is wrong

The declarations are read **once, when the run is planned**, over the Git
provider API, at the workspace's **base ref** — the branch the Task worktree
is cut from. The admitted commands are then sealed into the immutable job
payload. The node that executes the run never opens `.works/works.yml`, so a
model that rewrites the file mid-run cannot widen what runs in the run it is
in. (The next run reads the new file, and the allow-list still applies.)

Every failure **refuses the run** rather than quietly grading nothing — a
malformed `spec.tasks`, a file that will not parse, a provider error, a
command the allow-list does not carry, or a `mount:` naming a repository the
Task does not mount. The reason lands on the run row where you can read it.
Reporting a green run that verified less than the repository asked for would
be worse than failing.

#### The setup phase is reported apart from the checks

`tasks.setup` exists because a node-provisioned Task worktree is a bare
`git worktree`: no `node_modules`, no `.venv`, no build cache. Without an
install, every check failed on its first line and the run reported a red
gate — which reads as "the change broke the tests" when it means "nobody
installed the dependencies".

So setup has its own budget (30 min default, 90 min ceiling, an 8 KiB log
tail rather than 4 KiB) and its own result block. A failed setup step is
reported as `setupStatus: red` with `gateStatus: none` — the gate did not
fail, it never ran — and the model, the steps, the checks and the push are
all skipped.

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
