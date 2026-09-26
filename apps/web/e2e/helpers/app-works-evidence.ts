/**
 * Verification-evidence builder for the App Works acceptance harness
 * (APW-13 T11, `docs/specs/features/app-works/APW-13-golden-paths/tasks.md:163-174`).
 *
 * ## The authoritative schema is external to this monorepo
 *
 * Evidence files are `evidence/<blueprint-id>/<runId>.json` in the **Apps
 * catalog repository** — plan §3.1, `plan.md:135` (the JSON example at
 * `plan.md:143`) — and the schema they are validated against is drafted there
 * by T61 (`tasks.md:697`):
 *
 *     ever-works/templates/schema/evidence.schema.json
 *     https://github.com/ever-works/templates/blob/main/schema/evidence.schema.json
 *     https://raw.githubusercontent.com/ever-works/templates/main/schema/evidence.schema.json
 *
 * That repository is checked out separately from this monorepo and may not
 * exist yet when a lane runs, so this module cannot import or read the schema
 * file. {@link validateEvidence} is therefore a small **local structural
 * validator** that enforces the same required set and the same two enum rules
 * T61 states — object; required `blueprint`/`upstream`/`license`/`platform`/
 * `lane`/`passCount`/`runId`/`startedAt`/`steps`/`spend`; `upstream.kind` ∈
 * `pin | canary`; `license.class` ∈ `green | amber | red | unknown`;
 * `passCount` an integer ≥ 1 (`tasks.md:698-700`, `plan.md:159-163`). The three
 * fields the catalog's status rules read — `license.class`, `passCount`,
 * `upstream.kind` (FR-57) — are required here, so a file missing one fails
 * before it reaches a pull request. The published schema stays the authority;
 * when T61 lands a stricter rule, this validator is the one place to widen.
 *
 * ## The other two jobs of this module
 *
 *   - **The lane summary table** of spec §6.2 (`spec.md:479-483`): scenario id ·
 *     step · result · duration · first failing observation · evidence link,
 *     then the spend line **against budget**, then what was left behind for
 *     investigation. A run over budget is marked with reason `budget`
 *     (ACC-13-16, `spec.md:549`); the interlock that refuses to *start* an
 *     over-budget run is T8's, this module only reports.
 *   - **An artefact secret scan before upload** (ACC-13-16, ACC-13-23,
 *     `spec.md:549,572`): {@link prepareArtefactForUpload} is the gate an
 *     upload call site goes through, and {@link writeEvidence} scans the
 *     serialized evidence file itself. An artefact carrying a known secret
 *     fails with reason `secret_in_artefact` — snake_case, matching the S19/S20
 *     reason vocabulary (`dispatch_unavailable`, `pull_credential_unavailable`).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Where the evidence files live in the catalog repository (plan §3.1). */
export const EVIDENCE_DIRECTORY = 'evidence';

/** The `schema` field every evidence file carries (plan §3.1, `plan.md:143`). */
export const EVIDENCE_SCHEMA_PATH = 'ever-works/templates/schema/evidence.schema.json';

/** The authority's browsable URL, for a reader who has to check a field. */
export const EVIDENCE_SCHEMA_URL =
    'https://github.com/ever-works/templates/blob/main/schema/evidence.schema.json';

/** The authority's raw URL, for a future fetch-based validation. */
export const EVIDENCE_SCHEMA_RAW_URL =
    'https://raw.githubusercontent.com/ever-works/templates/main/schema/evidence.schema.json';

/**
 * The required top-level fields, in T61's order (`tasks.md:698-700`). Exported
 * so a spec asserts against the plan's set rather than restating it.
 */
export const EVIDENCE_REQUIRED_FIELDS = [
    'blueprint',
    'upstream',
    'license',
    'platform',
    'lane',
    'passCount',
    'runId',
    'startedAt',
    'steps',
    'spend',
] as const;

/** `license.class` vocabulary (T61, `tasks.md:700`). */
export const LICENSE_CLASSES = ['green', 'amber', 'red', 'unknown'] as const;

