# Ever platforms — the App Launcher catalog

The list of Ever platforms the **App Launcher** shows, read at runtime by Ever Works
([APW-11](../spec.md) FR-8…FR-14). The product contains the code that reads this catalog; it never contains
the list.

This directory is a **draft** of the repository's first commit content, kept beside the spec that defines it
([`../plan.md`](../plan.md) §5.1–§5.2). The repository itself, **`ever-works/platforms`**, was created
2026-09-17 and is the repository `EVER_WORKS_PLATFORM_CATALOG_REPO` defaults to. Landing these files there is
[`../tasks.md`](../tasks.md) **T18** — an owner action, because the per-environment addresses are supplied by
the owner and live only in that repository, never in the public spec tree.

## Layout

| Path                                                                   | What it is                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`platforms.json`](./platforms.json)                                   | The index. Addresses are placeholders until the owner supplies the real ones.                                                                                                      |
| [`schema/platforms.schema.json`](./schema/platforms.schema.json)       | JSON Schema (2020-12) mirroring the reader's zod rules one for one.                                                                                                                |
| [`tools/validate.mjs`](./tools/validate.mjs)                           | The checks JSON Schema cannot express: unique ids, the 16 KB icon cap, https-only, SVG deny patterns, ≤ 24 entries.                                                                |
| [`.github/workflows/validate.yml`](./.github/workflows/validate.yml)   | Runs both on every pull request, on `main`, and on every `v*` tag.                                                                                                                 |
| [`fixtures/platforms.fixture.json`](./fixtures/platforms.fixture.json) | Test cases for the reader's spec (APW-11 T8): the valid entry, the 25th entry, `javascript:`/`http:`, an oversize icon, an SVG with `<script`, an entry with no `develop` address. |
| `icons/<id>.svg\|png`                                                  | One icon per platform, ≤ 16 KB, referenced by path from `platforms.json`.                                                                                                          |

## The rules, and why each one exists

- **`https` only.** An address that is not `https` is dropped and counted; the launcher never opens `http`,
  `javascript:` or a `data:` URL (spec FR-32, S16, ACC-11-08).
- **At most 24 entries.** The reader drops the 25th, so CI refuses it instead of letting a platform vanish
  silently (FR-11, ACC-11-08).
- **Unique ids.** A person's pins are stored as `platform:<id>`, so a duplicate id merges two platforms into
  one preference row (plan §3.2, §4.2).
- **One address per environment, each optional.** Ever Works shows the address for the environment it is
  itself running in; an entry without one is simply absent there — the launcher never sends a person from one
  environment to another (FR-10, ACC-11-05).
- **Icons are images, never markup.** An icon is inlined as a data URI and rendered as `<img>`; an SVG
  carrying `<script`, an `on…=` handler, `javascript:` or `<foreignObject` is refused (FR-14).
- **A bad icon never removes a platform.** An oversize or unsafe icon leaves the entry in place without an
  icon (plan §9.2).
- **Stable ids.** Renaming an id loses every pin and every stored arrangement on that platform. Add a new
  entry; do not rename an existing one.

## Adding a platform

1. Add an entry to [`platforms.json`](./platforms.json) with a new stable `id`, a name (≤ 40 characters), a
   one-line description (≤ 80), an `order`, a `status` of `available` or `beta`, and at least one `https`
   address.
2. Add `icons/<id>.svg` or `icons/<id>.png`, at most 16 KB.
3. Run `node tools/validate.mjs` (and the schema check from the workflow) locally.
4. Open a pull request. `validate.yml` runs both checks; a red run names the rule it broke.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the review rules, and
[`../spec.md`](../spec.md) §4.2 for the behaviour this data drives.

## Licence

MIT — see [`LICENSE`](./LICENSE).
