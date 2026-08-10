/**
 * Title/description matching between an Idea and an existing Work.
 *
 * The authoritative record of "this Idea produced that Work" is the
 * `idea_works` provenance table (see `idea-built.ts`). A row lands there
 * when the Work is created through the Idea flow — `/works/new?proposal=…`
 * calls `accept`, and the Work Agent pipeline stamps its own link.
 *
 * Nothing links a Work the user built OUTSIDE that flow: they opened
 * `/works/new` directly, or re-typed the Idea into the Work form, or the
 * `accept` call failed after the Work was already created. Those Ideas
 * read "Not built yet" forever even though the Work is sitting in their
 * catalog under the same name.
 *
 * This module closes that gap with content matching: when an Idea's title
 * AND description both match a Work's name and description, the Idea is
 * treated as built by that Work. It is a FALLBACK only — provenance always
 * wins where it exists, and a match never writes anything to the server.
 *
 * No `'use client'` / `'server-only'` so the pages (server) and the card
 * (client) can both import it.
 */

/** The fields of a `Work` this module needs. Kept structural so callers
 *  can pass a full `Work`, a list row, or a test fixture. */
export interface WorkMatchCandidate {
    id: string;
    name: string;
    description?: string | null;
}

/**
 * Shortest description that may match by containment rather than by
 * equality. The Work form seeds its prompt from the Idea's description and
 * the AI detail generator then expands it, so the stored Work description
 * often *contains* the Idea's rather than equalling it. Below this length
 * a shared prefix says almost nothing ("A directory of tools"), so we
 * require exact equality there instead.
 */
const MIN_CONTAINMENT_LENGTH = 40;

/**
 * Case/punctuation/whitespace-insensitive comparison key. Two texts that
 * differ only in typography — smart quotes, a trailing period, a line
 * break the textarea inserted — describe the same thing and must match.
 */
export function normalizeForMatch(value: string | null | undefined): string {
    return (value ?? '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * Whether a Work's description says nothing the name hasn't already said,
 * and so cannot be evidence for or against a match.
 *
 * `Work for {name}` is the AI-failure fallback in the agent's
 * `WorkDetailService`: when the detail generator throws, the Work is
 * saved with that placeholder instead of a real description. It is
 * derived from the Work's own name, so comparing it to the Idea's
 * description is meaningless — and letting it veto an exact name match
 * left Ideas reading "Not built yet" beside the Work they produced.
 *
 * An empty description and one that merely repeats the name are the same
 * situation, so they are treated the same way.
 *
 * Both arguments must already be normalized.
 */
function isUninformativeDescription(description: string, name: string): boolean {
    if (!description) return true;
    if (description === name) return true;
    return description === `work for ${name}`;
}

/**
 * Descriptions match when they are equal, or when the shorter one is
 * contained in the longer AND is substantial enough for that to mean
 * something. An empty description on either side is not evidence of
 * anything, so it never matches — the name alone must not promote an
 * unrelated Work into "this Idea was built".
 */
function descriptionsMatch(ideaDescription: string, workDescription: string): boolean {
    if (!ideaDescription || !workDescription) return false;
    if (ideaDescription === workDescription) return true;

    const [shorter, longer] =
        ideaDescription.length <= workDescription.length
            ? [ideaDescription, workDescription]
            : [workDescription, ideaDescription];

    return shorter.length >= MIN_CONTAINMENT_LENGTH && longer.includes(shorter);
}

/**
 * The Work this Idea was (almost certainly) built into, or `null`.
 *
 * An identical name is necessary but not sufficient: a user with an Idea
 * and a Work both called "Blog" would get a false "Built" badge and a
 * View Work link to someone else's subject. So the descriptions must
 * corroborate it — UNLESS the Work has no real description to offer (see
 * `isUninformativeDescription`), in which case the name stands alone
 * rather than being vetoed by a placeholder.
 *
 * Returns the first match in `works`; callers pass a newest-first list, so
 * that is the most recent Work bearing this Idea's content.
 */
export function findMatchingWork<T extends WorkMatchCandidate>(
    idea: { title: string; description: string },
    works: ReadonlyArray<T>,
): T | null {
    const title = normalizeForMatch(idea.title);
    if (!title) return null;
    const description = normalizeForMatch(idea.description);

    for (const work of works) {
        const name = normalizeForMatch(work.name);
        if (name !== title) continue;
        const workDescription = normalizeForMatch(work.description);
        if (isUninformativeDescription(workDescription, name)) return work;
        if (descriptionsMatch(description, workDescription)) return work;
    }
    return null;
}

/**
 * Batch form for list pages: `{ [ideaId]: workId }` for every Idea that
 * matched. Ideas without a match are absent rather than mapped to `null`,
 * so the object stays small when it crosses the server→client boundary.
 */
export function matchIdeasToWorks(
    ideas: ReadonlyArray<{ id: string; title: string; description: string }>,
    works: ReadonlyArray<WorkMatchCandidate>,
): Record<string, string> {
    const matches: Record<string, string> = {};
    for (const idea of ideas) {
        const work = findMatchingWork(idea, works);
        if (work) matches[idea.id] = work.id;
    }
    return matches;
}