/** `upstream.kind` vocabulary (T61, `tasks.md:700`). */
export const UPSTREAM_KINDS = ['pin', 'canary'] as const;

/** The result vocabulary of spec §6.2 (`spec.md:481`). */
export const LANE_RESULT_KINDS = ['pass', 'fail', 'not reached', 'skipped'] as const;

/** `public` or a private read-only pull path (T68, ACC-13-24). */
export const IMAGE_PULL_PATHS = ['public-package', 'read-only-pull-token'] as const;

export type LicenseClass = (typeof LICENSE_CLASSES)[number];
export type UpstreamKind = (typeof UPSTREAM_KINDS)[number];
export type LaneResultKind = (typeof LANE_RESULT_KINDS)[number];
export type ImagePullPath = (typeof IMAGE_PULL_PATHS)[number];

export interface EvidenceBlueprint {
    id: string;
    version: string;
    sha: string;
}

export interface EvidenceUpstream {
    repo: string;
    sha: string;
    kind: UpstreamKind;
}

export interface EvidenceLicense {
    spdx: string;
    class: LicenseClass;
}

export interface EvidencePlatform {
    environment: string;
    version: string;
}

export interface EvidenceStep {
    /** Scenario id, e.g. `ACC-13-07`. */
    id: string;
    /** A §6.2 result: `pass`, `fail`, `not reached` or `skipped[: reason]`. */
    result: string;
    seconds?: number;
    observation?: string;
    evidenceUrl?: string;
}

export interface EvidenceSpend {
    actionsMinutes: number;
    tokens: number;
}

/** The evidence file of plan §3.1 (`plan.md:143`). */
export interface Evidence {
    schema: string;
    blueprint: EvidenceBlueprint;
    upstream: EvidenceUpstream;
    license: EvidenceLicense;
    platform: EvidencePlatform;
    lane: string;
    passCount: number;
    runId: string;
    startedAt: string;
    finishedAt?: string;
    steps: EvidenceStep[];
    spend: EvidenceSpend;
    evidenceUrl?: string;
    /** Which pull path the lane used, when it asserted one (T68, ACC-13-24). */
    imagePull?: { path: ImagePullPath; packageRef: string };
    /** Managed-hosting eligibility from the constraint lint (T69, FR-63). */
    managedHosting?: { eligible: boolean; findings: string[] };
}

export interface ValidationResult {
    ok: boolean;
    errors: string[];
}

/** Raised for a shape/validation failure, carrying the module's reason token. */
export class EvidenceError extends Error {
    readonly reason: string;
    readonly errors: string[];

    constructor(message: string, reason: string, errors: string[] = []) {
        super(message);
        this.name = 'EvidenceError';
        this.reason = reason;
        this.errors = errors;
    }
}

export interface ArtefactScanFinding {
    /** The known value that was found. */
    secret: string;
    /** Byte/character offset of its first occurrence. */
    at: number;
}

