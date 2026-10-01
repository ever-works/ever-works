# App spec — gaps, contradictions and assumptions

**Artifact:** `docs/specs/features/app-works/_build-artifacts/apw-03-schema/gaps-and-contradictions.md`
**Companion:** [`app-spec.schema.json`](./app-spec.schema.json), [`validator-rules.md`](./validator-rules.md),
[`evidence/run-transcript.txt`](./evidence/run-transcript.txt)
**Method:** every claim below is either (a) a citation into the repository, or (b) a result printed in the
transcript. Where a finding was already recorded by a sibling artifact, it is **cross-referenced, not
re-derived**. Every open point is written as a question with the answer I recommend, so a reviewer can
accept or reject it in one line.

**Revision warning.** Other agents were editing this worktree _while this artifact was built_
(`schema.md` gained its `requireHumanMergePaths` row at 20:11, and cal-diy/umami were repaired at 20:09
and 20:17). The transcript pins every fixture by sha256, and `evidence/fixtures/head-revision/` holds
`git show HEAD:…` snapshots, so the findings stay checkable against `HEAD = e47866dc7`.

**Cross-references to sibling artifacts** (do not duplicate when consolidating):

| Already recorded as | Where                                                                                  | What it covers                                                                              |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **X-1**             | [`../expected-outputs/contradictions.md:230`](../expected-outputs/contradictions.md)   | `EVER_WORKS_*` env names: R23 vs the flagship Blueprint; fixed in the working tree          |
| **X-2**             | [`../expected-outputs/contradictions.md:259`](../expected-outputs/contradictions.md)   | `schema.md` has no `## 10.` heading                                                         |
| **OQ-06**           | [`../templates-catalog/open-questions.md:111`](../templates-catalog/open-questions.md) | where a Blueprint's own shape lives, given that blueprint mode forbids `source`/`blueprint` |

---

## A. Contradictions between the documents

### G1 — Blueprint mode forbids exactly what every Blueprint declares

- `schema.md` §3 (line 80): in `blueprint` mode "`source` and `blueprint` are **forbidden**
  (`blueprint_mode_forbidden_key`)".
- `catalog.md` C4 (line 311): the catalog's CI requires the Blueprint's `.works/works.yml` at `sha` to
  "validate in `blueprint` mode against `schema/app-spec.schema.json` **and** the platform's rules …
  **Zero errors**."
- All three APW-13 Blueprints declare `spec.source` **and** `spec.blueprint`
  (`blueprints/cal-diy/.works/works.yml:22-31`, `umami:19-28`, `app-fixture-hello:16-25`), and cal-diy's
  own comment calls them "the Blueprint's defaults; creation replaces `relation` with what the user
  chose".
- **Evidence:** the `blueprint-mode/cal-diy (mode: blueprint)` fixture in the transcript reports
  `blueprint_mode_forbidden_key` twice on top of the R23 findings. Under the literal rule, no APW-13
  Blueprint can ever pass C4.
- Related: OQ-06 in the sibling catalog artifact proposes a separate `.works/template.yml` so the App
  spec's meaning is identical in both modes. That resolves _where a template's own coordinates live_,
  but it does **not** resolve this contradiction, because the three Blueprints already carry `source`
  and `blueprint` and C4 validates them as they are.
- **Recommended answer:** make the rule match the artifacts, not the other way round. `source` in
  blueprint mode is a **default offered at creation**, and `blueprint` is the Blueprint's own identity
  (it is what `blueprint.sha` pins). Amend §3 to forbid only keys that cannot be defaults, and change
  `blueprint_mode_forbidden_key` to cover `license.class`/`license.source` (which must be recomputed,
  not declared) or drop the code entirely. If the owner prefers the literal rule, then **APW-13's three
  Blueprints must be edited in the same PR** — which is a change to artifacts this build was told not to
  touch, so it is an owner decision, not an implementation detail.

### G2 — `CONTRACTS.md` §1's outline is not a valid App spec, and is not self-consistent either

