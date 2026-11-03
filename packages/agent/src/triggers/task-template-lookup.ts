/**
 * RESERVED port to the `task_templates` table (feature I — Tasks
 * upgrades, parallel branch). This branch stores only a string
 * `taskTemplateSlug` on the trigger and resolves it LAZILY at fire
 * time through this optional token, so:
 *
 *   - standalone (feature I not merged): no provider is bound, the
 *     lookup is skipped, and the trigger's own title/description
 *     templates are used — nothing breaks;
 *   - after feature I merges: its module binds an implementation to
 *     {@link TASK_TEMPLATE_LOOKUP} and slug-linked triggers light up
 *     with zero changes here.
 *
 * Deliberately NOT an entity import — the templates entity must never
 * be referenced from this branch (dependency note in the feature brief).
 */
export const TASK_TEMPLATE_LOOKUP = 'EVER_WORKS_TASK_TEMPLATE_LOOKUP';

/** The projection a fire needs from a resolved task template. */
export interface ResolvedTaskTemplate {
    /** Title template (same `{{…}}` grammar as the trigger's own). */
    titleTemplate?: string | null;
    /** Description template (same grammar). */
    descriptionTemplate?: string | null;
}

export interface TaskTemplateLookup {
    /**
     * Resolve `slug` for `userId`; null when the slug does not exist
     * (or is not visible to that user). MUST NOT throw for a missing
     * row — a stale slug degrades to the trigger's own templates.
     */
    findBySlug(userId: string, slug: string): Promise<ResolvedTaskTemplate | null>;
}