export interface ArtefactScanResult {
    ok: boolean;
    findings: ArtefactScanFinding[];
    /** How many bytes of artefact were searched. */
    bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function checkObject(errors: string[], value: unknown, path: string): void {
    if (!isRecord(value)) errors.push(`${path}: must be an object`);
}

/**
 * The local structural validator. Returns every failure rather than the first,
 * so a lane reports all of them at once.
 */
export function validateEvidence(value: unknown): ValidationResult {
    const errors: string[] = [];
    if (!isRecord(value)) {
        return { ok: false, errors: ['evidence: must be an object'] };
    }

    for (const field of EVIDENCE_REQUIRED_FIELDS) {
        if (value[field] === undefined) errors.push(`${field}: is required`);
    }
    if (value.schema !== undefined && !isNonEmptyString(value.schema)) {
        errors.push('schema: must be a non-empty string when present');
    }

    checkObject(errors, value.blueprint, 'blueprint');
    if (isRecord(value.blueprint)) {
        if (!isNonEmptyString(value.blueprint.id)) errors.push('blueprint.id: must be a string');
        if (!isNonEmptyString(value.blueprint.version)) {
            errors.push('blueprint.version: must be a string');
        }
        if (!isNonEmptyString(value.blueprint.sha)) errors.push('blueprint.sha: must be a string');
    }

    checkObject(errors, value.upstream, 'upstream');
    if (isRecord(value.upstream)) {
        if (!isNonEmptyString(value.upstream.repo)) errors.push('upstream.repo: must be a string');
        if (!isNonEmptyString(value.upstream.sha)) errors.push('upstream.sha: must be a string');
        const kind = value.upstream.kind;
        if (kind === undefined) {
            errors.push('upstream.kind: is required');
        } else if (!UPSTREAM_KINDS.includes(kind as UpstreamKind)) {
            errors.push(
                `upstream.kind: must be one of ${UPSTREAM_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`,
            );
        }
    }

    checkObject(errors, value.license, 'license');
    if (isRecord(value.license)) {
        if (!isNonEmptyString(value.license.spdx)) errors.push('license.spdx: must be a string');
        const licenseClass = value.license.class;
        if (licenseClass === undefined) {
            errors.push('license.class: is required');
        } else if (!LICENSE_CLASSES.includes(licenseClass as LicenseClass)) {
            errors.push(
                `license.class: must be one of ${LICENSE_CLASSES.join(' | ')}, got ${JSON.stringify(
                    licenseClass,
                )}`,
            );
        }
    }

    checkObject(errors, value.platform, 'platform');
    if (isRecord(value.platform)) {
        if (!isNonEmptyString(value.platform.environment)) {
            errors.push('platform.environment: must be a string');
        }
        if (!isNonEmptyString(value.platform.version)) {
            errors.push('platform.version: must be a string');
        }
    }

    if (!isNonEmptyString(value.lane)) errors.push('lane: must be a non-empty string');
    if (!isNonEmptyString(value.runId)) errors.push('runId: must be a non-empty string');
    if (!isNonEmptyString(value.startedAt)) errors.push('startedAt: must be a string');
    if (value.finishedAt !== undefined && !isNonEmptyString(value.finishedAt)) {
        errors.push('finishedAt: must be a string when present');
    }

    const passCount = value.passCount;
    if (passCount !== undefined) {
        if (typeof passCount !== 'number' || !Number.isInteger(passCount) || passCount < 1) {
            errors.push(`passCount: must be an integer >= 1, got ${JSON.stringify(passCount)}`);
        }
    }

    if (value.steps === undefined) {
        // Reported by the required-field loop above; nothing to add.
    } else if (!Array.isArray(value.steps)) {
        errors.push('steps: must be an array');
    } else {
        value.steps.forEach((step, index) => {
            if (!isRecord(step)) {
                errors.push(`steps[${index}]: must be an object`);
                return;
            }
            if (!isNonEmptyString(step.id)) errors.push(`steps[${index}].id: must be a string`);
            if (!isNonEmptyString(step.result)) {
                errors.push(`steps[${index}].result: must be a §6.2 result`);
            } else if (!isLaneResult(step.result)) {
                errors.push(
                    `steps[${index}].result: must start with one of ${LANE_RESULT_KINDS.join(
                        ' | ',
                    )}, got ${JSON.stringify(step.result)}`,
                );
            }
            if (step.seconds !== undefined && typeof step.seconds !== 'number') {
                errors.push(`steps[${index}].seconds: must be a number when present`);
            }
        });
    }

    if (value.spend !== undefined) {
        if (!isRecord(value.spend)) {
            errors.push('spend: must be an object');
        } else {
            for (const field of ['actionsMinutes', 'tokens'] as const) {
                const amount = value.spend[field];
                if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
                    errors.push(
                        `spend.${field}: must be a non-negative number, got ${JSON.stringify(
                            amount,
                        )}`,
                    );
                }
            }
        }
    }

    // Unknown fields are tolerated on purpose: the published schema is the
    // authority, and the epic's later tasks add fields to the file (`imagePull`
    // for T68, `managedHosting` for T69) that T61's draft may not carry yet.
    return { ok: errors.length === 0, errors };
}

