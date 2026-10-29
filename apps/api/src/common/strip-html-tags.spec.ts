import { MAX_TAG_STRIP_PASSES, stripHtmlTags } from './strip-html-tags';

describe('stripHtmlTags', () => {
    it('removes tags, keeping the text between them', () => {
        expect(stripHtmlTags('<b>Hello</b> <script>x</script>world')).toBe('Hello xworld');
    });

    it('removes a tag a removal spliced together, so no markup is left', () => {
        expect(stripHtmlTags('<scr<b>ipt>alert(1)</script>')).toBe('alert(1)');
        expect(stripHtmlTags('<<img src=x onerror=1>img src=y onerror=2>x')).toBe('x');
    });

    it('keeps arrows and comparisons readable', () => {
        expect(stripHtmlTags('a -> b, 1 > 0, x < y')).toBe('a -> b, 1 > 0, x < y');
    });

    it('drops a stray opener a capped run leaves, so nothing can start a tag', () => {
        const nested = `${'<'.repeat(MAX_TAG_STRIP_PASSES + 4)}script${'>'.repeat(MAX_TAG_STRIP_PASSES + 4)}`;
        expect(stripHtmlTags(nested)).not.toMatch(/<[a-z/!?]/i);
    });

    it('leaves no tag at the cap boundary either (review of #3029)', () => {
        for (let extra = 0; extra < 4; extra++) {
            const n = MAX_TAG_STRIP_PASSES + extra;
            const out = stripHtmlTags(`${'<'.repeat(n)}script${'>'.repeat(n)}`);
            expect(out).not.toMatch(/<[a-z/!?]/i);
        }
    });

    it('stays fast on a long run of unclosed openers', () => {
        const started = Date.now();
        stripHtmlTags('<'.repeat(100_000));
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});
