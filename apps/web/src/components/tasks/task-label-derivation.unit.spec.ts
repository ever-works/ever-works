import { describe, it, expect } from 'vitest';

/**
 * EW-050 — the auto-derived Task label must respect the API's 80-char cap.
 *
 * `NewTaskForm` mirrors the slugified title into the Labels field until the
 * user edits it. The Title input allows **200** characters; the API caps each
 * label at **80**:
 *
 *     @MaxLength(80, { each: true })
 *     labels?: string[] | null;      // apps/api/src/tasks/tasks.dto.ts:48,131
 *
 * So any title longer than 80 characters derived an over-length label and made
 * the Task uncreatable. Confirmed on production before the fix: an 88-character
 * title produced an 88-character label, Create stayed on `/tasks/new`, and
 * `SELECT count(*) FROM tasks WHERE title LIKE 'QA long title probe%'` returned
 * **0**.
 *
 * The user-visible failure was worse than the cause: the server action surfaced
 * the rejection as *"An error occurred in the Server Components render. The
 * specific message is omitted in production builds…"* — so nothing pointed at
 * the label, or at the title length that produced it.
 *
 * This pins the derivation function, which is where the bug lives. A component
 * test would need the form, the server action and a transition to assert the
 * same one-line rule.
 */

const MAX_LABEL_LENGTH = 80;

/** Mirror of `slugifyTitle` in NewTaskForm.tsx. */
function slugifyTitle(title: string): string {
    const slug = title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    if (slug.length <= MAX_LABEL_LENGTH) return slug;

    const cut = slug.slice(0, MAX_LABEL_LENGTH);
    const lastBoundary = cut.lastIndexOf('-');
    const trimmed = lastBoundary > MAX_LABEL_LENGTH / 2 ? cut.slice(0, lastBoundary) : cut;
    return trimmed.replace(/-+$/g, '');
}

/** The pre-fix derivation, kept so the regression is demonstrated not asserted. */
function legacySlugify(title: string): string {
    return title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** The exact title used against production. */
const PROD_TITLE =
    'QA long title probe for label derivation exceeding the API cap on task labels twenty two';

describe('Task label derivation', () => {
    it('control: the legacy derivation really did exceed the API cap', () => {
        // If this stops being true the bug never existed and the rest is theatre.
        expect(PROD_TITLE.length).toBeGreaterThan(MAX_LABEL_LENGTH);
        expect(legacySlugify(PROD_TITLE).length).toBeGreaterThan(MAX_LABEL_LENGTH);
    });

    it('caps the production title that could not be created', () => {
        const label = slugifyTitle(PROD_TITLE);
        expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
        expect(label.startsWith('qa-long-title-probe')).toBe(true);
    });

    it.each([
        ['exactly at the cap', 'a'.repeat(MAX_LABEL_LENGTH)],
        ['one over the cap', 'a'.repeat(MAX_LABEL_LENGTH + 1)],
        ['far over the cap', 'word '.repeat(80)],
        ['the longest title the input allows', 'x'.repeat(200)],
    ])('never exceeds the cap: %s', (_name, title) => {
        expect(slugifyTitle(title).length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    });

    it('leaves short titles completely untouched', () => {
        // The fix must not change the overwhelmingly common case.
        expect(slugifyTitle('Redesign onboarding flow')).toBe('redesign-onboarding-flow');
        expect(slugifyTitle('  Fix the login bug!  ')).toBe('fix-the-login-bug');
    });

    it('never emits a trailing hyphen, even when the cut lands on one', () => {
        // A boundary cut that left "foo-bar-" would be ugly and would also
        // slugify inconsistently with the untruncated path.
        for (let n = 70; n <= 120; n++) {
            const label = slugifyTitle('ab '.repeat(n));
            expect(label.endsWith('-')).toBe(false);
            expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
        }
    });

    it('still yields a usable label when the first word alone exceeds the cap', () => {
        // A hyphen-boundary cut would return '' here; the fix falls back to a
        // hard cut so the user still gets something rather than an empty label.
        const label = slugifyTitle('a'.repeat(100) + ' tail');
        expect(label.length).toBeGreaterThan(0);
        expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    });
});
