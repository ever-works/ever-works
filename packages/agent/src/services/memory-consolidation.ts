/**
 * Memory Consolidation — pure helpers.
 *
 * An on-demand pass over the org-wide Memory feed (the aggregated
 * Knowledge Base across an Organization) that turns the append-only
 * document stream into a curated set: strong documents are PROMOTED,
 * near-duplicates are SUPERSEDED (marked, still readable — NEVER
 * deleted), and — when an AI provider is configured — duplicate
 * clusters are synthesized into a single merged document.
 *
 * This module is deliberately PURE (no IO, no NestJS, no module state)
 * — mirroring the posture of `kb-rrf.ts` / `kb-chunker.ts` — so every
 * scoring / grouping decision the consolidation run makes is unit
 * testable and fully explainable in the report. The orchestration
 * (loading documents, persisting markers, the LLM path) lives in
 * `memory-consolidation.service.ts`.
 */

/**
 * The `consolidation` marker persisted on `WorkKnowledgeDocument`
 * (nullable `simple-json` column). Absent / `null` = a normal document
 * untouched by consolidation.
 *
 * - `promoted` — selected into the curated top set by the latest run
 *   (or created by the run as a synthesis document). Cleared (set back
 *   to `null`) when a later run's top-N no longer includes the doc.
 * - `superseded` — a near-duplicate of `supersededById`. Sticky: a
 *   superseded document is never automatically resurrected; it stays
 *   readable but is visually muted in the Memory feed.
 */
export interface KbConsolidationMarker {
    state: 'promoted' | 'superseded';
    /** The surviving document this one was superseded by. */
    supersededById?: string;
    /** Human-readable explanation (shown as the badge tooltip). */
    reason: string;
    /** Promotion score at the time of the run (promoted only). */
    score?: number;
    /** ISO timestamp of the consolidation run that wrote this marker. */
    runAt: string;
}

/** Input shape for {@link scoreMemoryDocument}. */
export interface MemoryScoreInput {
    updatedAt: Date | string;
    /** Length of the document body in characters. */
    bodyLength: number;
    /** Number of tags on the document. */
    tagCount: number;
    /** True when the doc's class is always injected into agent context. */
    alwaysInject?: boolean;
    /** Number of citations referencing the document (usage signal). */
    citationCount?: number;
}

/** Result of {@link scoreMemoryDocument} — total plus per-part breakdown. */
export interface MemoryScoreResult {
    score: number;
    /** `recency` + `substance` + `organization` + `usage` — sums to `score`. */
    parts: Record<string, number>;
}

/** Input shape for {@link findDuplicateGroups}. */
export interface MemoryDuplicateInput {
    id: string;
    title: string;
    body: string;
    updatedAt: Date | string;
}

/** Maximum contribution of the recency part (fresh document). */
export const SCORE_RECENCY_WEIGHT = 40;
/** Half-life, in days, of the recency decay. */
export const SCORE_RECENCY_HALF_LIFE_DAYS = 30;
/** Maximum contribution of the substance (body length) part. */
export const SCORE_SUBSTANCE_WEIGHT = 25;
/** Points per tag for the organization part. */
export const SCORE_POINTS_PER_TAG = 3;
/** Tag count cap for the organization part (max 15 points). */
export const SCORE_TAG_CAP = 5;
/** Points per citation for the usage part. */
export const SCORE_POINTS_PER_CITATION = 2;
/** Citation count cap for the usage part (max 10 points). */
export const SCORE_CITATION_CAP = 5;
/** Flat usage bonus for always-injected classes (brand/legal/style/glossary). */
export const SCORE_ALWAYS_INJECT_BONUS = 10;

/** Word-shingle size used by {@link findDuplicateGroups}. */
export const DUPLICATE_SHINGLE_SIZE = 4;
/** Jaccard similarity threshold at/above which two bodies are near-duplicates. */
export const DUPLICATE_JACCARD_THRESHOLD = 0.85;

/** Default promotion set size for {@link selectPromotions}. */
export const DEFAULT_PROMOTION_LIMIT = 20;

/**
 * Transparent, ADDITIVE promotion score for one Memory document.
 *
 * Each part is independently capped and documented so the consolidation
 * report can explain WHY a document was promoted. The maximum total is
 * 100. Weights:
 *
 * - **recency** (0–40): exponential half-life decay —
 *   `40 × 0.5^(ageDays / 30)`. A document updated today scores ~40, one
 *   updated 30 days ago ~20, 90 days ago ~5. Future / invalid dates
 *   clamp to the cap / zero respectively (fresher = higher, capped).
 * - **substance** (0–25): log-scaled body length —
 *   `25 × min(1, log10(1 + bodyLength) / 4)`. Reaches the cap at
 *   ~10,000 characters; log scaling keeps a 100 KB dump from dwarfing a
 *   tight 2-page reference doc.
 * - **organization** (0–15): `3 × min(tagCount, 5)` — tagged documents
 *   are curated documents.
 * - **usage** (0–20): `2 × min(citationCount, 5)` for observed usage,
 *   plus a flat `+10` when the document's class is always injected into
 *   agent context (`alwaysInject`).
 *
 * Pure and deterministic: `now` defaults to the current time but can be
 * pinned by callers/tests for reproducible output.
 */
