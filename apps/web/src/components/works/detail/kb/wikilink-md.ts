/**
 * EW-641 Phase 1B/d row 16 — wikilink ↔ markdown preprocessor.
 *
 * The KB editor (row 6) writes wikilinks in Obsidian-style syntax:
 *   `[[Brand voice|brand/voice.md]]`
 *   `[[brand/voice.md]]` (path-only — label defaults to the basename)
 *
 * To keep the renderer simple (and to avoid pulling in a remark plugin
 * with its own sanitiser surface area), we lift the wikilink syntax up
 * to vanilla CommonMark before `react-markdown` runs:
 *   `[Brand voice](/works/<workId>/kb/brand/voice.md)`
 *
 * Constraints:
 *  - Inside ``` code fences or `inline code` we leave wikilinks alone
 *    (they're sample syntax, not real links).
 *  - The target is path-only (no schemes, no leading slash, no `..`
 *    segments) — a path containing `://` or starting with `/` is left
 *    untouched so we never accidentally synthesise an unsafe href.
 *  - Empty target → no replacement.
 *  - Pipe present but label empty → fall back to the path basename.
 *
 * Stable selectors live on the rendered `<a>` indirectly via the
 * markdown anchor — Playwright A12-A17 keys off the visible link text
 * + href shape rather than a `data-*` attr, matching how Markdown
 * links elsewhere in the dashboard are tested.
 */

const WIKILINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Returns `true` if the given path is safe to use as a relative KB
 * route segment. Rejects:
 *  - empty / whitespace
 *  - URL schemes (`http://`, `javascript:`, etc.)
 *  - absolute paths (`/foo`)
 *  - `..` traversal segments
 *  - paths containing whitespace (Markdown link targets break otherwise)
 */
// Allowed path chars are deliberately conservative: alphanumerics plus
// the few punctuation marks needed for slug-style paths (`_`, `-`, `.`,
// `/`). This rejects URL schemes (`javascript:`, `data:`), query
// strings (`?`), fragments (`#`), and any whitespace — anything that
// could synthesise an unsafe href below.
const SAFE_PATH_RE = /^[a-zA-Z0-9_\-./]+$/;

function isSafePath(target: string): boolean {
    const t = target.trim();
    if (t.length === 0) return false;
    if (!SAFE_PATH_RE.test(t)) return false;
    if (t.startsWith('/')) return false;
    const segments = t.split('/');
    return !segments.some((seg) => seg === '..' || seg === '.');
}

function basename(path: string): string {
    const last = path.split('/').pop() ?? path;
    return last.replace(/\.md$/i, '');
}

/**
 * Rewrites `[[Label|path]]` and `[[path]]` wikilinks in `source` to
 * standard Markdown links pointing at `/works/<workId>/kb/<path>`.
 * Code fences and inline-code spans are preserved verbatim.
 */
export function rewriteWikilinks(source: string, workId: string): string {
    if (source.length === 0) return source;

    // Mask code fences + inline code so the wikilink RE can't touch
    // them. We track byte offsets so we can splice them back after.
    type Mask = { start: number; end: number; text: string };
    const masks: Mask[] = [];

    function collect(re: RegExp) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(source)) !== null) {
            masks.push({
                start: match.index,
                end: match.index + match[0].length,
                text: match[0],
            });
        }
    }
    collect(FENCE_RE);
    collect(INLINE_CODE_RE);
    masks.sort((a, b) => a.start - b.start);

    function isMasked(idx: number): boolean {
        for (const m of masks) {
            if (idx >= m.start && idx < m.end) return true;
            if (m.start > idx) return false;
        }
        return false;
    }

    return source.replace(WIKILINK_RE, (full, rawLabelOrPath, rawPath, offset) => {
        if (isMasked(offset)) return full;
        // `[[path]]` form vs `[[label|path]]` form.
        const path = (rawPath ?? rawLabelOrPath).trim();
        if (!isSafePath(path)) return full;
        const label =
            rawPath !== undefined && rawPath !== null
                ? rawLabelOrPath.trim() || basename(path)
                : basename(path);
        const href = `/works/${encodeURIComponent(workId)}/kb/${path}`;
        return `[${label}](${href})`;
    });
}
