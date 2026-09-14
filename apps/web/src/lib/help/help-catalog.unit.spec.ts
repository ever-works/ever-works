// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HELP_ARTICLE_ID_PATTERN, HELP_LIMITS, HELP_SECTIONS } from '@ever-works/contracts/api';
import type {
    HelpArticleBody,
    HelpBlock,
    HelpInline,
    HelpLinkTarget,
} from '@ever-works/contracts/api';
import { ROUTES } from '@/lib/constants';
import {
    buildHelpManual,
    HELP_SECTIONS as GENERATOR_SECTIONS,
    LIMITS as GENERATOR_LIMITS,
    readCommittedCatalog,
} from '../../../scripts/build-help-catalog.mjs';
import { isHelpArticleBody } from './help-body';
import { HELP_ARTICLES } from './help-catalog.generated';
import type { HelpArticleMeta } from './help-types';

/**
 * The build gate for the in-product manual (AW-25, spec FR-5).
 *
 * The manual is built from the documentation pages in `docs/`. This spec
 * rebuilds it from those pages and fails when the committed catalog no longer
 * matches them, when an article names a screen the route map does not have,
 * when a link inside an article points at nothing, or when a limit is broken.
 * Every failure message names the article.
 */

const articles: readonly HelpArticleMeta[] = HELP_ARTICLES;
const manual = buildHelpManual();
const routeKeys = new Set(Object.keys(ROUTES));

function walkTargets(blocks: HelpBlock[], visit: (target: HelpLinkTarget) => void): void {
    const inline = (nodes: HelpInline[]) => {
        for (const node of nodes) {
            if (node.type === 'link') {
                visit(node.target);
                inline(node.children);
            } else if (node.type === 'strong' || node.type === 'emphasis') {
                inline(node.children);
            }
        }
    };
    for (const block of blocks) {
        switch (block.kind) {
            case 'paragraph':
            case 'heading':
                inline(block.content);
                break;
            case 'orderedList':
            case 'unorderedList':
                for (const item of block.items) {
                    inline(item.content);
                    walkTargets(item.children, visit);
                }
                break;
            case 'note':
                walkTargets(block.blocks, visit);
                break;
            case 'link':
                visit(block.target);
                break;
            case 'table':
                block.header.forEach(inline);
                block.rows.forEach((row) => row.forEach(inline));
                break;
            case 'shortcut':
            case 'code':
                break;
        }
    }
}

describe('help catalog — freshness', () => {
    it('builds from the documentation with no errors', () => {
        expect(manual.errors).toEqual([]);
    });

    it('renders every documentation construct it reuses without degrading it', () => {
        expect(manual.warnings).toEqual([]);
    });

    it('matches the committed catalog byte for byte (run `pnpm --filter ever-works-web help:build`)', () => {
        expect(readCommittedCatalog()).toBe(manual.catalogSource);
    });

    it('mirrors the section and limit vocabularies in @ever-works/contracts', () => {
        expect(GENERATOR_SECTIONS).toEqual([...HELP_SECTIONS]);
        expect(GENERATOR_LIMITS).toEqual({ ...HELP_LIMITS });
    });
});

describe('help catalog — invariants (spec FR-3, FR-5, FR-9)', () => {
    it('has unique article ids that match the id pattern', () => {
        const ids = articles.map((article) => article.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id, id).toMatch(HELP_ARTICLE_ID_PATTERN);
        expect(ids.length).toBeLessThanOrEqual(HELP_LIMITS.maxArticles);
    });

    it('has unique heading anchors inside every article', () => {
        for (const article of articles) {
            const anchors = article.headings.map((heading) => heading.id);
            expect(new Set(anchors).size, article.id).toBe(anchors.length);
            expect(anchors.length, article.id).toBeGreaterThan(0);
            expect(anchors.length, article.id).toBeLessThanOrEqual(HELP_LIMITS.maxHeadings);
        }
    });

    it('keeps every article inside the metadata limits', () => {
        for (const article of articles) {
            expect(article.title.length, article.id).toBeLessThanOrEqual(HELP_LIMITS.titleChars);
            expect(article.summary.length, article.id).toBeLessThanOrEqual(
                HELP_LIMITS.summaryChars,
            );
            expect(article.keywords.length, article.id).toBeLessThanOrEqual(
                HELP_LIMITS.maxKeywords,
            );
            expect(article.documents.length, article.id).toBeLessThanOrEqual(
                HELP_LIMITS.maxDocuments,
            );
            expect(article.related.length, article.id).toBeLessThanOrEqual(HELP_LIMITS.maxRelated);
            expect(article.reviewedAt, article.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it('places every article in exactly one of the six sections', () => {
        expect(HELP_SECTIONS).toHaveLength(6);
        for (const article of articles) {
            expect(HELP_SECTIONS as readonly string[], article.id).toContain(article.section);
        }
    });

    it('names only screens that exist in this build, and never the dead notifications route', () => {
        for (const article of articles) {
            for (const key of article.documents) {
                expect(routeKeys.has(key), `${article.id} documents unknown screen ${key}`).toBe(
                    true,
                );
                expect(key, article.id).not.toBe('DASHBOARD_NOTIFICATIONS');
            }
        }
    });

    it('relates articles only to articles in this build', () => {
        const ids = new Set(articles.map((article) => article.id));
        for (const article of articles) {
            for (const other of article.related) {
                expect(ids.has(other), `${article.id} relates to missing ${other}`).toBe(true);
                expect(other, article.id).not.toBe(article.id);
            }
        }
    });

    it('meets the launch floor: at least 18 articles and 2 in every section', () => {
        expect(articles.length).toBeGreaterThanOrEqual(18);
        for (const section of HELP_SECTIONS) {
            const count = articles.filter((article) => article.section === section).length;
            expect(count, section).toBeGreaterThanOrEqual(2);
        }
    });

    it('every link inside every article body resolves (spec FR-5.7, FR-27a)', () => {
        const ids = new Set(articles.map((article) => article.id));
        for (const { id, body } of manual.bodies as { id: string; body: HelpArticleBody }[]) {
            walkTargets(body.blocks, (target) => {
                if (target.type === 'article') {
                    expect(
                        ids.has(target.articleId),
                        `${id} links to missing ${target.articleId}`,
                    ).toBe(true);
                } else if (target.type === 'screen') {
                    expect(
                        routeKeys.has(target.routeKey),
                        `${id} links to screen ${target.routeKey}`,
                    ).toBe(true);
                    expect(target.routeKey, id).not.toBe('DASHBOARD_NOTIFICATIONS');
                    const value = (ROUTES as Record<string, unknown>)[target.routeKey];
                    expect(typeof value, `${id} links to a parameterised screen`).toBe('string');
                } else {
                    const url = new URL(target.href);
                    expect(url.protocol, `${id} ${target.href}`).toBe('https:');
                    expect(url.username + url.password, `${id} ${target.href}`).toBe('');
                }
            });
        }
    });

    it('every generated body passes the grammar check the in-product loader applies', () => {
        expect(manual.bodies.length).toBeGreaterThan(0);
        for (const { id, body } of manual.bodies as { id: string; body: unknown }[]) {
            // Round-trip through JSON, as the static file the browser fetches does.
            expect(isHelpArticleBody(JSON.parse(JSON.stringify(body)), id), id).toBe(true);
        }
    });
});
