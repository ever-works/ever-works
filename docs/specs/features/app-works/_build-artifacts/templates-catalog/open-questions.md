# Open questions — templates, shapes and provisioning

**Status:** draft build artifact, 2026-09-17. **Read-only work** — nothing existing was modified. Each item is
something the material genuinely does not decide; each carries a **recommended default** that is safe to
implement without waiting, plus what changes if the owner decides the other way.

Format: **question** · what is undecidable · **recommended default** · impact/blast radius.

---

## OQ-01 · Does the noun change with the repository?

The repository becomes `ever-works/templates`, but "Apps catalog" is used **84 times** in the plan, including
user-facing copy ("Browse the Apps catalog", `APW-01/spec.md:400`, `:465`; the catalog-browser tab
`spec.md:507`), and the plan's FR ids (`FR-27`…`FR-38`) are written around it. Renaming the noun touches all of
them plus the web i18n keys.

**Recommended default:** rename the **repository** only. Keep "Apps catalog" as the noun for the curated index
of App Blueprints (now the `kind: app` rows of `ever-works/templates:manifest.json`), and add one vocabulary
row for the repository itself ("Templates listing"). Rationale: users browse _apps_; the repository holds the
whole template family, which is a fact about our housekeeping, not about the product.

**If the owner prefers the full rename:** the change is mechanical but wide — `README.md` §1, every
"Apps catalog" occurrence, the catalog-browser tab copy, and the i18n keys in
`apps/web/messages/en.json`. It should be one PR with no other change in it.

---

## OQ-02 · Is the listing a gate, or curation?

The owner's model says the listing is "mostly for us to keep track" and that discovery is by suffix. The plan's
D4 makes the **manifest the first resolution step** (`README.md:135-137`), and the platform needs a **pin**
(`sha`) and a licence class it cannot get from a repository listing alone. Those two statements pull in
opposite directions for an unlisted but valid `-template` repository.

**Recommended default:** the listing is **curation and an accelerator, never a gate**:

1. an explicit `blueprintId` wins;
2. a **listing match** wins when it exists (it carries the pin, licence class, protected paths and
   verification) — this preserves D4 step 1 and the whole verification feature;
3. otherwise the **suffix scan** finds an unlisted but usable template and applies it at the head commit
   resolved now, labelled **Unlisted Blueprint** (never verified, never managed-hosting eligible) — this is
   APW-03's existing FR-43 behaviour, widened from two guessed names to the whole organization;
4. otherwise the App Provisioner.

So a new template works without a listing PR, and a listing row is still what makes it _listed_, pinned and
badgeable. This is exactly the shape of `APW-03/spec.md:287-303` today, with the manifest replaced as the
_only_ discovery path.

**Impact:** the "listing row is the only way in" reading would mean every new template needs a catalogue PR to
be usable at all, which contradicts the owner's sentence. The recommended reading keeps both features.

---

## OQ-03 · Rename `EVER_WORKS_APPS_CATALOG_REPO`?

The variable's default becomes `ever-works/templates`, but its name still says "apps".

**Recommended default:** change the **default only**; keep the variable name. It is read in every environment
(dev/stage/prod) and in the acceptance lanes; renaming it means a config change in each, for a cosmetic gain.
If a rename is wanted later, add `EVER_WORKS_TEMPLATES_CATALOG_REPO` as an **additive alias** read first, and
keep the old name working (no-removal rule).

**Impact if renamed now:** APW-03 `plan.md:209`, `CONTRACTS.md:401`, ACCEPTANCE §0.3 (`ACCEPTANCE.md:92`),
and every environment's configuration.

---

## OQ-04 · Fork order when the member already has one of the two forks

FR-19 says an existing fork is adopted instead of requested, per repository. For a `metadata-only` template
that leaves four combinations, and the plan does not say what happens when the member already has the
**template** fork but not the app source (or the reverse: they forked `umami-software/umami` by hand last
year).

**Recommended default:** readiness is gated by the **Work Repository** fork only (the app source), so:

| Already exists  | Behaviour                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Neither         | fork the app source, then the template (FR-18c)                                                                      |
| App source only | adopt it, then fork the template                                                                                     |
| Template only   | adopt it, then fork the app source — the app source still gates `ready`                                              |
| Both            | adopt both; `createdByThisWork = false` for each, so the first write is a **setup pull request** (R-4), never a push |

