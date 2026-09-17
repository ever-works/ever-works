import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpBlock, HelpInline } from '@ever-works/contracts/api';
import {
    HELP_BODY_MAX_DEPTH,
    helpBodyUrl,
    isHelpArticleBody,
    loadHelpArticleBody,
    resetHelpBodyCache,
} from './help-body';

const body = { version: 1, id: 'missions', blocks: [{ kind: 'paragraph', content: [] }] };

function respond(status: number, json: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
}

beforeEach(() => resetHelpBodyCache());

describe('loadHelpArticleBody', () => {
    it('loads from this deployment, never from another origin (spec FR-1)', async () => {
        const fetcher = vi.fn(async () => respond(200, body));
        await expect(loadHelpArticleBody('missions', fetcher)).resolves.toEqual(body);
        const [url] = fetcher.mock.calls[0] as unknown as [string];
        expect(url.startsWith('/help-content/missions.json?v=')).toBe(true);
        expect(helpBodyUrl('missions')).toBe(url);
    });

    it('caches a loaded body for the life of the page', async () => {
        const fetcher = vi.fn(async () => respond(200, body));
        await loadHelpArticleBody('missions', fetcher);
        await loadHelpArticleBody('missions', fetcher);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a missing body', () => respond(404, null)],
        ['a malformed body', () => respond(200, { version: 2, id: 'missions', blocks: [] })],
        ['a body for another article', () => respond(200, { ...body, id: 'tasks' })],
    ])('resolves null for %s and retries next time', async (_label, reply) => {
        const fetcher = vi.fn(async () => reply());
        await expect(loadHelpArticleBody('missions', fetcher)).resolves.toBeNull();
        await loadHelpArticleBody('missions', fetcher);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('resolves null for a body whose blocks break the grammar, instead of handing it to the renderer', async () => {
        const fetcher = vi.fn(async () =>
            respond(200, { version: 1, id: 'missions', blocks: [{ kind: 'paragraph' }] }),
        );
        await expect(loadHelpArticleBody('missions', fetcher)).resolves.toBeNull();
    });

    it('resolves null when the request itself fails, synchronously or not', async () => {
        await expect(
            loadHelpArticleBody(
                'missions',
                vi.fn(async () => Promise.reject(new Error('offline'))),
            ),
        ).resolves.toBeNull();
        await expect(
            loadHelpArticleBody(
                'missions',
                vi.fn(() => {
                    throw new Error('boom');
                }),
            ),
        ).resolves.toBeNull();
    });
});

describe('isHelpArticleBody — the closed block grammar (spec FR-27)', () => {
    const text = (value: string): HelpInline => ({ type: 'text', text: value });
    const envelope = (blocks: unknown[]) => ({ version: 1, id: 'missions', blocks });

    it('accepts a body using every block and inline kind', () => {
        const blocks: HelpBlock[] = [
            { kind: 'heading', level: 2, id: 'first', content: [text('First')] },
            {
                kind: 'paragraph',
                content: [
                    { type: 'strong', children: [text('bold')] },
                    { type: 'emphasis', children: [{ type: 'code', text: 'pnpm' }] },
                    {
                        type: 'link',
                        children: [text('Tasks')],
                        target: { type: 'article', articleId: 'tasks', headingId: null },
                    },
                ],
            },
            {
                kind: 'orderedList',
                items: [
                    {
                        content: [text('one')],
                        children: [
                            {
                                kind: 'unorderedList',
                                items: [{ content: [text('nested')], children: [] }],
                            },
                        ],
                    },
                ],
            },
            {
                kind: 'note',
                tone: 'tip',
                title: null,
                blocks: [{ kind: 'code', language: null, text: 'pnpm dev' }],
            },
            { kind: 'shortcut', keys: ['Ctrl', 'K'], label: 'Palette' },
            {
                kind: 'link',
                label: 'Missions',
                target: { type: 'screen', routeKey: 'DASHBOARD_MISSIONS' },
            },
            {
                kind: 'link',
                label: 'Status',
                target: { type: 'external', href: 'https://status.example.org/' },
            },
            { kind: 'table', header: [[text('Col')]], rows: [[[text('cell')]]] },
        ];
        expect(isHelpArticleBody(envelope(blocks), 'missions')).toBe(true);
    });

    it.each<[string, unknown[]]>([
        ['a paragraph with no content', [{ kind: 'paragraph' }]],
        ['an unknown block kind', [{ kind: 'video', src: 'x' }]],
        ['a block that is not an object', ['paragraph']],
        ['a heading at level 1', [{ kind: 'heading', level: 1, id: 'a', content: [] }]],
        ['a heading with no id', [{ kind: 'heading', level: 2, content: [] }]],
        ['a list item with no children', [{ kind: 'orderedList', items: [{ content: [] }] }]],
        ['a list with no items', [{ kind: 'unorderedList' }]],
        ['a note in an unknown tone', [{ kind: 'note', tone: 'loud', title: null, blocks: [] }]],
        ['a note with no blocks', [{ kind: 'note', tone: 'tip', title: null }]],
        ['a shortcut with a non-string key', [{ kind: 'shortcut', keys: [1], label: 'x' }]],
        ['a code block with no text', [{ kind: 'code', language: null }]],
        ['a link block with no target', [{ kind: 'link', label: 'x' }]],
        [
            'a link block with an unknown target type',
            [{ kind: 'link', label: 'x', target: { type: 'mailto', href: 'a@b.c' } }],
        ],
        ['a table row that is not a list of cells', [{ kind: 'table', header: [], rows: ['x'] }]],
        ['an inline node with no text', [{ kind: 'paragraph', content: [{ type: 'text' }] }]],
        [
            'an inline strong with no children',
            [{ kind: 'paragraph', content: [{ type: 'strong' }] }],
        ],
        [
            'an inline link with no target',
            [{ kind: 'paragraph', content: [{ type: 'link', children: [] }] }],
        ],
        [
            'a malformed block nested inside a note inside a list',
            [
                {
                    kind: 'unorderedList',
                    items: [
                        {
                            content: [],
                            children: [
                                {
                                    kind: 'note',
                                    tone: 'info',
                                    title: null,
                                    blocks: [{ kind: 'paragraph' }],
                                },
                            ],
                        },
                    ],
                },
            ],
        ],
    ])('rejects %s', (_label, blocks) => {
        expect(isHelpArticleBody(envelope(blocks), 'missions')).toBe(false);
    });

    it('rejects nesting deeper than the ceiling without overflowing the stack', () => {
        let inline: HelpInline = text('deep');
        for (let level = 0; level < HELP_BODY_MAX_DEPTH + 1; level += 1) {
            inline = { type: 'strong', children: [inline] };
        }
        expect(
            isHelpArticleBody(envelope([{ kind: 'paragraph', content: [inline] }]), 'missions'),
        ).toBe(false);

        let shallow: HelpInline = text('fine');
        for (let level = 0; level < 8; level += 1) {
            shallow = { type: 'strong', children: [shallow] };
        }
        expect(
            isHelpArticleBody(envelope([{ kind: 'paragraph', content: [shallow] }]), 'missions'),
        ).toBe(true);
    });
});