Extracted verbatim to `evidence/fixtures/contracts-1-annotated.works.yml`, it fails the schema at 12
documented paths (the transcript lists every one): enums written as prose (`fork | private-copy | link`,
`green | amber | red | unknown`, `detected | blueprint | user`, `dockerfile | image | auto | none`,
`runtime | build | both`, `web | worker`, `pre-deploy | first-deploy | post-deploy`) and placeholders
(`<40-char commit>`, `<ENV NAME>`, `sha256:...`). CONTRACTS.md C2 already concedes one of these (the
`generate`/`validate` pair).

Materialising the outline (substitutions listed in
`evidence/fixtures/contracts-1-materialised.works.yml`) exposes two further defects the prose hides:

1. `build.args[1]` is `{ name: CALENDSO_ENCRYPTION_KEY, fromEnv: CALENDSO_ENCRYPTION_KEY }`, but the
   outline's own `env:` list never declares `CALENDSO_ENCRYPTION_KEY` → `reference_unresolved`.
2. `cron[0].http.authEnv: CRON_API_KEY` names an entry the outline never declares → `reference_unresolved`
   (and, independently, `auth_env_not_secret`, because R15 requires a `secret: true` entry).

- **Evidence:** `contracts-1/materialised` → schema PASS, rules FAIL with exactly
  `reference_unresolved` + `auth_env_not_secret`.
- **Recommended answer:** treat the block as an **outline** (it is introduced as "the outline below fixes
  field names and meaning", CONTRACTS.md:76-78) and (a) mark each enum alternative in a trailing comment
  instead of the value, (b) add the two missing env entries, (c) keep the two "Substitutions" fixtures in
  this artifact as the runnable counterpart. Do **not** "fix" the outline by copying the materialised
  file back — the outline's job is to name fields, and the reviewer needs to see which values were
  placeholders.

### G3 — `components[].target` needs a per-component build, which APW-05 declares out of scope

- `schema.md` §10 (line 187): `components[].target` — "Dockerfile stage override for this component".
- APW-05 `spec.md` §7 (lines 548-549): "**Out of scope** … **build matrices** (one App spec, one image;
  the checks of FR-65 run as several jobs, but they build nothing)".
- If one App spec yields exactly one image, a per-component Dockerfile stage can only be honoured by
  building one image per distinct `target` — the matrix APW-05 excludes. Otherwise the field is silently
  ignored, which is the failure mode the envelope exists to prevent.
- **Evidence:** the three real Blueprints never set `components[].target` (cal-diy sets the spec-level
  `build.target: runner` only), so nothing breaks today — but the schema accepts a field whose only
  consumer is out of scope.
- **Recommended answer:** either (a) delete `components[].target` from §10 and the schema, or (b) state
  in §10 that it selects a _stage within the one image_ and is only meaningful when the image contains
  every stage the components need (which is what cal-diy's single-stage `runner` target does). I
  recommend (b) with one added sentence, because it keeps the field honest without a build matrix. If
  (a) is chosen, remove it from `app-spec.schema.json` too — it is currently at
  `#/$defs/component/properties/target`.

### G4 — `license.sourceOfferUrl` has no rule that makes it required

`schema.md` §7 documents the field; CONTRACTS.md C2 says it "is added"; APW-03 `plan.md` §5 (FR-61,
lines 342-345) and APW-06 `tasks.md:426-431` define when the _source offer_ is due, and ACC-03-36 makes a
private-copy AGPL App Work without the URL fail with **`sourceOfferMissing`**. But `sourceOfferMissing` is
**not in the `schema.md` §22 rule table and not in the §23 code lists**, so the validator's issue-code
inventory has no home for it, and until this artifact there was no schema field for it either.

- **Recommended answer:** add it to §22 as a new rule (R27) with severity **error**, condition: the
  license class carries the `network-source-offer` obligation **and** the Work Repository is private
  **and** `license.sourceOfferUrl` is absent — the code already exists in the acceptance suite, so the
  rule table is the piece that is missing. `sourceOfferUrl` itself is schema-carried (`https://`,
  ≤ 500) and needs no further schema work.

### G5 — `blueprint.sha` cannot tell a real commit from the release placeholder

All three Blueprints carry `sha: '0000000000000000000000000000000000000000'` with a
`TODO(release): stamped by the Blueprint release workflow`. That string satisfies `^[0-9a-f]{40}$`, so
the schema (and any editor) accepts a Blueprint whose `blueprint.sha` points at nothing. Catalog CI C3
("the tag `v<version>` resolves to `sha`", `catalog.md:310`) catches it — but only for catalog entries,
and only in that repository.

- **Recommended answer:** add a rule (severity **warning**, never error — the placeholder is deliberate
  during authoring) with code `blueprint_sha_placeholder` for an all-zero `sha`. Keep it out of the
  schema for the same reason as R19/R20: a warning must not become an `additionalProperties`-style
  failure in an editor. This is also why the three real Blueprints still pass this artifact's evidence
  run.

### G6 — three different "how long may this run" ceilings

`build.resources.timeoutMinutes` 5–180 (`schema.md` §9), `jobs[].timeoutSeconds` 10–3600 (§13),
`cron[].timeoutSeconds` 10–3600 (§14), `checks[].timeoutSeconds` 60–7200 (§17). Not a contradiction —
each is bounded — but the platform's own budget model (APW-04's token/runner-minute caps, APW-05's build
budget) is nowhere reconciled with the sum of what one App spec may declare. An App Work may legally
declare 10 jobs × 3600 s + 20 cron × 3600 s + 20 checks × 7200 s.