export function scoreMemoryDocument(
    doc: MemoryScoreInput,
    now: Date | string = new Date(),
): MemoryScoreResult {
    const nowMs = toEpochMs(now);
    const updatedMs = toEpochMs(doc.updatedAt);

    let recency = 0;
    if (nowMs !== null && updatedMs !== null) {
        const ageDays = (nowMs - updatedMs) / MS_PER_DAY;
        if (ageDays <= 0) {
            // Future timestamps (clock skew) clamp to the cap.
            recency = SCORE_RECENCY_WEIGHT;
        } else {
            recency = SCORE_RECENCY_WEIGHT * Math.pow(0.5, ageDays / SCORE_RECENCY_HALF_LIFE_DAYS);
        }
    }

    const bodyLength = Math.max(0, doc.bodyLength || 0);
    const substance = SCORE_SUBSTANCE_WEIGHT * Math.min(1, Math.log10(1 + bodyLength) / 4);

    const organization =
        SCORE_POINTS_PER_TAG * Math.min(Math.max(0, doc.tagCount || 0), SCORE_TAG_CAP);

    const usage =
        SCORE_POINTS_PER_CITATION *
            Math.min(Math.max(0, doc.citationCount ?? 0), SCORE_CITATION_CAP) +
        (doc.alwaysInject ? SCORE_ALWAYS_INJECT_BONUS : 0);

    const parts = { recency, substance, organization, usage };
    const score = recency + substance + organization + usage;
    return { score, parts };
}

/**
 * Near-duplicate detection over a set of Memory documents.
 *
 * Two documents are considered duplicates when EITHER:
 *  - their normalized titles are identical (case-folded, punctuation
 *    stripped, whitespace collapsed) and non-empty, OR
 *  - the Jaccard similarity of their body word-{@link DUPLICATE_SHINGLE_SIZE}-gram
 *    shingle sets is `>=` {@link DUPLICATE_JACCARD_THRESHOLD}.
 *
 * The pairwise relation is closed transitively (union-find), so chained
 * near-duplicates (A≈B, B≈C) collapse into one group. Only groups with
 * two or more members are returned.
 *
 * Ordering contract (drives supersede semantics in the service):
 *  - within a group, members are sorted NEWEST first (`updatedAt` desc,
 *    tie → `id` asc) — the first element is the SURVIVOR, the rest are
 *    supersede candidates (reason `near-duplicate of <survivor title>`);
 *  - groups themselves are sorted by survivor id asc, so the same input
 *    always produces the same output.
 *
 * Two documents with empty bodies are NOT considered body-duplicates
 * (an empty shingle set matches nothing); only a title match can group
 * them.
 */
export function findDuplicateGroups(docs: MemoryDuplicateInput[]): string[][] {
    const n = docs.length;
    if (n < 2) return [];

    const titles = docs.map((d) => normalizeText(d.title));
    const shingles = docs.map((d) => shingleSet(d.body));

    // Union-find over doc indexes.
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
        let root = i;
        while (parent[root] !== root) root = parent[root];
        while (parent[i] !== root) {
            const next = parent[i];
            parent[i] = root;
            i = next;
        }
        return root;
    };
    const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    };

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (titles[i].length > 0 && titles[i] === titles[j]) {
                union(i, j);
                continue;
            }
            const a = shingles[i];
            const b = shingles[j];
            if (a.size === 0 || b.size === 0) continue;
            // Size pre-filter: |A∩B| ≤ min(|A|,|B|) and |A∪B| ≥ max(|A|,|B|),
            // so Jaccard ≤ min/max — skip the set walk when it can't reach
            // the threshold.
            const minSize = Math.min(a.size, b.size);
            const maxSize = Math.max(a.size, b.size);
            if (minSize / maxSize < DUPLICATE_JACCARD_THRESHOLD) continue;
            if (jaccard(a, b) >= DUPLICATE_JACCARD_THRESHOLD) {
                union(i, j);
            }
        }
    }

    const byRoot = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        const members = byRoot.get(root);
        if (members) {
            members.push(i);
        } else {
            byRoot.set(root, [i]);
        }
    }

    const groups: string[][] = [];
    for (const members of byRoot.values()) {
        if (members.length < 2) continue;
        const sorted = [...members].sort((a, b) => {
            const ta = toEpochMs(docs[a].updatedAt) ?? 0;
            const tb = toEpochMs(docs[b].updatedAt) ?? 0;
            if (tb !== ta) return tb - ta; // newest first — the survivor
            return docs[a].id < docs[b].id ? -1 : docs[a].id > docs[b].id ? 1 : 0;
        });
        groups.push(sorted.map((i) => docs[i].id));
    }

    groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return groups;
}

/**
 * Promotion selection — top-`limit` documents by score.
 *
 * Stable and deterministic: score desc, tie → `id` asc. The input array
 * is not mutated. Non-positive limits return an empty selection.
 */
export function selectPromotions<T extends { id: string; score: number }>(
    scored: T[],
    limit: number = DEFAULT_PROMOTION_LIMIT,
): T[] {
    if (limit <= 0) return [];
    return [...scored]
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .slice(0, limit);
}

// ─── internals ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

function toEpochMs(value: Date | string): number | null {
    const d = value instanceof Date ? value : new Date(value);
    const ms = d.getTime();
    return Number.isNaN(ms) ? null : ms;
}

/** Case-fold, strip punctuation (unicode-aware), collapse whitespace. */
function normalizeText(value: string): string {
    return (value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * Word-{@link DUPLICATE_SHINGLE_SIZE}-gram shingle set of a normalized
 * body. Bodies shorter than one shingle degrade to a single shingle of
 * the whole normalized text (so short-but-identical bodies still match).
 */
function shingleSet(body: string): Set<string> {
    const normalized = normalizeText(body);
    if (normalized.length === 0) return new Set();
    const words = normalized.split(' ');
    if (words.length < DUPLICATE_SHINGLE_SIZE) {
        return new Set([normalized]);
    }
    const set = new Set<string>();
    for (let i = 0; i + DUPLICATE_SHINGLE_SIZE <= words.length; i++) {
        set.add(words.slice(i, i + DUPLICATE_SHINGLE_SIZE).join(' '));
    }
    return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const item of small) {
        if (large.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
