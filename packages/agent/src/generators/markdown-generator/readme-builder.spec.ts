// `github-slugger` is shipped as ESM-only, which Jest's CommonJS pipeline
// cannot parse. Replace it with a tiny deterministic stand-in that mirrors
// the slugify-with-dedup behaviour the builder relies on (lowercase, runs
// of non-alphanumeric → `-`, append `-1`/`-2`/... for repeats per instance).
jest.mock('github-slugger', () => {
    return class MockGithubSlugger {
        private seen = new Map<string, number>();
        slug(input: string): string {
            const base = input
                .toLowerCase()
                .replace(/&/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const count = this.seen.get(base) ?? 0;
            this.seen.set(base, count + 1);
            return count === 0 ? base : `${base}-${count}`;
        }
    };
});

import type { ItemData } from '@ever-works/plugin';

// `readme-builder` instantiates the slugger at module load and never resets
// it. Across tests, identical headers would otherwise drift to `tools-1`,
// `tools-2`, etc. Reload the module per test so each scenario starts with a
// pristine slugger.
let ReadmeBuilder: typeof import('./readme-builder').ReadmeBuilder;
beforeEach(() => {
    jest.isolateModules(() => {
        ReadmeBuilder = require('./readme-builder').ReadmeBuilder;
    });
});

function makeItem(overrides: Partial<ItemData> = {}): ItemData {
    return {
        slug: 'foo',
        name: 'Foo',
        description: 'A foo',
        source_url: 'https://foo.test',
        ...overrides,
    } as ItemData;
}

describe('ReadmeBuilder', () => {
    describe('build envelope', () => {
        it('emits header + body + footer with empty body', () => {
            const out = new ReadmeBuilder('HDR', 'FTR').build();
            expect(out).toBe('HDR\n\nFTR');
        });

        it('preserves multiline header/footer verbatim', () => {
            const out = new ReadmeBuilder('# Hello\nLine 2', '> bye').build();
            expect(out.startsWith('# Hello\nLine 2\n')).toBe(true);
            expect(out.endsWith('> bye')).toBe(true);
        });
    });

    describe('section helpers', () => {
        it('addHeader emits H1 with two trailing newlines', () => {
            const out = new ReadmeBuilder('', '').addHeader('Title').build();
            expect(out).toContain('# Title\n\n');
        });

        it('addSubHeader emits H2, registers a ToC entry, and is chainable', () => {
            const builder = new ReadmeBuilder('', '');
            const ret = builder.addSubHeader('Tools', 12);
            expect(ret).toBe(builder);
            const out = builder.enableToC().build();
            expect(out).toContain('## Tools\n\n');
            expect(out).toContain('## 📑 Table of Contents');
            expect(out).toContain('- [Tools (12)](#tools)');
        });

        it('addParagraph + addNewLine compose with double + single newlines', () => {
            const out = new ReadmeBuilder('', '')
                .addParagraph('Para A')
                .addNewLine()
                .addParagraph('Para B')
                .build();
            // Body ends with the trailing `\n` from build() too.
            expect(out).toContain('Para A\n\n\nPara B\n\n');
        });

        it('every section helper is chainable (returns the builder)', () => {
            const b = new ReadmeBuilder('', '');
            expect(b.addHeader('h')).toBe(b);
            expect(b.addParagraph('p')).toBe(b);
            expect(b.addNewLine()).toBe(b);
            expect(b.enableToC()).toBe(b);
        });
    });

    describe('Table of Contents', () => {
        it('is omitted when enableToC() is not called', () => {
            const out = new ReadmeBuilder('H', 'F')
                .addSubHeader('Tools', 5)
                .addSubHeader('Libraries', 10)
                .build();
            expect(out).not.toContain('Table of Contents');
            expect(out).toContain('## Tools');
            expect(out).toContain('## Libraries');
        });

        it('is rendered with anchor slugs and en-US-formatted counts', () => {
            const out = new ReadmeBuilder('', '')
                .enableToC()
                .addSubHeader('Tools & Utilities', 1234)
                .addSubHeader('Libraries')
                .build();

            expect(out).toContain('## 📑 Table of Contents\n\n');
            // The slugger lowercases, drops `&`, and collapses non-alphanum
            // runs into single `-` (the exact slug shape comes from
            // github-slugger; here we assert against a stable substring that
            // both the real library and our mock agree on).
            expect(out).toMatch(/- \[Tools & Utilities \(1,234\)\]\(#tools-+utilities\)/);
            // Count omitted when undefined.
            expect(out).toContain('- [Libraries](#libraries)');
            // The body subheaders still render.
            expect(out).toContain('## Tools & Utilities\n\n');
            expect(out).toContain('## Libraries\n\n');
        });

        it('disambiguates duplicate slugs across the document', () => {
            const out = new ReadmeBuilder('', '')
                .enableToC()
                .addSubHeader('Tools')
                .addSubHeader('Tools')
                .build();
            // github-slugger appends -1, -2, ... for repeats.
            expect(out).toContain('- [Tools](#tools)');
            expect(out).toContain('- [Tools](#tools-1)');
        });

        it('renders 0 as "0" not as omitted', () => {
            const out = new ReadmeBuilder('', '').enableToC().addSubHeader('Empty', 0).build();
            expect(out).toContain('- [Empty (0)](#empty)');
        });
    });

    describe('addItem', () => {
        it('emits the standard item line without details and with no tags', () => {
            const out = new ReadmeBuilder('', '').addItem(makeItem()).build();
            expect(out).toContain('- [Foo](https://foo.test) - A foo\n');
            expect(out).not.toContain('Read more');
            expect(out).not.toContain('`');
        });

        it('appends the details link when hasDetails=true', () => {
            const out = new ReadmeBuilder('', '')
                .addItem(makeItem({ slug: 'cool-thing' }), { hasDetails: true })
                .build();
            expect(out).toContain(
                '- [Foo](https://foo.test) - A foo ([Read more](/details/cool-thing.md))',
            );
        });

        it('joins tags with spaces and wraps each in backticks', () => {
            const out = new ReadmeBuilder('', '')
                .addItem(
                    makeItem({
                        tags: [
                            { name: 'rust', slug: 'rust' },
                            { name: 'cli', slug: 'cli' },
                        ] as any,
                    }),
                )
                .build();
            expect(out).toContain('- [Foo](https://foo.test) - A foo `rust` `cli`');
        });

        it('emits BOTH the details link AND the tags when both are present', () => {
            const out = new ReadmeBuilder('', '')
                .addItem(
                    makeItem({
                        slug: 's',
                        tags: [{ name: 'a', slug: 'a' }] as any,
                    }),
                    { hasDetails: true },
                )
                .build();
            expect(out).toContain(
                '- [Foo](https://foo.test) - A foo ([Read more](/details/s.md)) `a`',
            );
        });

        it('skips the tags suffix when tags is missing or empty array', () => {
            const out1 = new ReadmeBuilder('', '').addItem(makeItem({ tags: [] as any })).build();
            const out2 = new ReadmeBuilder('', '').addItem(makeItem({ tags: undefined })).build();
            expect(out1).not.toContain('`');
            expect(out2).not.toContain('`');
        });

        it('addItem is chainable for multi-item runs', () => {
            const b = new ReadmeBuilder('', '');
            expect(b.addItem(makeItem())).toBe(b);
            const out = b.addItem(makeItem({ slug: 'b', name: 'Bar' })).build();
            expect(out).toMatch(/- \[Foo\].*\n- \[Bar\]/);
        });
    });

    describe('end-to-end shape', () => {
        it('produces a sensible README from header → ToC → sections → items → footer', () => {
            const out = new ReadmeBuilder('# Awesome List', '## License\n\nMIT')
                .addHeader('Awesome List')
                .enableToC()
                .addSubHeader('Tools', 2)
                .addItem(makeItem({ slug: 'a', name: 'A', description: 'An A' }))
                .addItem(
                    makeItem({
                        slug: 'b',
                        name: 'B',
                        description: 'A B',
                        tags: [{ name: 't', slug: 't' }] as any,
                    }),
                    { hasDetails: true },
                )
                .build();

            expect(out.startsWith('# Awesome List\n')).toBe(true);
            expect(out).toContain('## 📑 Table of Contents');
            expect(out).toContain('- [Tools (2)](#tools)');
            expect(out).toContain('## Tools');
            expect(out).toContain('- [A](https://foo.test) - An A');
            expect(out).toContain('- [B](https://foo.test) - A B ([Read more](/details/b.md)) `t`');
            expect(out.endsWith('## License\n\nMIT')).toBe(true);
        });
    });
});