- **Recommended answer:** no schema change (the bounds are per-item by design). Add one sentence to
  APW-04/APW-05's budget sections stating the worst-case sum is capped by the provisioner's runner-minute
  cap rather than by the schema. Flagging it here so the omission is a decision, not an oversight.

### G7 — a Blueprint's comment contradicts the schema it ships against

`blueprints/umami/.works/works.yml:128-129` says "TODO(verify, APW-06): smoke `http` gains a request
body; until then the verification lane asserts this", with the smoke case commented out. `schema.md` §16
already documents `http.body` for `smoke` (POST only), and this artifact's schema accepts it.

- **Recommended answer:** `schema.md` §16 is normative and the field is not new; treat the TODO as stale
  documentation and delete it when APW-06 lands the request body. (No schema work.)

### G8 — the R23 repair introduced an unreserved prefix that apps also use

Recorded as **X-1** by the sibling artifact; not re-derived here. One consequence it does not mention,
because it needs the schema's view: R23 reserves `EVER_WORKS_` only
(`#/$defs/envEntryName`), and the platform's injected set is exactly the five `EVER_WORKS_*` names in
APW-06 `plan.md:392-393` — so the collision argument in that plan ("collision with an App spec name is
impossible (APW-03 R23)", `plan.md:393`) holds after the repair. But the repair renamed the Blueprint's
own three entries to `APP_*`, and `APP_*` is **not** reserved: umami declares its upstream's own
`APP_SECRET` in the same namespace as the Blueprint's `APP_WEB_INTERNAL_URL`.

- **Recommended answer:** keep R23 as it is (the platform prefix must stay reserved), and document a
  convention for **Blueprint-private** names — recommend a `BLUEPRINT_` prefix, or add the rule that a
  Blueprint's env entries must not collide with the upstream's own documented variables. This is a
  Blueprint-authoring rule, not a validator rule; no schema change.

### G9 — `cron[]` may fire every minute, and only `upstreamSync` is rate-limited

`schema.md` R21 limits `upstreamSync.schedule` to one fire per 60 minutes. `cron[].schedule` has no
interval rule, and cal-diy declares two `* * * * *` entries (`tasker`, `webhook-triggers`,
`blueprints/cal-diy/.works/works.yml:206-207,236-237`) — i.e. an App Work's own CronJobs may run
1440 times a day each, on the owner's cluster or on Ever Works Apps.

- **Recommended answer:** intended, but say so. Add one sentence to §14 ("per-minute schedules are
  allowed; APW-06 renders `concurrency: forbid` by default") and let APW-10's tier quotas, not the
  schema, bound the cost. If instead a floor is wanted, it must be a **warning** (a new code), because
  the flagship Blueprint declares it.

### G10 — `schema.md` has no `## 10.` heading

Recorded as **X-2** by the sibling artifact; confirmed independently here: §9 `build` (line 157) runs
straight into the components table at lines 179-201, while §4's table (line 95) links to "§10".

- **Recommended answer:** add the heading. It is the only section reference in the App spec that cannot
  be resolved by a reader, and three epics cite "§10".

---

## B. Rules JSON Schema cannot express

Not repeated in full here — [`validator-rules.md`](./validator-rules.md) §2 gives each rule its schema
construct _and_ its imperative condition. This is the summary of **why** each imperative rule is
imperative, in the order a reviewer is likely to ask:

| Class              | Rules                                                                                                                                                          | Why JSON Schema cannot carry it                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity           | R19, R20 (+ `worker_probe_without_port`, `extension_unavailable`, `dependency_unavailable`)                                                                    | a JSON Schema failure has no severity; a warning rendered as an editor error breaks "a warning is shown and the spec still applies" (`schema.md` §0) |
| Mode               | `blueprint_mode_forbidden_key`                                                                                                                                 | depends on _where_ the file is validated, not on its content (G1)                                                                                    |
| Engine             | `pattern_unsupported`                                                                                                                                          | the schema's `pattern` is ECMA-262, the rule is about RE2 (Q6)                                                                                       |
| Arithmetic         | R9, R17, R21, and every `Mi`/`Gi`/`m` range                                                                                                                    | needs to parse a number out of a string and compare across unit suffixes                                                                             |
| Dynamic sets       | R3, R4, R5, R13 (2 of 3), R14, R15, R16, R23 code, `public_bucket_undeclared`                                                                                  | membership against names declared elsewhere in the same document                                                                                     |
| Platform state     | `source_relation_mismatch`, `blueprint_unknown`, `license_declared_mismatch`, `build_strategy_unavailable`, `dependency_unavailable`, `tracked_branch_missing` | needs the catalog, the registry, the repository or the enabled plugins                                                                               |
| Document as a file | `file_too_large`, `yaml_alias_limit`, `duplicate_key`, `truncated`                                                                                             | applied after YAML parsing, when that evidence is gone                                                                                               |

Fourteen of the 42 fixture entries in the transcript **pass the schema and fail the rules** — that
list, printed in the transcript's findings block, is the operational definition of this boundary.

---

## C. Fields with no documented consumer

I grepped the whole `app-works` spec tree for each field before listing it; the ones with a consumer are
**not** here (`license.sourceOfferUrl` → APW-03/APW-06, `dependencies.redis.persistence` → APW-07's
`k8s-inline-redis`, `deployProvider` → APW-01/APW-06, `provisioning.autoReprovision` → APW-04).

| Field                                                                 | Grep result                                                                                                                                                                                                        | Question and recommended answer                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| root `website_repo` (for `kind: app`)                                 | only in `works.v2.schema.json` and this artifact                                                                                                                                                                   | The v1 key names a repository for the generator; an App Work's repository is `sourceRepository` (APW-01). **Q-A:** document it as preserved-but-ignored for `app` (one sentence in `schema.md` §1), or reject it in app mode? Recommend: document as ignored — it is a v1 key and the envelope preserves unknown/legacy keys.        |
| root `schedule_cadence`                                               | only in the envelope schema                                                                                                                                                                                        | Recurring work for an App Work is `upstreamSync.schedule` (APW-02) and `cron[]` (APW-06). **Q-B:** same answer as `website_repo`.                                                                                                                                                                                                    |
| root `title`, `model`, `initial_prompt`, `activity_sync`, `providers` | used by the _generating_ kinds (`works-config.schema.ts:88-204`); no `app`-specific reader found                                                                                                                   | **Q-C:** state which v1 root keys are meaningful for `kind: app` (I believe: `name`, and nothing else the platform reads), and that the rest are preserved for compatibility. Recommend one table row in §1 rather than a schema change.                                                                                             |
| `components[].target`                                                 | `schema.md` §10 + the envelope schema; **no consumer** in APW-05/APW-06                                                                                                                                            | see **G3**                                                                                                                                                                                                                                                                                                                           |
| `components[].replicas: 0`                                            | `schema.md` §10 says 0–10; APW-06 renders "`replicas` from spec" (`plan.md:330`); the only "zero replicas" language in the program is APW-10's _quarantine_ (`spec.md:117`), which is tier-driven, not spec-driven | **Q-D:** what does `replicas: 0` mean — render no Deployment, render a Deployment with zero replicas, or "component declared but disabled"? Recommend: **render no Deployment for that component** (a disabled component), and say so in §10; otherwise tighten the minimum to 1. Today the schema accepts 0 and no epic defines it. |
| `env[].description`, `env[].prompt.group`                             | referenced only by `schema.md` §12                                                                                                                                                                                 | These are UI affordances (the create/settings pages). **Q-E:** confirm APW-01's create flow and APW-07's env page consume them; if not, they are editor documentation. Recommend: confirm in APW-07's plan §(env UI) — no schema change.                                                                                             |
| `jobs[].retries`                                                      | `schema.md` §13 only                                                                                                                                                                                               | **Q-F:** confirm APW-06's job runner reads it. Recommend: yes, and add it to APW-06 plan §4.8's job renderer table.                                                                                                                                                                                                                  |

---

## D. Assumptions I had to make

Each is a decision the schema could have gone either way on. Change any answer and the fixture that pins
it must change with it.

| #       | Assumption in this artifact                                                                                                                                                                                                                                              | Question                                                                      | Recommended answer                                                                                                                                                                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q1**  | The stand-alone schema is for **whole `.works/works.yml` documents** (root envelope + `spec`), with the spec block also addressable as `#/$defs/appSpec`.                                                                                                                | Should `app-spec.schema.json` validate the envelope or only the `spec` block? | Whole document, as built: catalog CI C4 validates a Blueprint's `works.yml`, and the fixtures are documents. Keep `#/$defs/appSpec` for callers that hold a spec block alone (draft validation, Blueprint apply).                                                                                                  |
| **Q2**  | "Only with X" fields are **forbidden** elsewhere: `generate.bytes` (base64/hex only), `generate.length`/`alphabet` (chars only), `generate.keypair` (kind keypair only), `build.dockerfile`/`target` (strategy dockerfile only), `build.context` (dockerfile/auto only). | Read "only with" as forbidden, or as merely meaningless?                      | Forbidden. `schema.md` §9/§12 uses "only with" for every other restriction of the same shape, and a value that is silently ignored is exactly what strictness exists to prevent. Note the cost: the §1 outline's `generate` block must be rewritten (G2), and `contracts-1/materialised` records the substitution. |
| **Q3**  | `build.strategy: none` **with** components is accepted (R2's second half only requires `strategy` to be _declared_).                                                                                                                                                     | Is `strategy: none` + components legal?                                       | No — reject it. A declared component with `none` cannot be built or deployed; add `strategy: none` to the `components_require_strategy` condition. This artifact currently follows the literal text, and no fixture pins it either way.                                                                            |
| **Q4**  | `oneOf` failures on `jobs[]`/`cron[]` (both `command` and `http`, or neither) map to the structural code `invalid_type`.                                                                                                                                                 | Which code should "exactly one of `command`/`http`" use?                      | Add a dedicated code (`job_source_count`, mirroring `env_source_count`) to §23's structural list. `invalid_type` is not wrong but loses the reason.                                                                                                                                                                |
| **Q5**  | `build.image` may be present when `strategy` is not `image` (the schema only _requires_ it for `image`).                                                                                                                                                                 | Forbid `build.image` when it is not used?                                     | Yes, forbid it (`if strategy ≠ image then not required [image]`), and fix `contracts-1/materialised` — which is exactly the outline's ambiguity, since §1 shows `image:` with `strategy` unresolved.                                                                                                               |
| **Q6**  | `validate.pattern` is checked against RE2 by the **rule** layer, never by the schema.                                                                                                                                                                                    | Where does `pattern_unsupported` live?                                        | Keep it rule-level. Encoding RE2's restrictions in an ECMA-262 `pattern` would make the editor and the platform disagree, and would be a claim about a different engine (see `validator-rules.md` §7.3).                                                                                                           |
| **Q7**  | Quantity **ranges** (`1Gi`–`64Gi`, `64Mi`–`256Gi`, `100Mi`–`500Gi`, `10m`–`64000m`, `0.01`–`64`) are rule-level; the schema carries the unit **syntax** only.                                                                                                            | Accept, or enumerate unit-by-unit alternatives in the schema?                 | Accept. Enumerating ranges per unit is an unbounded enumeration that would still not cover `0.5` cores, and the rule is one comparison.                                                                                                                                                                            |
| **Q8**  | `blueprint.version` is `MAJOR.MINOR.PATCH` only — no pre-release, no build metadata.                                                                                                                                                                                     | Allow SemVer pre-release (`1.0.0-rc.1`)?                                      | Decide explicitly. Pick "triple only" if Blueprint versions are release-line versions (which catalog §5's PATCH/MINOR/MAJOR contract implies) and say so in §6; pick full SemVer otherwise. The pattern is `#/$defs/blueprint/properties/version`.                                                                 |
| **Q9**  | `spec.kind` and the root `kind` are both `const "app"`; the **equality** check and the code are rule-level.                                                                                                                                                              | Is two `const`s enough?                                                       | Yes for the schema; the rule adds the code. Note the schema must also accept `spec.kind` **absent** while root `kind: app`, and vice versa (`pos-03`).                                                                                                                                                             |
| **Q10** | `env[].name` is the ONLY place the reserved prefix is enforced; `authEnv`, `publicUrlEnv`, `fromEnv`, `passwordEnv` accept a reserved name by shape and fail as `reference_unresolved`.                                                                                  | Should those fields reject `EVER_WORKS_*` directly?                           | Keep as built: resolution failure is the accurate diagnosis, and the reserved-name code should stay about `env[]` entries so the UI can point at the entry.                                                                                                                                                        |
| **Q11** | The build's supported `appSpecVersion` is a constant that does not exist yet; this artifact assumes it sits beside `WORKS_CONFIG_SCHEMA_VERSION` (`works-config.schema.ts:44`).                                                                                          | Where does "newer than this build understands" come from?                     | Export `APP_SPEC_VERSION = 1` from `app-spec.schema.ts` and compare, exactly as `validateWorksConfig` compares `version` today (`works-config.schema.ts:432-438`). Do not read it from the schema document.                                                                                                        |
| **Q12** | `x-` keys are stripped from a **copy** for validation; the stored document keeps them.                                                                                                                                                                                   | Confirm the write path.                                                       | Confirmed by plan.md:137-138 (`stripExtensionKeys(copy)`); C1's "no writer ever deletes it" is the same statement. Worth an explicit test in APW-03 T-series: round-trip a spec with `x-` keys and assert byte equality.                                                                                           |
| **Q13** | `checks[].required: false` is legal and produces a warning.                                                                                                                                                                                                              | Keep advisory checks?                                                         | Keep (R20 already defines the warning), but note that APW-05 R-9 puts each check in the user's CI as its own job — an advisory job that cannot fail is a CI cost with no gate. Recommend: allow, warn, and count only `required: true` checks in APW-05's "verified" evidence.                                     |
| **Q14** | The `app` branch of the **envelope** is not modified by this artifact (it is emitted by `emit-json-schema.ts`).                                                                                                                                                          | Should the envelope schema also reject an `app` typo?                         | Yes — plan.md:159-161 requires the root `allOf`/`if`/`then` that points `spec` at `#/$defs/appSpec` whenever `kind: app`, so a typo cannot slip through the unrecognised-kind escape branch. The artifact supplies the `$defs` document; the envelope change is APW-03's task.                                     |

---

## E. What would change these conclusions

1. **The worktree moving again.** Anything in §A that cites a Blueprint line can move; the transcript's
   sha256 column is the anchor. `evidence/fixtures/head-revision/SOURCE.txt` pins `HEAD`.
2. **`schema.md` §3 changing for blueprint mode.** G1's "recommended answer" is the alternative reading;
   if the owner keeps the literal rule, APW-13's Blueprints must change instead (three files).
3. **The `app` branch landing in `works.v2.schema.json`.** Once the envelope carries the `app` branch,
   the drift test (`__tests__/emit-json-schema.spec.ts:69-80`) becomes the authority for the emitted
   form, and this hand-written artifact should be reduced to the `$defs` document it emits — not kept as
   a second source of truth.
