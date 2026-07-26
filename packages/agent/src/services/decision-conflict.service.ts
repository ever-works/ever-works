import { Injectable, Logger } from '@nestjs/common';
import type {
    DecisionConflictDto,
    DecisionConflictReportDto,
    DecisionConflictSignal,
} from '@ever-works/contracts';
import { KbDecisionStatus, KbDocumentClass, KbReviewState } from '../entities/kb-types';
import { KnowledgeBaseService } from './knowledge-base.service';

/**
 * Re-litigation guard — memory upgrades M6.
 *
 * When a Task is created (or its description is edited), the platform
 * compares the Task's *intent* against the settled calls the org already
 * recorded: Knowledge Base documents with `class=decision` and
 * `decision.status=accepted`. Anything that looks like a restatement is
 * surfaced to the user as an informational banner.
 *
 * ## The heuristic (`term-overlap/v1`)
 *
 * v1 is DETERMINISTIC on purpose — no LLM judgement, no embeddings, no
 * network. The same input always produces the same flags, which is what
 * makes the feature safe to put in front of a user who is mid-typing.
 *
 * 1. **Candidates** come from the existing KB retrieval
 *    (`KnowledgeBaseService.listDocuments`, owner-scoped via
 *    `ensureCanView`) filtered to `class=decision`. Only documents whose
 *    `decision.status` is `accepted` AND whose `reviewState` is not
 *    `proposed` are scored — a proposal is not a settled call, and an
 *    unreviewed agent-authored doc is not yet part of the org's memory.
 * 2. **Terms** are extracted from free text by lowercasing, splitting on
 *    non-alphanumerics, dropping tokens shorter than
 *    {@link MIN_TERM_LENGTH}, dropping a small English stop-word list,
 *    and de-pluralizing a trailing `s` on tokens longer than 4 chars.
 *    The result is a SET, so repetition never inflates a score.
 * 3. **Scores** are two containment ratios, both in `0..1`:
 *      - `subjectCoverage`  = |overlap| / |decision title ∪ description terms|
 *      - `titleCoverage`    = |title overlap| / |decision title terms|
 *    and `score = max(subjectCoverage, titleCoverage)`.
 *    Containment (not Jaccard) is deliberate: a long Task description
 *    should not dilute the signal that it restates a one-line decision.
 * 4. **Thresholds** — a conflict needs at least
 *    {@link MIN_OVERLAP_TERMS} shared significant terms in every case,
 *    which is the single biggest false-positive suppressor:
 *      - `strong`   — `titleCoverage === 1` (the intent contains every
 *                     significant term of the decision's title) OR
 *                     `score >= 0.6`
 *      - `moderate` — `score >= 0.4`
 *      - otherwise  — not reported at all.
 *    Decisions or intents with fewer than {@link MIN_SUBJECT_TERMS}
 *    significant terms are skipped entirely: there is not enough text to
 *    judge, and guessing there is where noisy flags come from.
 *
 * The report is ADVISORY. This service never blocks, never mutates a
 * Task, and never transitions a decision — the caller renders it and the
 * user decides.
 */

/** Shortest token kept as a "significant" term. */
export const MIN_TERM_LENGTH = 3;

/** Minimum shared significant terms before anything is reported. */
export const MIN_OVERLAP_TERMS = 2;

/**
 * Minimum significant terms on BOTH sides before a comparison is even
 * attempted. Below this the ratios are dominated by a single token and
 * the flag would be noise.
 */
export const MIN_SUBJECT_TERMS = 2;

/** `score` at or above this (with the overlap floor) is a strong signal. */
export const STRONG_SCORE_THRESHOLD = 0.6;

/** `score` at or above this (with the overlap floor) is a moderate signal. */
export const MODERATE_SCORE_THRESHOLD = 0.4;

/** How many accepted decisions are pulled from KB retrieval and scored. */
export const CANDIDATE_LIMIT = 200;

/** How many conflicts are returned to the caller (highest score first). */
export const DEFAULT_MAX_CONFLICTS = 5;

/** Stable marker recorded on every report. */
export const DECISION_CONFLICT_HEURISTIC = 'term-overlap/v1';

/**
 * Small, deliberately boring English stop-word list. Kept inline (not a
 * dependency) so the heuristic has zero runtime surface and stays
 * reviewable in one screen. Words here are the ones that would otherwise
 * create overlap between two completely unrelated sentences.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'from',
    'into',
    'onto',
    'our',
    'their',
    'your',
    'its',
    'has',
    'have',
    'had',
    'was',
    'were',
    'are',
    'been',
    'being',
    'not',
    'but',
    'all',
    'any',
    'can',
    'will',
    'would',
    'should',
    'could',
    'must',
    'may',
    'might',
    'shall',
    'about',
    'after',
    'before',
    'when',
    'while',
    'where',
    'which',
    'what',
    'why',
    'how',
    'who',
    'whom',
    'than',
    'then',
    'there',
    'here',
    'each',
    'every',
    'some',
    'more',
    'most',
    'other',
    'such',
    'only',
    'own',
    'same',
    'too',
    'very',
    'just',
    'also',
    'now',
    'get',
    'got',
    'let',
    'via',
    'per',
    'use',
    'used',
    'using',
    'make',
    'made',
    'need',
    'needs',
    'want',
    'add',
    'new',
    'old',
    'task',
    'tasks',
    'work',
    'works',
    'please',
    'todo',
]);

/** Input for a single conflict check. */
export interface DecisionConflictInput {
    /**
     * Work whose Knowledge Base holds the candidate decisions. `null` /
     * `undefined` (a Task with no Work scope) short-circuits to an empty
     * report — decisions live in a Work's KB.
     */
    workId?: string | null;
    /** Caller — every candidate read is owner-scoped through the KB service. */
    userId: string;
    /** The intent's title (Task title). */
    title: string;
    /** The intent's body (Task description). Optional. */
    description?: string | null;
    /** Cap on returned conflicts. Defaults to {@link DEFAULT_MAX_CONFLICTS}. */
    maxConflicts?: number;
}

