# Open questions

**What this file is.** Points the epics genuinely do not decide — where two readings are both defensible and
the difference changes the bytes the acceptance suite asserts. Each carries a **recommended default**, which
is what this directory's golden files already implement, so implementing against them is safe: if the owner
rules the other way, the golden files change in one place.

Nothing here is a request for a new App spec field (see `contradictions.md` §C–D for those).

---

## Q-1. What exactly are the canonical bytes that `inputsHash` hashes?

**Undecidable because:** APW-05 §4.5 lists the canonical inputs (`generator`, `trackedBranch`, normalised
`build`, value names with `secret`/`fromBuildService`, `runner`, `settings`, `pins`, `verifyEnabled`,
`checks`) and says `inputsHash = sha256(canonical JSON)` (`plan.md:662-665`), and §4.5 also says emission is
byte-stable (`plan.md:666-667`). But "canonical JSON" is never defined: key order, separators, whether
`memory: '4Gi'` becomes `memoryGiB: 4`, whether absent optional fields are omitted or emitted as `null`,
whether the trailing newline is included.

**Impact:** the `inputs=sha256:…` value on line 3 of every generated workflow file. Get it wrong and every
App Work re-writes its workflow on the next preparation (`plan.md:672-674`: "Bumping pins bumps `inputsHash`,
so every App Work gets a pull request or commit with the new file on its next preparation"), producing a
spurious PR per App Work per release.

**Recommended default** (implemented in `build-workflow/README.md` §2): compact JSON — no whitespace, keys
sorted ordinally at every level, numbers as numbers, booleans as booleans, empty arrays present
(`"services":[]`), no `null` for absent optionals, UTF-8, **no trailing newline** — hashed over the exact byte
string reproduced in that README. Publish the string in the generator's unit test so the two can never drift.

---

## Q-2. Which App specs are the renderer's golden fixtures?

**Undecidable because:** APW-06 T6 says the goldens are "built from APW-03 `schema.md` §24 examples"
(`tasks.md:115-116`), and §24 holds three valid samples (`schema.md:511-608`, `:612-647`, `:654-698`). But the
acceptance scenarios assert against the **APW-13 Blueprints** (`manifests/…` in this directory), which are also
real App specs and are what the live lane deploys. APW-13's documents never mention determinism or golden
files at all.

**Impact:** if the fixtures are §24's samples, nothing in the suite asserts the two Blueprints' rendering, and
ACC-E2E-05/ACC-13-\* would be discovered at run time only. If they are the Blueprints, the three §24 samples
(the only specs exercising `strategy: image`, `redis`/`objectStorage` dependencies and a `worker` with
`replicas: 2`) go unasserted.

**Recommended default:** use the two APW-13 Blueprints as the primary goldens (this directory) **and** add
§24's three samples as smaller structural fixtures in
`packages/plugins/k8s/src/app/__tests__/fixtures/`. The §24 samples cover feature combinations the Blueprints
do not (image strategy, object storage, multi-replica worker); the Blueprints cover what the acceptance suite
actually runs.

---

## Q-3. Is the verification-runner script byte-specified?

**Undecidable because:** APW-05 §4.10 describes the embedded script's _behaviour_ in detail (plan schema
check, the 12 GiB summed-memory refusal, throwaway `postgres`/`redis`/`minio` containers pinned by digest
with no volumes, `openssl rand`/`openssl genpkey` materialisation into a `0600` env file, jobs run to
completion with exit codes checked, readiness waits, smoke via `curl --max-time 30 --max-redirs 0`, per-job and
per-smoke result rows, the env file shredded, `set +x` throughout) and T15 makes it a template literal — but
no line of the epic contains the script text, so no two implementations produce the same bytes.

**Impact:** the generated workflow's `Verify in the runner` step. A byte-comparison golden test would fail on
every implementation, and the workflow's own fingerprint (Q-1) would change.

