/**
 * App Works — the **license gate's** shared vocabulary: the four classes, the
 * managed-hosting reasons in evaluation order, the hosting eligibility a
 * deployment is judged by, the source offer and the one attestation record.
 *
 * Owning epic: **APW-03** (App spec, Apps catalog and license gate).
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/spec.md`
 * FR-53…FR-65; `.../schema.md` §7 (`license`) and §22 R24; `.../catalog.md` §4
 * (`licenses.yml`, the class table and the fixed class rank at :263-271).
 * Plan: `.../plan.md` §2.6 (the license gate, the eligibility shape at
 * :328-330, the source offer at :337-347, the attestation at :350-353) and §3.2
 * (this file's place in the shared-type table at :467). Bindings:
 * `docs/specs/features/app-works/CONTRACTS.md` §2A (:321, :324) and **R-3**
 * (CONTRACTS.md:46: one attestation record owned by APW-03, red/amber rules),
 * **R-26** (additive only) and **R-5** (tier state enters through
 * `AppsTierPolicy`, never through an environment variable).
 *
 * The five managed reasons are a **closed union whose order is the evaluation
 * order** (plan §2.4:216): the first reason that fails is the reason reported,
 * so a row that is both unverified and disallowed by the tier reports the
 * earlier one. Reordering this array is a behaviour change, which is why
 * `apps-contracts.spec.ts` pins it member by member.
 *
 * The numeric limits of plan §3.2:503-514 that belong to this gate live here,
 * next to the vocabulary they bound. `apps-limits.ts` already shipped with
 * APW-01's repository-stage and quota limits and is not edited by this task, so
 * nothing is declared twice and no landed module moves.
 */

// ---------------------------------------------------------------------------
// The four license classes (schema.md §7:151, plan §3.1:434, R-3)
// ---------------------------------------------------------------------------

/**
 * The classification of a licence, in the registry's own order
 * (`licenses.yml classes:` — catalog.md §4:193-196) with `unknown` last, the
 * value schema.md §7:151 adds for a licence detection could not classify.
 *
 * `unknown` is a first-class answer, never a guessed class (APW-01 FR-8;
 * catalog.md §4:260): the platform computes it itself and never reads the
 * registry's advisory `unknown.class` key.
 */
export const LICENSE_CLASSES = ['green', 'amber', 'red', 'unknown'] as const;

/** Union derived from {@link LICENSE_CLASSES}. */
export type LicenseClass = (typeof LICENSE_CLASSES)[number];

/**
 * The fixed rank the class comparison uses — **green < amber < unknown < red**
 * (catalog.md:265).
 *
 * It is the rank `A OR B` (best), `A AND B` (worst), a mixed repository and
 * `previewUpstream.worse` (FR-60, plan §2.6:355-357) are decided with.
 * `unknown` sits between amber and red on purpose: worse than a
 * known-permissive-plus-agreement case, better than a licence that forbids the
 * use outright (catalog.md:269-271).
 */
export const LICENSE_CLASS_RANK: Readonly<Record<LicenseClass, number>> = {
	green: 0,
	amber: 1,
	unknown: 2,
	red: 3
};

/**
 * Where the classified licence came from (schema.md §7:152 `source`, and the
 * `licenseSource` column of plan §3.1:435). `detected` is what the gate
 * classifies from; `blueprint` and `user` are declarations, and a declaration
 * that differs from detection is the `license_declared_mismatch` warning
 * (schema.md:156-157, R24).
 */
export const LICENSE_SOURCES = ['detected', 'blueprint', 'user'] as const;

/** Union derived from {@link LICENSE_SOURCES}. */
export type LicenseSource = (typeof LICENSE_SOURCES)[number];

/**
 * Which registry copy a classification came from (plan §3.1:441): the live
 * `licenses.yml`, the last good copy (kept 7 days) or the bundled snapshot.
 * A snapshot-sourced classification forces `managedHosting: false` (FR-38,
 * plan §2.6:321-323).
 */
export const LICENSE_REGISTRY_SOURCES = ['live', 'last_good', 'snapshot'] as const;

/** Union derived from {@link LICENSE_REGISTRY_SOURCES}. */
export type LicenseRegistrySource = (typeof LICENSE_REGISTRY_SOURCES)[number];

// ---------------------------------------------------------------------------
// Managed hosting reasons and Blueprint match sources (plan §2.4:216, §3.2:467)
// ---------------------------------------------------------------------------