@Injectable()
export class DecisionConflictService {
    private readonly logger = new Logger(DecisionConflictService.name);

    constructor(private readonly kb: KnowledgeBaseService) {}

    /**
     * Score an intent against the accepted decisions in a Work's KB.
     *
     * Never throws for the "no signal" cases — a Task without a Work, a
     * Work without decisions, or a title too short to judge all return an
     * empty report. A KB read failure is logged and degraded to an empty
     * report too: the guard is advisory and must never break Task
     * creation.
     */
    async checkIntent(input: DecisionConflictInput): Promise<DecisionConflictReportDto> {
        const empty: DecisionConflictReportDto = {
            conflicts: [],
            scanned: 0,
            heuristic: DECISION_CONFLICT_HEURISTIC,
        };

        if (!input.workId) return empty;

        const intentTerms = extractTerms(`${input.title ?? ''} ${input.description ?? ''}`);
        if (intentTerms.size < MIN_SUBJECT_TERMS) return empty;

        let candidates: Awaited<ReturnType<KnowledgeBaseService['listDocuments']>>['items'];
        try {
            // Reuse the existing retrieval surface (owner-scoped via
            // `ensureCanView`) rather than reaching into the repository:
            // one authorization path, one place to change when the KB
            // list grows new semantics.
            const result = await this.kb.listDocuments(input.workId, input.userId, {
                class: KbDocumentClass.DECISION,
                limit: CANDIDATE_LIMIT,
            });
            candidates = result.items;
        } catch (error) {
            this.logger.warn(
                `Decision-conflict check skipped for work ${input.workId}: ${(error as Error).message}`,
            );
            return empty;
        }

        const accepted = candidates.filter(
            (doc) =>
                doc.decision?.status === KbDecisionStatus.ACCEPTED &&
                doc.reviewState !== KbReviewState.PROPOSED,
        );

        const conflicts: DecisionConflictDto[] = [];
        for (const doc of accepted) {
            const conflict = scoreDecision(doc, intentTerms);
            if (conflict) conflicts.push(conflict);
        }

        conflicts.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

        const max = input.maxConflicts ?? DEFAULT_MAX_CONFLICTS;
        return {
            conflicts: conflicts.slice(0, Math.max(0, max)),
            scanned: accepted.length,
            heuristic: DECISION_CONFLICT_HEURISTIC,
        };
    }
}

/**
 * Candidate shape the scorer needs. Declared structurally so the scoring
 * helpers stay unit-testable without constructing a full `KbDocumentDto`.
 */
interface ScorableDecision {
    id: string;
    path: string;
    slug: string;
    title: string;
    description: string | null;
    workId: string | null;
    updatedAt: string;
    decision?: { rationale?: string | null } | null;
}

/**
 * Split free text into the SET of significant terms used by the
 * heuristic. Exported for the spec + for any future caller that wants to
 * explain a flag to a user.
 */
export function extractTerms(text: string): Set<string> {
    const out = new Set<string>();
    if (!text) return out;
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < MIN_TERM_LENGTH) continue;
        if (STOP_WORDS.has(raw)) continue;
        // De-pluralize conservatively: only tokens long enough that the
        // trailing `s` is unlikely to be part of the stem.
        const stem = raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw;
        if (stem.length < MIN_TERM_LENGTH) continue;
        if (STOP_WORDS.has(stem)) continue;
        out.add(stem);
    }
    return out;
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const term of a) {
        if (b.has(term)) out.push(term);
    }
    return out;
}

/**
 * Apply `term-overlap/v1` to one accepted decision. Returns `null` when
 * the signal is below the moderate threshold (i.e. not reported).
 *
 * Exported so the thresholds can be exercised directly in unit tests
 * without a Nest DI container.
 */
export function scoreDecision(
    doc: ScorableDecision,
    intentTerms: ReadonlySet<string>,
): DecisionConflictDto | null {
    const titleTerms = extractTerms(doc.title ?? '');
    const subjectTerms = extractTerms(`${doc.title ?? ''} ${doc.description ?? ''}`);

    if (subjectTerms.size < MIN_SUBJECT_TERMS) return null;
    if (intentTerms.size < MIN_SUBJECT_TERMS) return null;

    const overlapTerms = intersect(subjectTerms, intentTerms);
    if (overlapTerms.length < MIN_OVERLAP_TERMS) return null;

    const subjectCoverage = overlapTerms.length / subjectTerms.size;
    const titleOverlap = intersect(titleTerms, intentTerms);
    const titleCoverage = titleTerms.size > 0 ? titleOverlap.length / titleTerms.size : 0;
    const score = Math.max(subjectCoverage, titleCoverage);

    let signal: DecisionConflictSignal | null = null;
    if (
        (titleCoverage === 1 && titleOverlap.length >= MIN_OVERLAP_TERMS) ||
        score >= STRONG_SCORE_THRESHOLD
    ) {
        signal = 'strong';
    } else if (score >= MODERATE_SCORE_THRESHOLD) {
        signal = 'moderate';
    }
    if (!signal) return null;

    return {
        documentId: doc.id,
        path: doc.path,
        slug: doc.slug,
        title: doc.title,
        workId: doc.workId ?? null,
        rationale: doc.decision?.rationale ?? null,
        decidedAt: doc.updatedAt,
        // Round so the wire value is stable across float noise.
        score: Math.round(score * 100) / 100,
        overlapTerms: overlapTerms.sort(),
        signal,
    };
}
