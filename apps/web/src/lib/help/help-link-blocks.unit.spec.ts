// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { HelpBlock, HelpLinkTarget } from '@ever-works/contracts/api';
import {
    parseArticleBody,
    parseInline,
    slugifyHeading,
    splitFrontMatter,
} from '../../../scripts/build-help-catalog.mjs';

/**
 * The article grammar (AW-25, spec FR-27, FR-27a, FR-28) — exercised through
 * the pure parser the generator exports, over fixture Markdown. Link targets
 * are resolved by a stub resolver that mimics the generator's rules for the
 * three authored forms, so this spec pins the parser, not the file system.
 */

interface Warning {
    message: string;
    line?: number;
}

function resolver(raw: string): HelpLinkTarget | null {
    if (raw.startsWith('help:')) {
        const [articleId, headingId] = raw.slice(5).split('#');
        return articleId === 'missions'
            ? { type: 'article', articleId, headingId: headingId ?? null }
            : null;
    }
    if (raw.startsWith('route:')) {
        const key = raw.slice(6);
        return /^[A-Z][A-Z0-9_]*$/.test(key) ? { type: 'screen', routeKey: key } : null;
    }
    if (raw.startsWith('https://')) {
        const url = new URL(raw);
        return url.username || url.password ? null : { type: 'external', href: url.toString() };
    }
    return null;
}

function parse(markdown: string) {
    const warnings: Warning[] = [];
    const result = parseArticleBody(markdown, {
        articleId: 'fixture',
        line: 10,
        resolveTarget: resolver,
        warn: (message: string, line?: number) => warnings.push({ message, line }),
    });
    return { ...result, blocks: result.blocks as HelpBlock[], warnings };
}

describe('front matter', () => {
    it('reads flat keys, strips quotes and reports where the body starts', () => {
        const { data, body, bodyLine } = splitFrontMatter(
            "---\nid: tasks\ntitle: 'Tasks'\n---\n\n# Tasks\n",
        );
        expect(data).toEqual({ id: 'tasks', title: 'Tasks' });
        expect(body).toBe('\n# Tasks\n');
        expect(bodyLine).toBe(5);
    });

    it('treats a file with no front matter as all body', () => {
        expect(splitFrontMatter('# Hello')).toEqual({ data: {}, body: '# Hello', bodyLine: 1 });
    });
});

describe('heading anchors', () => {
    it('slugifies the way the documentation site does', () => {
        expect(slugifyHeading('Settings → Job Runtime')).toBe('settings--job-runtime');
        expect(slugifyHeading('Ingest: drop a file, get usable knowledge')).toBe(
            'ingest-drop-a-file-get-usable-knowledge',
        );
        expect(slugifyHeading('What is `SKILL.md`?')).toBe('what-is-skillmd');
    });

    it('de-duplicates repeated headings inside one article and skips the page title', () => {
        const { headings, blocks } = parse(
            '# Title\n\n## API\n\ntext\n\n## API\n\n### Deep {#custom-id}\n',
        );
        expect(headings).toEqual([
            { id: 'api', text: 'API', level: 2 },
            { id: 'api-1', text: 'API', level: 2 },
            { id: 'custom-id', text: 'Deep', level: 3 },
        ]);
        expect(blocks.filter((b) => b.kind === 'heading')).toHaveLength(3);
    });
});

describe('blocks', () => {
    it('parses paragraphs, lists (including loose and nested ones), tables, code and callouts', () => {
        const { blocks, warnings } = parse(
            [
                'A **bold** and _soft_ start with `code`.',
                '',
                '1. First',
                '',
                '2. Second',
                '    - nested',
                '',
                '| Col | Other |',
                '| --- | ----- |',
                '| `a\\|b` | two |',
                '',
                '```bash',
                'pnpm dev',
                '```',
                '',
                ':::caution Careful now',
                'Inside the callout.',
                ':::',
                '',
                '> Quoted',
            ].join('\n'),
        );
        expect(warnings).toEqual([]);
        expect(blocks.map((block) => block.kind)).toEqual([
            'paragraph',
            'orderedList',
            'table',
            'code',
            'note',
            'note',
        ]);
        const list = blocks[1] as Extract<HelpBlock, { kind: 'orderedList' }>;
        expect(list.items).toHaveLength(2);
        expect(list.items[1].children[0].kind).toBe('unorderedList');
        const note = blocks[4] as Extract<HelpBlock, { kind: 'note' }>;
        expect(note).toMatchObject({ tone: 'warning', title: 'Careful now' });
        expect((blocks[5] as Extract<HelpBlock, { kind: 'note' }>).tone).toBe('info');
        expect(blocks[3]).toEqual({ kind: 'code', language: 'bash', text: 'pnpm dev' });
    });

    it('never emits raw markup: HTML and images degrade with a warning naming the line', () => {
        const { blocks, warnings } = parse(
            '<div>raw</div>\n\nSee ![diagram](x.png) and <b>this</b>.\n',
        );
        expect(JSON.stringify(blocks)).not.toContain('<div>');
        expect(JSON.stringify(blocks)).not.toContain('<b>');
        // The HTML block, the image, and the opening and closing inline tags.
        expect(warnings.map((w) => w.line)).toEqual([10, 12, 12, 12]);
    });
});

describe('link blocks and inline links (spec FR-27a)', () => {
    it('turns each of the three authored forms into its target', () => {
        const { blocks, warnings } = parse(
            [
                '[Write a brief](help:missions#creating-a-mission)',
                '',
                '[Open Missions](route:DASHBOARD_MISSIONS)',
                '',
                '[Status page](https://status.example.org)',
            ].join('\n'),
        );
        expect(warnings).toEqual([]);
        const targets = blocks.map((block) => {
            const paragraph = block as Extract<HelpBlock, { kind: 'paragraph' }>;
            const link = paragraph.content[0];
            return link.type === 'link' ? link.target : null;
        });
        expect(targets).toEqual([
            { type: 'article', articleId: 'missions', headingId: 'creating-a-mission' },
            { type: 'screen', routeKey: 'DASHBOARD_MISSIONS' },
            { type: 'external', href: 'https://status.example.org/' },
        ]);
    });

    it.each([
        ['a literal in-product path', '[Missions](/missions)'],
        ['an http address', '[Old](http://example.org)'],
        ['a javascript: address', '[Bad](javascript:alert(1))'],
        ['a data: address', '[Bad](data:text/html,hi)'],
        ['a mailto: address', '[Mail](mailto:someone@example.org)'],
        ['a protocol-relative address', '[Host](//example.org)'],
        ['an address with credentials', '[Creds](https://user:pass@example.org)'],
        ['an unknown article', '[Nope](help:not-an-article)'],
    ])('renders %s as plain text with no link', (_label, markdown) => {
        const nodes = parseInline(markdown, { resolveTarget: resolver, warn: () => {} });
        expect(nodes.some((node: { type: string }) => node.type === 'link')).toBe(false);
        expect(nodes.map((node: { text?: string }) => node.text ?? '').join('')).not.toContain(
            '](',
        );
    });

    it('keeps the label text of an unresolvable link', () => {
        const nodes = parseInline('Go to [the list](javascript:void(0)) now', {
            resolveTarget: resolver,
            warn: () => {},
        });
        expect(nodes).toEqual([{ type: 'text', text: 'Go to the list now' }]);
    });
});