/** `pass` / `fail` / `not reached` / `skipped[: reason]` (spec §6.2). */
export function isLaneResult(result: string): boolean {
    const value = String(result).trim().toLowerCase();
    return LANE_RESULT_KINDS.some((kind) => value === kind || value.startsWith(`${kind}:`));
}

/** The §6.2 kind of a step result, with its `skipped` reason when it has one. */
export function laneResultOf(result: string): { kind: LaneResultKind; reason?: string } {
    const value = String(result).trim();
    const lower = value.toLowerCase();
    const kind = LANE_RESULT_KINDS.find(
        (candidate) => lower === candidate || lower.startsWith(`${candidate}:`),
    );
    if (!kind) {
        throw new EvidenceError(
            `evidence: ${JSON.stringify(result)} is not a §6.2 result (${LANE_RESULT_KINDS.join(
                ' | ',
            )})`,
            'invalid_result',
        );
    }
    const reason = lower.startsWith(`${kind}:`) ? value.slice(kind.length + 1).trim() : undefined;
    return reason ? { kind, reason } : { kind };
}

/** Throwing form of {@link validateEvidence}. */
export function assertEvidence(value: unknown): Evidence {
    const result = validateEvidence(value);
    if (!result.ok) {
        throw new EvidenceError(
            `evidence: ${result.errors.length} field(s) invalid — ${result.errors.join('; ')}`,
            'invalid_evidence',
            result.errors,
        );
    }
    return value as Evidence;
}

export interface BuildEvidenceInput extends Omit<Evidence, 'schema' | 'spend' | 'steps'> {
    spend: EvidenceSpend;
    steps: EvidenceStep[];
    schema?: string;
}

/**
 * Assemble the §3.1 object, always stamping the `schema` field, and refuse to
 * return one that does not validate — so a file missing `license.class`,
 * `passCount` or `upstream.kind` cannot be built, let alone written.
 */
export function buildEvidence(input: BuildEvidenceInput): Evidence {
    return assertEvidence({
        ...input,
        schema: input.schema ?? EVIDENCE_SCHEMA_PATH,
        steps: input.steps.map((step) => ({ ...step })),
    });
}

/** `evidence/<blueprint-id>/<runId>.json` under `root` (plan §3.1). */
export function evidencePathFor(blueprintId: string, runId: string, root?: string): string {
    const id = String(blueprintId ?? '').trim();
    const run = String(runId ?? '').trim();
    if (!id)
        throw new EvidenceError(
            'evidence: `blueprint.id` is required for the path',
            'invalid_evidence',
        );
    if (!run)
        throw new EvidenceError('evidence: `runId` is required for the path', 'invalid_evidence');
    const base = resolve(root ?? process.env.APW_E2E_EVIDENCE_ROOT ?? process.cwd());
    return join(base, EVIDENCE_DIRECTORY, id, `${run}.json`);
}

/** Parse and validate one evidence file. Never throws for a bad *file*. */
export async function readEvidenceFile(
    path: string,
): Promise<ValidationResult & { evidence?: Evidence }> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        return { ok: false, errors: [`${path}: cannot be read (${(error as Error).message})`] };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (error) {
        return { ok: false, errors: [`${path}: is not JSON (${(error as Error).message})`] };
    }
    const result = validateEvidence(parsed);
    return result.ok ? { ...result, evidence: parsed as Evidence } : result;
}

export interface WriteEvidenceOptions {
    /** Directory the `evidence/` tree hangs under; defaults to the cwd. */
    root?: string;
    /**
     * Known secret values to scan the serialized file for before writing.
     * Defaults to {@link environmentSecretValues}; pass the run's full
     * redaction list (T8's `redact` list) when it has one.
     */
    secrets?: readonly string[];
    /** Indentation; 4 spaces, matching the repository's prettier config. */
    indent?: number;
}

