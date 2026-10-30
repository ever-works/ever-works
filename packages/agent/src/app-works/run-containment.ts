import {
    APP_RUN_CONTAINMENT_ALLOWANCES_MAX,
    normalizeFleetAgentTaskContainment,
    type AppRunContainmentAllowance,
    type AppWorkRunContainment,
    type FleetAgentTaskContainment,
} from '@ever-works/contracts';

/**
 * APW-08 T48 (XC-06, SK-14, GAP-21; FR-12, FR-70) — the containment a Fleet run got, the owner's
 * per-node allowance of a downgrade, and the pure admission predicate T12 calls for a `'fleet'`
 * placement.
 *
 * ## What containment is, and what it is not
 *
 * A node reports, on every `agent-task` result, what its model step actually got
 * (`FleetAgentTaskContainment`, self-build slice AK): which executor ran it, whether the per-run
 * isolated HOME applied, and every control that did not apply (a downgrade). Containment is
 * environment construction only — `isolated-home.ts` redirects the home anchors of ONE process —
 * so it is not a filesystem boundary and carries no egress control. An accepted downgrade
 * therefore never widens the Agent's tools, protected paths, merge policy or target branch.
 *
 * **Setup steps and App checks run with the machine's REAL home and toolchain** on a Fleet node
 * (FR-13): this record covers the model step and never those. FR-14's per-check admission by the
 * owner — not containment — is their control.
 *
 * ## The gate
 *
 * A `'fleet'` placement is admitted only while the node's latest report shows `isolatedHome ===
 * true` and no `isolated-home` downgrade. Anything else — a downgrade, a false `isolatedHome`, a
 * record that could not be read, or no record at all — is `needs_input`: the Task shows
 * `appRules.containmentDowngrade` with **Allow on this machine**, and the owner's allowance (one
 * per node, per App Work, withdrawable) admits it until withdrawn. `hardened` vs `ordinary` does
 * not decide admission: every node today runs the ordinary path, and the standing
 * `process-containment` / `network-egress` / `toolchain-anchors` downgrades are honest facts of
 * EVERY run, not a reason to refuse one (T48: "hardened and ordinary both admitted when
 * isolatedHome is true").
 *
 * 🛑 A leaf: `@ever-works/contracts` only, so the dispatch path, the reconciler's recorder and
 * the cloud worker's pre-flight can all import it without a cycle.
 */

/** The downgrade control that gates admission (the one the owner can accept). */
export const ISOLATED_HOME_CONTROL = 'isolated-home';

/**
 * T48 — does this record need the owner's allowance before a new App Work run may use the node?
 * False-only (`isolatedHome !== true`) or an `isolated-home` downgrade. `null` (no readable
 * record) needs it too: an unknown containment is treated as a downgrade (T12).
 */
export function needsOwnerAllowance(
    containment: Pick<FleetAgentTaskContainment, 'isolatedHome' | 'downgrades'> | null | undefined,
): boolean {
    if (!containment) return true;
    if (containment.isolatedHome !== true) return true;
    return (containment.downgrades ?? []).some((entry) => entry?.control === ISOLATED_HOME_CONTROL);
}

/**
 * The plan §3.4 record from whatever a node sent, or `null` when nothing readable was sent.
 *
 * ALWAYS through `normalizeFleetAgentTaskContainment`, even for a value that already looks
 * normalized: the normalizer is the one place every coercion resolves toward LESS containment (an
 * unknown executor reads `ordinary`, `isolatedHome` is true only for a literal `true`, a missing
 * `isolated-home` downgrade is synthesised), and a second reader that trusted the raw shape
 * would be the over-report it exists to prevent. `localSessionHome` is dropped: it is an absolute
 * path on the owner's machine, useful to an operator on the node, not to the Task page.
 */
export function toAppWorkRunContainment(raw: unknown): AppWorkRunContainment | null {
    const normalized = normalizeFleetAgentTaskContainment(raw);
    if (!normalized) return null;
    return {
        executionPath: normalized.executionPath,
        isolatedHome: normalized.isolatedHome,
        downgrades: normalized.downgrades.map((entry) => ({
            control: entry.control,
            reason: entry.reason,
        })),
        needsOwnerAllowance: needsOwnerAllowance(normalized),
    };
}

/**
 * The record a run carries (`agent_runs.containment`): the plan §3.4 record plus the node that
 * produced it and when. The node id is what the Task page's **Allow on this machine** names.
 */
export interface AgentRunContainmentRecord extends AppWorkRunContainment {
    nodeId: string | null;
    reportedAt: string;
}

/** Read a stored run record back without trusting it (the column is `simple-json`). */
export function readAgentRunContainmentRecord(raw: unknown): AgentRunContainmentRecord | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const input = raw as Record<string, unknown>;
    const containment = toAppWorkRunContainment(input);
    if (!containment) return null;
    const nodeId =
        typeof input.nodeId === 'string' && input.nodeId.trim().length > 0
            ? input.nodeId.trim()
            : null;
    const reportedAt =
        typeof input.reportedAt === 'string' && Number.isFinite(Date.parse(input.reportedAt))
            ? new Date(input.reportedAt).toISOString()
            : new Date(0).toISOString();
    return { ...containment, nodeId, reportedAt };
}

// ── The allowance store (EW-807 pattern) ─────────────────────────────────────

/**
 * The Work's allowances, read without trusting the column (`simple-json` holds whatever was
 * written). An entry without a usable node id is dropped — it could only ever admit nothing — and
 * duplicates collapse to the first, so one node is never allowed "twice" by accident.
 */
