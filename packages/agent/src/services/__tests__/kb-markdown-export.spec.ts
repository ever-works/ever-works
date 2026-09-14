import * as yaml from 'yaml';
import { renderKbMarkdownExport, type KbMarkdownExportInput } from '../kb-markdown-export';

const input = (overrides: Partial<KbMarkdownExportInput> = {}): KbMarkdownExportInput => ({
    title: 'Refund policy',
    slug: 'refund-policy',
    description: 'When we refund, when we do not.',
    class: 'freeform',
    tags: ['support'],
    status: 'active',
    source: 'user',
    workName: 'Support',
    folderPath: '/Playbooks/Support',
    revision: 4,
    revisionAt: new Date('2026-09-01T06:04:00Z'),
    createdAt: new Date('2026-08-01T00:00:00Z'),
    body: '# Refunds\n\nAlways within 30 days.',
    ...overrides,
});

function frontMatterOf(content: string): Record<string, unknown> {
    const match = /^---\n([\s\S]*?)\n---\n\n/.exec(content);
    if (!match) throw new Error('no front matter');
    return yaml.parse(match[1]) as Record<string, unknown>;
}

describe('renderKbMarkdownExport', () => {
    it('names the file after the slug', () => {
        expect(renderKbMarkdownExport(input()).filename).toBe('refund-policy.md');
    });

    it('writes the metadata as parseable YAML front matter, then the body', () => {
        const { content } = renderKbMarkdownExport(input());
        expect(frontMatterOf(content)).toEqual({
            title: 'Refund policy',
            slug: 'refund-policy',
            class: 'freeform',
            description: 'When we refund, when we do not.',
            tags: ['support'],
            status: 'active',
            source: 'user',
            work: 'Support',
            folder: '/Playbooks/Support',
            revision: 4,
            changed: '2026-09-01T06:04:00.000Z',
            created: '2026-08-01T00:00:00.000Z',
        });
        expect(content.endsWith('\n---\n\n# Refunds\n\nAlways within 30 days.\n')).toBe(true);
    });

    it('omits empty metadata instead of writing nulls', () => {
        const { content } = renderKbMarkdownExport(
            input({
                description: null,
                tags: [],
                workName: null,
                folderPath: null,
                revisionAt: null,
            }),
        );
        const fm = frontMatterOf(content);
        expect(Object.keys(fm)).not.toEqual(
            expect.arrayContaining(['description', 'tags', 'work', 'folder', 'changed']),
        );
        expect(content).not.toContain('null');
    });

    it('quotes a title YAML would otherwise misread', () => {
        const { content } = renderKbMarkdownExport(input({ title: 'Refunds: the --- rules #1' }));
        expect(frontMatterOf(content).title).toBe('Refunds: the --- rules #1');
    });

    it('makes a hostile slug filename-safe', () => {
        expect(renderKbMarkdownExport(input({ slug: '../../etc/passwd' })).filename).toBe(
            'etc-passwd.md',
        );
        expect(renderKbMarkdownExport(input({ slug: '' })).filename).toBe('document.md');
    });

    it('keeps an empty body as an empty section', () => {
        expect(renderKbMarkdownExport(input({ body: '' })).content.endsWith('\n---\n\n\n')).toBe(
            true,
        );
    });
});
