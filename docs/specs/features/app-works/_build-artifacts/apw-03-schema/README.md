# APW-03 build artifact — the App spec JSON Schema, its validator mapping and its evidence

**Program:** App Works (`docs/specs/features/app-works/`) · **Epic:** APW-03 `app-spec-and-catalog`
**Gap closed:** APW-03 specified the App spec (the `spec` block of `.works/works.yml` when `kind: app`)
only in prose — [`schema.md`](../../APW-03-app-spec-and-catalog/schema.md)'s field tables and rules R1–R26,
plus [`CONTRACTS.md`](../../CONTRACTS.md) §1's annotated outline. There was **no JSON Schema artifact and no
validator**, which is why implementation could not start. This folder is that artifact.

**Nothing in the repository was modified to produce it.** This folder did not exist before; every other
path it reads (`schema.md`, `CONTRACTS.md`, the three APW-13 Blueprints, `packages/agent/**`) is read
only.

| File                                                           | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`app-spec.schema.json`](./app-spec.schema.json)               | The App spec as a JSON Schema **draft 2020-12** document, `$id` `https://api.ever.works/api/schema/app-spec.schema.json`, in the conventions of `packages/agent/src/works-config/schema/emit-json-schema.ts`. Root = the whole `.works/works.yml` for `kind: app`; `#/$defs/appSpec` = the spec block alone. Every object inside `spec` is strict (`additionalProperties: false`) with the `x-` exemption (`patternProperties: { "^x-": {} }`). |
| [`validator-rules.md`](./validator-rules.md)                   | Every rule in `schema.md` mapped to the JSON Schema construct that enforces it **or** to a named imperative check with its `APP_SPEC_ISSUE_CODES` code, severity and exact condition. Includes the C1/C2/C3 contract changes, the Ajv-keyword → issue-code table, the server-only rules, and what is deliberately _not_ in the schema.                                                                                                          |
| [`evidence/validate.mjs`](./evidence/validate.mjs)             | The runner. Layer 1 compiles `app-spec.schema.json` with the **repository's own** validator (`ajv` 8 → `Ajv2020`, `packages/agent/package.json:339`; options copied from `packages/agent-plugins/src/schema-validator.ts:53`) and parses YAML with `yaml` (`packages/agent/package.json:364`). Layer 2 is a small reference implementation of the rules JSON Schema cannot express, so each fixture can be attributed to a layer.               |
| [`evidence/fixtures/`](./evidence/fixtures)                    | 42 fixture entries over 41 files: the three real Blueprints (read from their repository paths, not copied), `git show HEAD:` snapshots of the same files, `CONTRACTS.md` §1 verbatim **and** materialised, 29 negatives and 4 positives.                                                                                                                                                                                                        |
| [`evidence/run-transcript.txt`](./evidence/run-transcript.txt) | The raw run: 42 fixtures, 42 expectations met, exit code 0. Every fixture's sha256 is in it.                                                                                                                                                                                                                                                                                                                                                    |
| [`gaps-and-contradictions.md`](./gaps-and-contradictions.md)   | Rules JSON Schema cannot express, places `schema.md` and `CONTRACTS.md` disagree, fields with no documented consumer, and every assumption stated as a question with a recommended answer.                                                                                                                                                                                                                                                      |

## Run it

```bash
cd docs/specs/features/app-works/_build-artifacts/apw-03-schema/evidence
node validate.mjs          # exit 0 iff all 42 fixtures match the expectation recorded for them
```

`exit 0` does **not** mean every fixture validates — 19 of the 42 entries are expected to fail the
schema and 14 more are expected to pass the schema and fail the rule layer. It means reality matches
what the registry claims about each one.

## The headline results

1. **All three real Blueprints are accepted** by the schema at their current worktree revisions.
2. **At `HEAD` (`e47866dc7`) cal-diy and umami are rejected** with `reserved_env_name` (R23 /
   CONTRACTS.md:27) — three reserved env names in cal-diy, two in umami. The worktree carries an
   uncommitted change that renamed them to `APP_*` and also replaced cal-diy's RE2-incompatible
   `validate.pattern`. `app-fixture-hello` is the control and passes in both revisions. See
   `evidence/fixtures/head-revision/SOURCE.txt`.
3. **12 of 42 fixtures pass the JSON Schema and fail the rule layer** — that list is the schema/rule
   boundary the program keeps asserting, enumerated rather than asserted.
4. **`CONTRACTS.md` §1's annotated outline is not a valid document** (its enums are prose and it
   carries placeholders), and materialising it exposes two undeclared env references. See
   `gaps-and-contradictions.md` G2.

## Where this goes next

`validator-rules.md` §9 lists the destination of each artifact: `app-spec.schema.json` becomes
`packages/agent/src/works-config/schema/app-spec.v1.schema.json` (emitted by a new
`emit-app-spec-json-schema.ts`, drift-guarded like `works.v2.schema.json`, served at
`GET /api/schema/app-spec.schema.json`, vendored into `ever-works/apps` as
`schema/app-spec.schema.json`), and R1–R26 become `app-spec.rules.ts` + `app-spec.issues.ts`.