export interface WrittenEvidence {
    path: string;
    bytes: number;
    /** The scan result the write passed through. */
    scan: ArtefactScanResult;
}

/**
 * Validate, scan, then write `evidence/<blueprint-id>/<runId>.json`.
 *
 * Order matters: the file is scanned for known secrets **before** it exists, so
 * a leaked value never reaches a commit or an upload (ACC-13-16, ACC-13-23).
 */
export async function writeEvidence(
    evidence: Evidence,
    options: WriteEvidenceOptions = {},
): Promise<WrittenEvidence> {
    assertEvidence(evidence);
    const json = `${JSON.stringify(evidence, null, options.indent ?? 4)}\n`;
    const scan = scanArtefact(json, options.secrets ?? environmentSecretValues());
    if (!scan.ok) {
        throw new EvidenceError(
            `evidence: refusing to write ${evidencePathFor(
                evidence.blueprint.id,
                evidence.runId,
                options.root,
            )} — ${scan.findings.length} known secret value(s) in the evidence file ` +
                `(reason: secret_in_artefact)`,
            'secret_in_artefact',
        );
    }
    const path = evidencePathFor(evidence.blueprint.id, evidence.runId, options.root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, json, 'utf8');
    return { path, bytes: Buffer.byteLength(json, 'utf8'), scan };
}

/**
 * Values this process should treat as secrets: every `APW_E2E_*` variable
 * whose *name* says it holds one. T8's `redact()` owns the authoritative
 * redaction list for logs and traces; this is the scan default for artefacts,
 * kept here so an evidence write is safe even when a lane forgets to pass a
 * list. Non-secret lane inputs (`APW_E2E_RUN_ID`, `APW_E2E_LANE`, budgets,
 * repository names) are deliberately excluded — the evidence file carries
 * those by design, and treating them as secrets would fail every write.
 */
export function environmentSecretValues(): string[] {
    const secretish =
        /TOKEN|SECRET|PASSWORD|HONEYTOKEN|APIKEY|API_KEY|PRIVATE_KEY|KUBECONFIG|CREDENTIAL/i;
    return Array.from(
        new Set(
            Object.entries(process.env)
                .filter(([name, value]) => name.startsWith('APW_E2E_') && secretish.test(name))
                .map(([, value]) => String(value ?? ''))
                .filter((value) => value.trim().length >= 6),
        ),
    );
}

