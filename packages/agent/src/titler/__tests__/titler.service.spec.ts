import { TitlerService } from '../titler.service';

describe('TitlerService.generateTitle (heuristic)', () => {
    let svc: TitlerService;

    beforeEach(() => {
        svc = new TitlerService();
    });

    it('returns the first sentence of a multi-sentence prompt', async () => {
        const t = await svc.generateTitle(
            'Build a directory of cats. With breeds and care notes. By region.',
        );
        expect(t).toBe('Build a directory of cats');
    });

    it('collapses interior whitespace', async () => {
        const t = await svc.generateTitle('   Run    the   best    cats   business   ');
        expect(t).toBe('Run the best cats business');
    });

    it('strips trailing sentence punctuation', async () => {
        expect(await svc.generateTitle('Hello world!')).toBe('Hello world');
        expect(await svc.generateTitle('Hello world?')).toBe('Hello world');
        expect(await svc.generateTitle('Hello world,')).toBe('Hello world');
        expect(await svc.generateTitle('Hello world;')).toBe('Hello world');
    });

    it('clips to the default 80-char cap', async () => {
        const longInput =
            'A really comprehensive directory of every single open-source AI agent framework on GitHub';
        const t = await svc.generateTitle(longInput);
        expect(t.length).toBeLessThanOrEqual(80);
        expect(t.startsWith('A really comprehensive directory')).toBe(true);
    });

    it('respects an explicit maxChars option', async () => {
        const t = await svc.generateTitle('Build a directory of cats', { maxChars: 12 });
        expect(t.length).toBeLessThanOrEqual(12);
        expect(t).toBe('Build a dire');
    });

    it('enforces a minimum maxChars floor (8) so a zero/negative cap is ignored', async () => {
        const t = await svc.generateTitle('Build a directory of cats', { maxChars: 0 });
        // Floor is 8 — first 8 chars of the input remain.
        expect(t.length).toBeLessThanOrEqual(8);
        expect(t.length).toBeGreaterThan(0);
    });

    it('falls back to "Untitled Idea" when prompt is empty', async () => {
        expect(await svc.generateTitle('')).toBe('Untitled Idea');
        expect(await svc.generateTitle('   ')).toBe('Untitled Idea');
        expect(await svc.generateTitle('   ...    ')).toBe('Untitled Idea');
    });

    it('falls back to kind-specific default when prompt is empty', async () => {
        expect(await svc.generateTitle('', { kind: 'mission' })).toBe('Untitled Mission');
        expect(await svc.generateTitle('', { kind: 'work' })).toBe('Untitled Work');
    });

    it('handles non-string input defensively', async () => {
        // Type-erased call mimics a defensive boundary (DTO validation
        // upstream would normally catch this).
        const out = await svc.generateTitle(undefined as unknown as string);
        expect(out).toBe('Untitled Idea');
    });

    it('preserves newline-as-sentence-boundary', async () => {
        const t = await svc.generateTitle('First line\nSecond line\nThird line');
        expect(t).toBe('First line');
    });
});
