import type { HelpSection } from '@ever-works/contracts/api';

/** One addressable heading inside an article — a link target and an "On this page" row. */
export interface HelpHeadingMeta {
    readonly id: string;
    readonly text: string;
    readonly level: 2 | 3;
}

/**
 * Eager metadata for one article of the in-product manual (AW-25). The body
 * is loaded on demand; everything the browse view, search and help links need
 * is here, so the panel is useful the moment it opens.
 */
export interface HelpArticleMeta {
    readonly id: string;
    readonly section: HelpSection;
    readonly order: number;
    /** Title of the documentation page the article is built from. */
    readonly title: string;
    /** Short name of the screen or feature — used in "Open {screen}". */
    readonly label: string;
    readonly summary: string;
    readonly keywords: readonly string[];
    /** Keys of `ROUTES` for the screens this article documents (spec FR-5.2). */
    readonly documents: readonly string[];
    readonly related: readonly string[];
    /** `YYYY-MM-DD` — when the article was last reviewed against the product. */
    readonly reviewedAt: string;
    /** Repository path of the documentation page, e.g. `docs/features/missions.md`. */
    readonly source: string;
    /** The same page on the published documentation site. */
    readonly docsUrl: string;
    readonly headings: readonly HelpHeadingMeta[];
}