/**
 * Why an entry may not run on **Ever Works Apps**, in **evaluation order**
 * (plan §2.4:216, R-3; the five i18n leaves of plan §8:788).
 *
 * | # | Reason                      | Fails when                                                                                  |
 * | - | --------------------------- | ------------------------------------------------------------------------------------------- |
 * | 1 | `licenseNotGreen`           | the class is `red` or `unknown`                                                             |
 * | 2 | `upstreamAgreementMissing`  | the class is `amber` and no `managedHosting.upstreamAgreement` is recorded (catalog.md:106)  |
 * | 3 | `entryDisallows`            | `managedHosting.allowed` is `false` (catalog.md:106)                                        |
 * | 4 | `blueprintNotVerified`      | the tier's scope is `verified-blueprints` and the entry is not verified, or an explicit Blueprint was chosen for a repository the entry does not list (FR-81) |
 * | 5 | `managedTierDisabled`       | `AppsTierPolicy.isOpen()` is `false` — the port unbound means closed (R-5)                    |
 *
 * Only the **first** failing reason is reported, so the order is behaviour.
 */
export const MANAGED_HOSTING_REASONS = [
	'licenseNotGreen',
	'upstreamAgreementMissing',
	'entryDisallows',
	'blueprintNotVerified',
	'managedTierDisabled'
] as const;

/** Union derived from {@link MANAGED_HOSTING_REASONS}. */
export type ManagedHostingReason = (typeof MANAGED_HOSTING_REASONS)[number];

/**
 * What `managed` is on a hosting eligibility: `allowed`, or the first reason it
 * is not (plan §2.6:328-330; APW-06 plan.md:701 maps it onto its refusal codes).
 */
export type ManagedHostingDecision = 'allowed' | ManagedHostingReason;

/**
 * What one **catalog entry** states about Ever Works Apps: `available`, or the
 * first failing reason (FR-35 spec.md:271-275 "Each entry MUST state
 * managed-hosting availability as `available` or the first failing reason, in
 * this order"; plan §2.4:216).
 *
 * It is derived from {@link MANAGED_HOSTING_REASONS} rather than re-listed, so
 * the catalog's word and the eligibility's word can never drift apart: they are
 * the same five reasons, with the catalog saying `available` where a hosting
 * eligibility says `allowed` (`HostingEligibility.managed`). The two are
 * different fields on different shapes — compare within one of them, never
 * across.
 */
export const MANAGED_HOSTING_AVAILABILITIES = ['available', ...MANAGED_HOSTING_REASONS] as const;

/** Union derived from {@link MANAGED_HOSTING_AVAILABILITIES}. */
export type ManagedHostingAvailability = (typeof MANAGED_HOSTING_AVAILABILITIES)[number];

/**
 * How a Blueprint was matched to a repository (plan §3.1:425 — the
 * `blueprintMatchSource` column — and plan §2.5:229-238 for what each value
 * means).
 *
 * `explicit` is FR-81's path: a Blueprint id sent with the create or apply
 * request. `file` is the sixth value plan §3.1:425 and `data-model.md:151`
 * record for a Blueprint the App spec's own `blueprint` block names.
 *
 * This is the **canonical** union (app-source.ts:278-281 says so explicitly);
 * APW-01's `AppSourceBlueprintMatchSource` (app-source.ts:282) is the source
 * record's five-member spelling of it and is deliberately left alone. The
 * superset is implemented here per CONTRACTS R-26 — APW-01's five members are
 * the first five of this list and no member is narrowed.
 */
export const BLUEPRINT_MATCH_SOURCES = ['manifest', 'alias', 'fork', 'probe', 'explicit', 'file'] as const;

/** Union derived from {@link BLUEPRINT_MATCH_SOURCES}. */
export type BlueprintMatchSource = (typeof BLUEPRINT_MATCH_SOURCES)[number];

// ---------------------------------------------------------------------------
// Eligibility, source offer and attestation (plan §2.6:328-353)
// ---------------------------------------------------------------------------

/**
 * Whether a person has to attest before a target may run the App Work
 * (plan §2.6:330-331; FR-57; R-3).
 *
 * `allowed` for `green`; `attestationRequired` for `amber`, `red` and `unknown`
 * until the owner's valid attestation exists. **None** is always `allowed` and
 * is therefore not a member.
 */
export const LICENSE_HOSTING_DECISIONS = ['allowed', 'attestationRequired'] as const;

/** Union derived from {@link LICENSE_HOSTING_DECISIONS}. */
export type LicenseHostingDecision = (typeof LICENSE_HOSTING_DECISIONS)[number];