The interesting case is the last one: a member who already forked both repositories by hand gets a pull request
rather than a direct commit, because the platform did not create either default branch. That is consistent with
R-4 and with APW-01's existing `createdByThisWork` semantics, and it needs one sentence in APW-01's create
flow — nothing else.

---

## OQ-05 · Which copy does "Created from … Template Repo" link to?

The owner asked for **"Created from [public/private icon] Template Repo"** with "the template repository as a
URL rendered like the Work's other repositories". After provisioning there are two candidates: the catalog
repository `ever-works/<app>-template` (public, not the member's) and the member's own fork of it
(`<member>/<slug>-template`, or nothing if the fork failed or was never made).

**Recommended default:** link to **the member's own copy when one exists**, otherwise the catalog repository;
name the other one in the row's ⓘ body; take the public/private icon from the **linked** repository. Rationale:
every other row in that block links to a repository the member owns and can modify, and the user's question is
"where did this come from and can I change it" — the fork answers both. The persisted `forkedRepo` (or its
absence) is what makes the choice deterministic without a GitHub round-trip.

**Note:** this is also what makes the private icon meaningful — a `-template` repository in the catalog is
public by rule (APW-03 `catalog.md` §5), so a **private** template can only be a custom template the member
owns (see OQ-08).

---

## OQ-06 · `.works/template.yml` as a separate file, or inside `.works/works.yml`?

`blueprint` mode **forbids** `source` and `blueprint` in the App spec (`schema.md:80`,
`blueprint_mode_forbidden_key`), because in a Work's spec those keys describe the _applied_ relation. The
template's own shape and app-source coordinates therefore need somewhere to live. Options: (a) a new
`.works/template.yml`; (b) allow a restricted `source` block in `blueprint` mode and rewrite/remove it during
apply.

**Recommended default:** (a). It keeps the App spec's meaning identical in both modes, means nothing new has to
be stripped or rewritten during apply, and gives the resolver one small file to read before it decides anything.
The cost is one more file in a template repository. Documented in `resolution-spec.md` §2.1.

**If (b) is preferred:** `schema.md` §3's blueprint-mode row, the validator's forbidden-key rule, and the apply
job's composition step (`APW-03/plan.md:269-271`) all change together — a bigger, riskier change for a smaller
file count.

---

## OQ-07 · Do the four existing website templates need `.works/template.yml`?

They are code-bearing in practice (the template repository holds the code; the fork is the Work Repository), but
they carry no `.works/` at all (verified 2026-09-17: `GET /repos/ever-works/<name>/contents/.works` → 404 for all
four).

**Recommended default:** no change now. The fall-back discriminator ("no app metadata ⇒ website template",
`resolution-spec.md` §2.2) classifies them correctly, and nothing about their behaviour changes. Add
`.works/template.yml` to them only if a website template ever needs to declare an app-source relationship or a
product feature needs to read a shape for website templates too.

---

## OQ-08 · May a template repository be private?

`catalog.md` §5 requires Blueprint repositories to be **public**, and the platform's fork source must be inside
the catalog organization (`SAFE_REPO_RE`). But the provenance line's "[public/private icon]" implies a private
case exists, and the pre-existing Work Templates feature already lets a member register **any** GitHub URL as a
custom template (`POST /api/templates/custom`, `EXISTING-SUBSTRATE.md:58`).

**Recommended default:** keep the **catalog** public-only (a private repository cannot be verified, badged or
managed-hosted), and treat `visibility: 'private'` in the provenance block as "a template the member owns
outside the catalog" — i.e. the existing custom-template path. The listing never carries a private row; the
provenance icon still works because it reads the provenance block, not the listing.

---

## OQ-09 · An existing catalogue drift the listing surfaces (not ours to fix here)

`ever-works/works:manifest.json` points two blueprint slugs at the same repository: `directory` →
`ever-works/directory-web-template`, and `marketing-site` → `ever-works/ever-works-website-template`. Verified
2026-09-17: both names resolve to **repo id 912916449** (`GET /repos/ever-works/ever-works-website-template`
returns `full_name: ever-works/directory-web-template`), i.e. the marketing-site name is a rename target. So
the "Marketing Website" blueprint currently forks the directory boilerplate.

**Recommended default:** decide in `ever-works/works`, not in this plan — either repoint `marketing-site` at
`ever-works/web-template` (the general-purpose Next.js template that exists, `web-template`, untouched since
2026-07-19) or drop the entry. The listing records the fact in `directory-web`'s `notes` either way, and its CI
check "`template.repo` unique across rows" would fail if we copied the works manifest's mistake.

**Owner:** the `ever-works/works` maintainers (the repository is a runtime catalog, ADR-014 — a change there is
a content PR, not a platform release).

---

## OQ-10 · Should website templates be pinned to a sha as well?

App rows must pin (`template.sha`, 40-hex) because the platform applies a commit, never a branch. The four
website rows currently fork from a branch (`develop`/`main`), which is the existing behaviour
(`ever-works/works:manifest.json` uses `"sha": null` with `"ref": "develop"`).

**Recommended default:** keep the asymmetry, and let the schema express it (it already does: the sha
requirement is conditional on `kind: app` + non-placeholder status). Pinning website templates would change
what every existing Work forks from and would require a tag-and-release habit the four repositories do not have
(verified 2026-09-17: **no git tags** on any of them).

---

## OQ-11 · A `code-bearing` template is a maintained fork — our own fleet rules must know

`E:\Coding\_LOCAL\AGENTS.md` (the operator workspace, not this repo) says forks are never touched: "Never touch
UPSTREAM / FORKED repos without explicit per-repo owner permission … Editing a fork diverges it from upstream."
A `code-bearing` template repository is **by design** a fork we maintain, and its whole point is that we commit
our metadata to it and merge upstream into it. A fleet-wide sweep that skips forks would silently skip exactly
these repositories, and a rule that forbids editing them would forbid the pin refresh.

**Recommended default:** when the first `code-bearing` template is created, add it to that document's named
exception list (`AGENTS.md` already carries one such exception, `ever-co/awesome-selfhosted-data`) with the
reason "maintained template fork — metadata on top, upstream sync by merge". Nothing in _this_ plan changes; the
note exists so the repository is not orphaned by our own guardrail.

**Impact:** operational only, but it decides whether the pin-refresh job (APW-03 `catalog.md` §5 K3/C15) can run
at all in this environment.

---

## OQ-12 · A name conflict on `<slug>-app`

FR-24/FR-25 define adoption and conflict for the data repository; FR-20 adds `-copy`…`-copy-5` for **Private
copy**. Neither says what happens when `<member>/<slug>-app` already exists.

**Recommended default:** adopt it **only** when it is a fork of the same template repository (same fork
network root); otherwise fail creation with the existing conflict code and let the member pick another
organization or a different slug. Never auto-generate `<slug>-app-2`: the Work Repository name is what the
member sees in Work Information and in every URL, and a numeric suffix breaks the slug↔repository symmetry the
UI relies on. `-copy` variants stay Private-copy-only.

---

## OQ-13 · Does the two-fork model ever apply to a Website/Work Template?

Website templates fork once today and the fork is the Work Repository (`-website`). Nothing in the owner's model
asks for a second repository for them.

**Recommended default:** no. A Website Template is `code-bearing` by nature — the template repository holds the
site code — so the two-fork path is only reachable through an app template with `shape: metadata-only`. State it
once in `resolution-spec.md` §1.2 (the `kind: 'website'` output) so nobody builds a second fork for website
Works.

---

## OQ-14 · Where does the template fork's _sync_ live?

For `code-bearing`, the _template_ repository syncs with upstream on our side (a maintainer merges upstream into
it). For `metadata-only`, the _member's_ app-source fork syncs with upstream exactly like any App Work
(APW-02). The member's **template** fork, however, has no sync story: it is metadata that we improve over time.

**Recommended default:** the template fork is refreshed by the **Blueprint upgrade path that already exists**
(`app.blueprint.upgrade_available` → an ordinary pull request with the new spec/overlay, APW-03 FR-49), applied
to the member's app-source fork — the template fork is a convenience copy and is **not** kept in sync. If the
owner wants it kept current, that is a new APW-02 sync target (`ever-works/<app>-template` → the member's copy)
and should be its own decision, because it spends the member's Actions minutes on a metadata-only repository.