export function normalizeAppRunContainmentAllowances(raw: unknown): AppRunContainmentAllowance[] {
    if (!Array.isArray(raw)) return [];
    const out: AppRunContainmentAllowance[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : '';
        if (!nodeId || seen.has(nodeId)) continue;
        seen.add(nodeId);
        out.push({
            nodeId,
            allowedAt: typeof record.allowedAt === 'string' ? record.allowedAt : '',
            allowedBy: typeof record.allowedBy === 'string' ? record.allowedBy : '',
            acceptedDowngrade:
                typeof record.acceptedDowngrade === 'string' ? record.acceptedDowngrade : null,
        });
        if (out.length >= APP_RUN_CONTAINMENT_ALLOWANCES_MAX) break;
    }
    return out;
}

/** Is this node allowed on this Work? Exact node id only — never implied by another node. */
export function isNodeContainmentAllowed(
    allowances: readonly AppRunContainmentAllowance[],
    nodeId: string | null | undefined,
): boolean {
    if (!nodeId) return false;
    return allowances.some((entry) => entry.nodeId === nodeId);
}

/**
 * The store after one owner action: `allow` ADDS the node (idempotent — an existing entry keeps
 * its original time and author, the way a second pause keeps the first note), `!allow` REMOVES it
 * (withdrawing an allowance that does not exist is a no-op). Every other node's entry is kept.
 */
export function applyAppRunContainmentAllowance(
    current: readonly AppRunContainmentAllowance[],
    change: {
        nodeId: string;
        allow: boolean;
        actorUserId: string;
        at: Date;
        acceptedDowngrade: string | null;
    },
): AppRunContainmentAllowance[] {
    const others = current.filter((entry) => entry.nodeId !== change.nodeId);
    if (!change.allow) return others;
    const existing = current.find((entry) => entry.nodeId === change.nodeId);
    if (existing) return [...current];
    if (others.length >= APP_RUN_CONTAINMENT_ALLOWANCES_MAX) return [...current];
    return [
        ...others,
        {
            nodeId: change.nodeId,
            allowedAt: change.at.toISOString(),
            allowedBy: change.actorUserId,
            acceptedDowngrade: change.acceptedDowngrade,
        },
    ];
}

/** The `isolated-home` reason a record carries, for the allowance's display snapshot. */
export function isolatedHomeDowngradeReason(
    containment: Pick<AppWorkRunContainment, 'downgrades'> | null | undefined,
): string | null {
    return (
        containment?.downgrades.find((entry) => entry.control === ISOLATED_HOME_CONTROL)?.reason ??
        null
    );
}

// ── The pure admission predicate (T12 calls it for a 'fleet' placement) ──────

/**
 * The node id a candidate carries when the owner's node list could not be read at all: it holds
 * the run (fail closed) and names nothing an owner could allow.
 */
export const UNREADABLE_FLEET_NODE = 'fleet-nodes-unreadable';

/** One candidate node's facts, as the fleet branch of the T12 predicate reads them. */
export interface FleetNodeContainmentFacts {
    nodeId: string;
    /** The node's latest readable report, or `null` (never reported / unreadable = unknown). */
    containment: AppWorkRunContainment | null;
    /** The owner allows this node's downgrade on this App Work. */
    allowed: boolean;
}

/** Is ONE node admissible: an isolated home with no `isolated-home` downgrade, or allowed? */
export function isNodeContainmentAdmissible(
    candidate: Pick<FleetNodeContainmentFacts, 'containment' | 'allowed'>,
): boolean {
    if (candidate.containment && !candidate.containment.needsOwnerAllowance) return true;
    return candidate.allowed === true;
}

export type FleetContainmentAdmission =
    | { admitted: true; nodeId: string }
    | {
          admitted: false;
          /** The first node that holds the run; `null` = no node could take it at all. */
          nodeId: string | null;
          containment: AppWorkRunContainment | null;
      };

/** Type guard for a held answer (explicit: see `isAppWorkRunRefusal`). */
export function isFleetContainmentHeld(
    admission: FleetContainmentAdmission,
): admission is Extract<FleetContainmentAdmission, { admitted: false }> {
    return admission.admitted === false;
}

/**
 * T48's predicate at DISPATCH: can any node that could take the run take it?
 *
 * Admitted when at least one candidate is admissible — an isolated home with no `isolated-home`
 * downgrade, or a downgrade the owner allowed for that node. That is safe because dispatch is not
 * the last word: the LEASE judges the node that actually takes the job
 * (`FleetAppWorkLeaseAdmission`), so a downgraded sibling is never offered it, and a run the
 * platform could steer to an admissible node is not refused on account of a node that will not
 * get it. Every candidate held → the first is named, so the Task offers **Allow on this machine**
 * for it.
 *
 * NO candidate at all is NOT admitted (review of #3040): with no node able to take it, routing
 * still answers `fleet-waiting`, and a machine enrolled later (never reported) or a downgraded
 * node unpaused later would be the one to lease it. The caller holds such a run (`needs_input`).
 */
export function admitFleetContainment(
    candidates: readonly FleetNodeContainmentFacts[],
): FleetContainmentAdmission {
    if (candidates.length === 0) return { admitted: false, nodeId: null, containment: null };
    const admissible = candidates.find((candidate) => isNodeContainmentAdmissible(candidate));
    if (admissible) return { admitted: true, nodeId: admissible.nodeId };
    return {
        admitted: false,
        nodeId: candidates[0].nodeId,
        containment: candidates[0].containment,
    };
}