**Recommended default** (implemented in `build-workflow/ever-works-build.yml`): treat the script as
**structurally** normative, not byte-normative. The golden asserts: the documented failure markers
(`EW_VERIFY_PLAN_MALFORMED`, `EW_VERIFY_MEMORY_EXCEEDED`, `EW_VERIFY_DEPENDENCY_UNSUPPORTED`,
`EW_VERIFY_GENERATOR_UNSUPPORTED`, `EW_VERIFY_PROMPTED_UNSET`), the 60,000-character plan bound, the 12 GiB
sum, the `shred -u` of the env file, `set +x`, one JSON row per job and per smoke request, and the absence of
any generated value in captured stdout/stderr (T15's own assertions, `tasks.md:250-254`). The body ships in
the generator's template literal; the golden compares its _behaviour_, and the `inputsHash` treats the script
as a constant so the fingerprint is still stable per generator version.

---

## Q-4. What does `<hash10>` in `ew-runner-<hash10>` hash?

**Undecidable because:** APW-06 §4.1 names the object `ew-runner-<hash10>` and says what it holds ("Script +
check list", `plan.md:300`) but never what is hashed. §4.7 defines a checksum for the env Secret and platform
ConfigMap and does not reuse it here.

**Impact:** the `volume.configMap.name` of every runner Job (cron, http jobs, smoke, hairpin, isolation
probe). Any disagreement changes every CronJob's pod template.

**Recommended default** (implemented in both `_index.md` files and both `40-configmap-runner.yaml`s):
`hash10 = first 10 hex of sha256("<workId>|ever-works-runner|v1")`. It is per-App-Work (so two App Works can
never share a ConfigMap), stable across renders of the same Work (so a re-render does not roll pods), and
independent of the script text (so bumping `APP_RUNNER_IMAGE` or the script does not silently rename an
immutable ConfigMap without the deployer noticing). A content hash is the defensible alternative — if chosen,
the renderer must also delete the superseded ConfigMap, which §4.2's apply order does not mention.

---

## Q-5. Does `*/5 * * * *` count as "more often than every 5 minutes"?

**Undecidable because:** APW-06 §4.9 says "schedules that can fire more often than every 5 minutes are refused
(`cron_too_frequent`)" and APW-10 carries `cron: { schedule (≥ 5 min) }` with the same refusal code
(`APW-10 plan.md:245`, `:268`). A `*/5` schedule fires exactly every five minutes; a `* * * * *` schedule
obviously violates the rule. Whether the boundary is inclusive depends on reading "more often than" strictly
(exclusive: `*/5` allowed) or the `≥ 5 min` shorthand literally (inclusive: `*/5` allowed).

**Impact:** cal-diy's `calendar-subscriptions` (`*/5 * * * *`, works.yml:210). Inclusive → it renders on the
managed target; exclusive → it is refused, and cal-diy loses three of seven schedules there rather than two.

**Recommended default** (implemented in `manifests/cal-diy/managed-overlay.yaml`): **inclusive** — a schedule
whose minimum interval is exactly five minutes is allowed; only intervals under five minutes are refused.
Reason: APW-10's own shorthand is `≥ 5 min`, and refusing an exact five-minute interval would make the
common `*/5` idiom unusable on the tier. So cal-diy keeps four CronJobs on the managed target and the golden
records the three refusals as comments.

---

## Q-6. Too-frequent cron: drop the schedule, or refuse the whole Deployment?

**Undecidable because:** APW-06 §4.9 states the refusal code and nothing about scope; APW-10 states the
desired-state limit and a `Work.refusal` code (`CRON_TOO_FREQUENT`, `plan.md:265-268`) with a
`refusal: { code, field }` status, which reads as a whole-object refusal — but `field` is singular and the
`Work` still carries a valid `cron` list with the offending entry removed.

**Impact:** whether an App Work with one every-minute schedule deploys at all on the managed target, or
deploys without that schedule.

**Recommended default:** **refuse the whole Deployment**, naming the offending schedule
(`{ code: 'cron_too_frequent', field: 'cron[<name>]' }`), and surface it as the precondition
`cron_too_frequent` with the schedule name. Reason: silently dropping a schedule changes what the app does
without the owner's knowledge, and `Work.refusal` has no partial-refusal shape. The golden files therefore
record the refusals as comments rather than as a reduced CronJob list; if the owner prefers the partial
reading, only `manifests/*/managed-overlay.yaml` changes.

---

## Q-7. Which quota numbers apply on the managed target?

**Undecidable because:** APW-06 §4.2 gives 13 explicit `ResourceQuota` keys with values and calls them the
`ever-works-apps` defaults; APW-10 FR-47 ships named Starter/Standard profiles with different numbers and
names only four keys. Neither says which wins, and APW-10 owns the tier.

**Impact:** whether a rendered App Work is admissible at all on the tier. With the renderer's
`limits.cpu = max(1, 4 × cpu)`, the fixture's two components carry 1 CPU each; a Starter profile's
`limits.cpu: 2` admits exactly two such components and no more.

**Recommended default:** **APW-10's profile wins** (it is the tier's own admission contract and
`AppsTierPolicy.podPolicy()` is the port that carries it), and APW-06's §4.2 numbers are the _fallback_ when
`podPolicy()` returns nothing. This directory's `managed-overlay.yaml` files currently show APW-06's numbers
because §4.2 states them concretely and FR-47 states only two profiles; **the golden files should be
regenerated against the profile once APW-10 fixes the shipped values**, and the two documents' numbers
reconciled in `contradictions.md` X-8.

---

## Q-8. One SSA field manager for both renderers, or two?

**Undecidable because:** `FIELD_MANAGER = 'ever-works-k8s-plugin'` (`manifest.renderer.ts:8`) is documented as
a breaking change to edit (`:4-7`) and is used by every apply (`k8s-api.service.ts:361-369` and siblings).
APW-06 §4 never names a field manager. APW-10 uses `ever-works-apps-plugin` for the `Work` object and
`ever-works-apps-controller` for what the zone applies.

**Impact:** who wins an SSA conflict on a hand-edited App field. Sharing the manager keeps today's behaviour
(force=true overwrites, `plan.md:1043`); splitting it means each renderer's fields are owned separately and a
hand-edit made under the App manager survives a site render.

**Recommended default:** **one manager per capability path is unnecessary; keep `ever-works-k8s-plugin`** for
App objects on `your-cluster`, because (a) App objects live in a namespace the platform owns end to end, so
there is no third party to protect, (b) the existing constant's "breaking change" warning is about _users
already SSA-conflicting_, which no App Work can be on day one, and (c) a second constant doubles the places a
future rename must touch. Record the choice in APW-06 §4.2 so it is not rediscovered.

---

## Q-9. What is a CronJob's inner Job named?

**Undecidable because:** APW-06 §4.1 gives `Job` → `job-<name>-<deploymentShort>` (≤ 45) and manual runs
`run-<name>-<8 hex>`, and says nothing about the Job a CronJob creates. A fixed name would collide on the
second firing; Kubernetes generates `<cronjob-name>-<timestamp>` when the template names none.

**Impact:** whether the inner Job appears in the golden file's bytes at all, and whether
`APP_JOB_RUNS_KEPT = 3` (plan §5.3) can count Jobs by name.

**Recommended default** (implemented in `manifests/*/60-cronjobs.yaml`): **omit `metadata.name` in
`jobTemplate`** and let the controller generate it, with the identity carried by the `ever-works.io/cron`
label instead. GC then selects by label, which is also what APW-06 §4.8's "the last 3 Jobs per job name are
kept" needs to mean for cron.

---

## Q-10. Do rendered probes carry the schema's defaults, or only what the spec declares?

**Undecidable because:** APW-06 §4.5 says the probe object takes `periodSeconds`, `timeoutSeconds`,
`initialDelaySeconds`, `failureThreshold` from the spec and that "defaults [are] applied by the renderer only
where the spec is silent" — but `APW-03 schema.md:20` says "Defaults are never written back into the file"
(about the spec file), which does not settle whether they are written into the _manifest_. The deadline
formula (`plan.md:577-579`) needs numeric values, so _something_ must supply them.

**Impact:** every probe object's bytes. A golden file that emits only declared fields would differ from one
that emits the schema's defaults in dozens of lines.

**Recommended default** (implemented here): **emit the fully-defaulted probe object** — `periodSeconds` 10,
`timeoutSeconds` 5, `initialDelaySeconds` 0, `failureThreshold` 3 (startup 30) from `schema.md:198-201` — so
the manifest is self-describing and the deadline formula is computed from rendered values. The plan's own
worked example (`10×60 + 10×3 + 120 = 750`, `plan.md:579`) confirms it reads the defaults as real numbers.

---

## Q-11. Should the secret-in-image step be emitted when every `fromEnv` build argument is non-secret?

**Undecidable because:** the step is conditional on `EW_SECRET_NAMES` being non-empty, defined as "space-
separated `EW_` names whose env entries are secret and not build-service derived" (`plan.md:175`), while
FR-21 says the check covers "every secret build value of 8 characters or more". For app-fixture-hello the
single `fromEnv` argument `FIXTURE_BUILD_LABEL` is a literal, non-secret value (works.yml:91), so
`EW_SECRET_NAMES` is empty and the step is not emitted.

**Impact:** whether the reference golden file exercises the secret-in-image path at all. ACC-05-15's live half
uses `variant/secret-in-image`, which is a _repository_ variant, not a spec variant — so the check would be
asserted only there and by T15's shell test.

**Recommended default** (implemented here): **keep the condition as written** — do not emit the step when no
secret build value exists, because scanning for a value the platform knows to be non-secret would fail builds
for no security gain, and the "Check build values" step already proves presence. To keep the path covered,
add a fourth golden fixture (a spec with a secret `fromEnv` arg) rather than weakening the condition.

---

## Q-12. Do non-secret runtime env values live in the Secret or in the ConfigMap?

**Undecidable because:** APW-06 §4.7 says "The env Secret holds exactly the `values` from
`AppRuntimeEnvSource` (APW-07, runtime/both phases)" and "The platform ConfigMap holds `EVER_WORKS_APP_URL`,
…". `AppRuntimeEnvSource.resolve()` returns one `values: Record<string, string>` with no secrecy split, so a
non-secret runtime value (`TZ: UTC`, `FIXTURE_MARKER`) has no stated home other than "the Secret".

**Impact:** the Secret's key set, hence the checksum, hence every derived name — and whether ACC-E2E-05's
"keys equal to the App spec's run-phase env names" holds literally.

**Recommended default** (implemented here): **all runtime/both values go into the env Secret, secret or not**;
the ConfigMap holds only the platform's own `EVER_WORKS_*` names. Reason: `env.secretNames` exists only for
log redaction (`plan.md:210`), the Secret is already immutable per checksum, and splitting by `secret:` would
make the key set depend on a flag that can change without changing the values — renaming the Secret and
rolling every pod on a `secret: false → true` edit.

---

## Q-13. Does the `checks` job also run for the tracked branch, or only on pull requests?

**Undecidable because:** R-9 says "on same-repository pull requests **and on the tracked branch**, one
`checks` matrix job" (`CONTRACTS.md:300`), while APW-05 §4.14 and the §2.4 sketch give the job
`if: github.event_name == 'pull_request' && …` — pull request only (`plan.md:231`, `:845-846`) — and T41's
test asserts only the pull-request guard. ACC-05-29 says "a PR from another repository runs no check" and is
silent about the tracked branch.

**Impact:** whether a push to the tracked branch spends runner minutes on checks. It does not change any
Build's status by design (`plan.md:852-854`: check minutes are summed into `checksBillableMinutes`; "the PR
Build's status is unchanged").

**Recommended default** (implemented in `build-workflow/ever-works-build.yml`): **pull request only**, as the
plan and T41 specify. Reason: the CONTRACTS sentence reads as "the checks job exists for same-repository pull
requests and [for] the tracked branch['s file]", and R-9's operative requirement is a check run **on the pull
request**; running the repository's own `yarn test` again on every merge to the tracked branch doubles spend
for a result APW-08 already has. `CONTRACTS.md:300` should be reworded rather than the job widened.

---

## Q-14. Where do the golden files live, and how do `docs/` and `packages/` stay in sync?

**Undecidable because:** this directory is the only place the expected bytes are written down, but the test
code that needs them lives in two packages whose own tasks name different paths
(`packages/plugins/github-actions-build/src/__tests__/golden/`, APW-05 T8/T41; and
`packages/plugins/k8s/src/app/__tests__/fixtures/`, APW-06 T6). No epic says whether the docs copies are
authoritative, or how they are kept identical.

**Impact:** two sources of truth for the same bytes; a fix applied to one and not the other.

**Recommended default** (described in `golden-test-plan.md` §1): **this directory is the source of truth**,
the package fixtures are mechanical copies, and a single test (or a CI script) reads both and fails on any
difference. Do not make the plugin packages import from `docs/` at test time — a package must not depend on
the documentation tree — and do not make this directory the only copy, because `pnpm --filter … test` must run
without the docs checkout.

---

## Q-15. How does `http.authEnv` reach the runner: a named env var, or a JSON blob?

**Undecidable because:** APW-06 §4.8 says "`http.authEnv` is sent as `Authorization: Bearer <value>`
(`authScheme: bearer`, default) or `Authorization: <value>` (`authScheme: raw`) … Bodies with `{{env.NAME}}`
placeholders are resolved by the runner from `secretKeyRef` env vars". It does not say whether the runner pod
gets one env var per named `authEnv`, or one var holding every value.

**Impact:** the CronJob's `env:` block and the shape of `requests.json` — i.e. the bytes of every runner Job.

**Recommended default** (implemented here): **one `secretKeyRef` env var per `authEnv` name used in this App
Work's rendered requests**, named exactly as the App spec names it (`CRON_SECRET`, `CRON_API_KEY`,
`FIXTURE_CRON_TOKEN`), with `requests.json` carrying `authEnv`/`authScheme` and the runner resolving
`{{env.NAME}}` from `process.env`. Reason: it keeps the value out of a command line and out of any file on
disk, matches §4.8's "from `secretKeyRef` env vars" literally, and lets a single App Work use two different
cron credentials (as cal-diy does).
