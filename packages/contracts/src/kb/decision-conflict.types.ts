/**
 * Re-litigation guard (memory upgrades M6) — wire types.
 *
 * A "conflict" is a DETERMINISTIC signal that a new (or freshly edited)
 * Task restates a subject the organization has already settled: an
 * `class=decision`, `decision.status=accepted` Knowledge Base document.
 * There is no LLM judgement in v1 — see
 * `DecisionConflictService` in `@ever-works/agent/services` for the
 * exact term-overlap heuristic and its thresholds.
 *
 * The report is ADVISORY. Nothing in the platform blocks, rejects, or
 * auto-transitions a Task because of it; the UI renders an informational
 * banner with links to the settled decisions and the user decides.
 */

/** Strength of a single deterministic conflict signal. */
export type DecisionConflictSignal = 'strong' | 'moderate';

/** One settled decision that the checked intent appears to re-open. */
export interface DecisionConflictDto {
	/** KB document id of the accepted decision. */
	documentId: string;
	/** Canonical `<class>/<slug>.md` path — used to build the KB link. */
	path: string;
	slug: string;
	title: string;
	/** Work that owns the decision (null for org-scope documents). */
	workId: string | null;
	/** One-line rationale recorded on the decision, when present. */
	rationale: string | null;
	/** ISO timestamp of the decision document's last update. */
	decidedAt: string;
	/** Normalized 0..1 overlap score (higher = more of the decision restated). */
	score: number;
	/** The significant terms shared by the intent and the decision. */
	overlapTerms: string[];
	signal: DecisionConflictSignal;
}

/**
 * Result of a conflict check. `heuristic` is a stable version marker so
 * a client (or a support conversation) can tell which rule produced a
 * given flag after the thresholds are re-tuned.
 */
export interface DecisionConflictReportDto {
	conflicts: DecisionConflictDto[];
	/** How many accepted decisions were scored. */
	scanned: number;
	/** Heuristic identifier, e.g. `term-overlap/v1`. */
	heuristic: string;
}
