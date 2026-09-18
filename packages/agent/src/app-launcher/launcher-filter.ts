/**
 * APW-11 (App Launcher) — the **Manage apps** filter (FR-63, spec.md:303-305).
 *
 * Spec: FR-63 — "Past 200 it renders the first 200 with a counted **Showing 200
 * of {count}** line and a filter, **so no eligible item is unreachable**."
 *
 * The cap alone cannot deliver that: a client-side filter narrows what the
 * response already holds, so with 250 eligible items the 201st is simply not
 * reachable. The filter therefore has to narrow the **eligible set** on the
 * server, before the ordering module's cap — which is what this module is.
 *
 * ## The fold is the web's, deliberately
 *
 * `apps/web/src/components/command-palette/registry/local-match.ts:10-18`
 * already owns this application's one text fold — trim, lowercase, NFD,
 * combining marks removed, NFC — and it is what the browser uses to narrow the
 * rows it holds while a read is in flight. A server that folded differently
 * would make the two disagree in a way a person would see: type `cafe`, the
 * server answers with **Café Central**, and the browser's own narrowing then
 * drops the row it was just sent. So the fold is written once here and once
 * there, and `launcher-filter.spec.ts` pins the four inputs that would expose a
 * difference (case, accents, a combining form, and a substring).
 *
 * ## What is matched
 *
 * The item's **name**, as the tile reports it — the App spec's display name or
 * the Work's name, already capped and already carrying any community-build
 * suffix (FR-57). Nothing else: not the key (a `work:<uuid>` is not something a
 * person types), not the description (a platform's one-liner is not a Work's
 * name) and not the host (FR-55's address is not an identity). A caller that
 * wants to match more must say so in the spec first, because a filter that
 * matches an invisible field looks like a bug to the person using it.
 *
 * Nothing here reads the database, the environment or a clock: the eligible set
 * is handed in and the surviving items are handed back.
 */

/**
 * Unicode's combining-mark category, matching the web's `foldText`: after an
 * NFD decomposition, `é` is `e` + U+0301, and stripping the mark is what makes
 * `Café` match a typed `cafe`.
 */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Fold one string the way the browser folds it before comparing
 * (`foldText`, `local-match.ts:10-18`).
 *
 * `NFD` → strip marks → `NFC` rather than "strip accents character by
 * character": the decomposed form is what makes `ā`, `ç` and `ñ` all fold to
 * their base letters without a table of every accented character, and the final
 * `NFC` keeps the result a normal string for comparison and logging.
 */
export function foldLauncherText(input: string | null | undefined): string {
    if (typeof input !== 'string') {
        return '';
    }
    return input
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .normalize('NFC');
}

/**
 * The filter as a needle, or `null` when there is nothing to filter by.
 *
 * `null` and a string of spaces are the same request: FR-63's filter is a text
 * box a person clears, and "empty" must show the list they had rather than
 * match nothing. Callers therefore never branch on `''` themselves — a blank
 * filter *is* no filter, and the difference between "no filter" and "a filter
 * that matches nothing" is the difference between the whole list and an empty
 * one.
 *
 * The needle comes back **folded**, so a caller cannot accidentally compare two
 * raw forms; {@link matchesLauncherFilter} takes the raw filter and folds it
 * itself for the same reason.
 */
export function normalizeLauncherFilter(filter: string | null | undefined): string | null {
    const folded = foldLauncherText(filter);
    return folded.length > 0 ? folded : null;
}

/**
 * Whether one item's `name` matches the filter — a folded substring test, and
 * `true` for a blank filter, so "no filter" needs no branch at the call site.
 *
 * A substring rather than a prefix or a fuzzy score: the person is looking for
 * an app they can name, `di` matching `Cal.diy` and `Gauzy` matching
 * `Ever Gauzy` are both what they meant, and FR-63's guarantee is about
 * *reaching* an item rather than ranking one.
 */
export function matchesLauncherFilter(
    name: string | null | undefined,
    filter: string | null | undefined,
): boolean {
    const needle = normalizeLauncherFilter(filter);
    if (needle === null) {
        return true;
    }
    return foldLauncherText(name).includes(needle);
}