/**
 * The source link the `network-source-offer` obligation requires
 * (plan §2.6:337-347, FR-61).
 *
 * `required` = the obligations include `network-source-offer` **and** the
 * relation is `link` or the divergence `aheadBy` is null or greater than zero —
 * a null `aheadBy` (never compared) counts as required, so the offer is never
 * silently skipped. `url` targets the deployed commit and is `null` when no
 * commit was given or the repository is private without a declared
 * `license.sourceOfferUrl`; `missing` is the refusal `sourceOfferMissing`
 * (schema.md §22:481, R27) and is meaningful even when `url` is `null`.
 */
export interface SourceOffer {
	required: boolean;
	url: string | null;
	missing: boolean;
}

/**
 * Everything a deployment target is judged by (plan §2.6:328-330; APW-06
 * plan.md:700-701 reads exactly these three members and maps the second and
 * third onto its refusal codes).
 *
 * `none` is always `allowed` — "None — don't deploy yet" (R-12) never runs
 * anything, so no licence can refuse it. `managed` carries either `allowed` or
 * the first failing {@link ManagedHostingReason}. The record is recomputed on
 * every call: `WorkAppSpecState.sourceOfferRequired` is a display cache and
 * nothing decides from the column (plan §2.6:348-349).
 */
export interface HostingEligibility {
	none: 'allowed';
	yourCluster: LicenseHostingDecision;
	managed: ManagedHostingDecision;
	sourceOffer: SourceOffer;
}

/**
 * The one attestation record, stored on `WorkAppSpecState.attestation`
 * (plan §3.1:444, C3/R-3 — APW-06 stores none of its own).
 *
 * `textId` must equal the registry's current text for the classified licence
 * and `commitSha` the licence commit; `textSha256` hashes the attested text so
 * a later evaluation can clear the record when `spdx`, `class` or `textId`
 * differ (FR-59/FR-60, plan §2.6:350-354). Owner-only: any other member,
 * a manager included, gets `403 ownerOnly`.
 */
export interface LicenseAttestation {
	userId: string;
	attestedAt: string;
	spdx: string;
	class: LicenseClass;
	textId: string;
	textSha256: string;
	commitSha: string;
}

// ---------------------------------------------------------------------------
// The gate's limits (plan §3.2:506-514)
// ---------------------------------------------------------------------------

/**
 * How close a detected licence text must be to a registry text to be classified
 * — 0.9, the word-bigram Dice coefficient threshold of plan §2.6:309-310.
 */
export const LICENSE_TEXT_MATCH_THRESHOLD = 0.9;

/**
 * How many files one detection pass reads at most — 12, the root licence files
 * and package manifests of plan §2.6:305.
 */
export const LICENSE_MAX_FILE_READS = 12;

/**
 * The tree segments that make a repository **mixed** (plan §2.6:311, §3.2:508;
 * `licenseMixed` on plan §3.1:436). A path carrying one of these segments up to
 * {@link LICENSE_MIXED_MAX_DEPTH} deep is evidence that part of the repository
 * is under a different licence.
 */
export const LICENSE_MIXED_DIR_NAMES = ['ee', 'enterprise', 'premium', 'commercial'] as const;

/** How deep the mixed-licence scan looks for {@link LICENSE_MIXED_DIR_NAMES} — 4 (plan §2.6:311). */
export const LICENSE_MIXED_MAX_DEPTH = 4;

/** How many evidence paths are stored per side (`files`, `mixedPaths`) — 20 (plan §3.1:437). */
export const LICENSE_EVIDENCE_MAX = 20;

/**
 * The largest repository tree the gate lists — 100 000 entries
 * (plan §2.6:304). A truncated listing does not fail the classification: the
 * root result stands and `licenseScanIncomplete` is shown on the License card
 * (plan §9.2:833).
 */
export const LICENSE_TREE_MAX_ENTRIES = 100_000;

/**
 * How many bytes of each file the pure `scanLicenseHeaders` reads — 2048
 * (plan §2.6:324-325, FR-54). APW-04 and APW-05 call it in their checkouts.
 */
export const LICENSE_HEADER_SCAN_BYTES = 2_048;

/** How many attestations one member may record per minute — 10 (plan §4.1:552). */
export const LICENSE_ATTEST_PER_MIN = 10;

/**
 * Whether an entry must be verified to be offered on **Ever Works Apps** —
 * `true` (plan §3.2:514, D7).
 *
 * It is the scope assumed **only** while APW-10's `AppsTierPolicy` port is
 * unbound (R-5): an unbound port means `{ open: false, scope: 'verified-blueprints' }`
 * (plan §2.4:216). The value is a constant, not a reading — the mapper and
 * `managedHostingAvailability` are pure functions of their arguments and never
 * reach for a policy or `process.env` themselves.
 */
export const APPS_MANAGED_REQUIRES_VERIFIED = true;