/** Search an artefact for known secret values (ACC-13-16, ACC-13-23). */
export function scanArtefact(
    artefact: string | Uint8Array,
    secrets: readonly string[],
): ArtefactScanResult {
    const text = typeof artefact === 'string' ? artefact : Buffer.from(artefact).toString('utf8');
    const findings: ArtefactScanFinding[] = [];
    for (const secret of new Set(secrets.map((value) => String(value)))) {
        if (secret.trim().length === 0) continue;
        const at = text.indexOf(secret);
        if (at >= 0) findings.push({ secret, at });
    }
    return { ok: findings.length === 0, findings, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Throwing form of {@link scanArtefact}, with reason `secret_in_artefact`. */
export function assertArtefactClean(
    artefact: string | Uint8Array,
    secrets: readonly string[],
): ArtefactScanResult {
    const scan = scanArtefact(artefact, secrets);
    if (!scan.ok) {
        throw new EvidenceError(
            `evidence: artefact carries ${scan.findings.length} known secret value(s) ` +
                `(reason: secret_in_artefact, ACC-13-16)`,
            'secret_in_artefact',
        );
    }
    return scan;
}

export interface ArtefactAttachment {
    name: string;
    content: string | Uint8Array;
}

/**
 * The gate an upload goes through: returns the attachment and its scan only
 * when nothing in it matches a known value, and throws with reason
 * `secret_in_artefact` otherwise. A call site that uploads without this step is
 * the defect ACC-13-16 names ("no secret in an artefact").
 */
export function prepareArtefactForUpload(
    attachment: ArtefactAttachment,
    secrets: readonly string[],
): { attachment: ArtefactAttachment; scan: ArtefactScanResult } {
    const scan = assertArtefactClean(attachment.content, secrets);
    return { attachment, scan };
}

export interface LaneBudget {
    actionsMinutes: number;
    tokens: number;
}

export interface BudgetVerdict {
    exceeded: boolean;
    /** The §6.2 failure reason; `budget` when either dimension is over. */
    reason: 'budget' | null;
    over: { actionsMinutes: boolean; tokens: boolean };
}

/**
 * Spend against budget (ACC-13-16, `spec.md:549`). The reason is the literal
 * `budget`; the interlock that refuses to *start* over budget is T8's, this
 * only reports the verdict the summary prints.
 */
export function budgetExceeded(spend: EvidenceSpend, budget: LaneBudget): BudgetVerdict {
    const over = {
        actionsMinutes: spend.actionsMinutes > budget.actionsMinutes,
        tokens: spend.tokens > budget.tokens,
    };
    const exceeded = over.actionsMinutes || over.tokens;
    return { exceeded, reason: exceeded ? 'budget' : null, over };
}

export interface LaneSummaryRow {
    /** Scenario id, e.g. `ACC-13-07`. */
    scenarioId: string;
    step: string;
    /** A §6.2 result: `pass`, `fail`, `not reached` or `skipped: reason`. */
    result: string;
    /** Duration in seconds. */
    seconds?: number;
    /** On a failed step, the **first failing observation** (§6.2). */
    observation?: string;
    evidenceUrl?: string;
}

export interface LeftBehind {
    kind: 'namespace' | 'repository' | string;
    name: string;
    /** ISO 8601 instant the object expires. */
    expiresAt?: string;
}

export interface LaneSummaryInput {
    rows: LaneSummaryRow[];
    spend: EvidenceSpend;
    budget: LaneBudget;
    /** Namespaces and repositories the run left for investigation (§6.2). */
    leftBehind?: LeftBehind[];
    evidenceUrl?: string;
}

function cell(value: string | undefined): string {
    const text = value === undefined || value === '' ? '—' : value;
    return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * The run summary of spec §6.2 (`spec.md:479-483`), as markdown: one table for
 * the run, the spend line against budget, and what was left behind.
 */
export function laneSummaryTable(input: LaneSummaryInput): string {
    const lines: string[] = [];
    lines.push('| Scenario | Step | Result | Duration | First failing observation | Evidence |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of input.rows) {
        // The Result column is normalised through the §6.2 vocabulary, so a
        // summary can never label a step with a result the spec does not have.
        const parsed = laneResultOf(row.result);
        const result = parsed.reason ? `${parsed.kind}: ${parsed.reason}` : parsed.kind;
        lines.push(
            `| ${cell(row.scenarioId)} | ${cell(row.step)} | ${cell(result)} | ${cell(
                row.seconds === undefined ? undefined : `${row.seconds} s`,
            )} | ${cell(row.observation)} | ${cell(row.evidenceUrl ?? input.evidenceUrl)} |`,
        );
    }

    const verdict = budgetExceeded(input.spend, input.budget);
    lines.push('');
    lines.push(
        `**Spend: ${input.spend.actionsMinutes} / ${input.budget.actionsMinutes} Actions minutes · ` +
            `${input.spend.tokens} / ${input.budget.tokens} tokens**`,
    );
    if (verdict.exceeded) {
        const over = Object.entries(verdict.over)
            .filter(([, isOver]) => isOver)
            .map(([dimension]) => dimension)
            .join(', ');
        lines.push(`**Run failed: reason \`${verdict.reason}\`** (over: ${over})`);
    }

    lines.push('');
    lines.push('**Left behind for investigation**');
    const left = input.leftBehind ?? [];
    if (left.length === 0) {
        lines.push('- nothing left behind');
    } else {
        for (const item of left) {
            lines.push(
                `- \`${item.kind}\` \`${item.name}\`${
                    item.expiresAt ? ` — expires ${item.expiresAt}` : ' — no expiry recorded'
                }`,
            );
        }
    }

    return lines.join('\n');
}
