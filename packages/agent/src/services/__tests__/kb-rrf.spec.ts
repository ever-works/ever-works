import { rrfBlend } from '../kb-rrf';

describe('rrfBlend', () => {
    describe('boundary cases', () => {
        it('returns [] for empty rankings input', () => {
            expect(rrfBlend([])).toEqual([]);
        });

        it('returns [] when every input list is empty', () => {
            expect(rrfBlend([[], []])).toEqual([]);
        });

        it('throws RangeError on negative k', () => {
            expect(() => rrfBlend([], { k: -1 })).toThrow(RangeError);
        });

        it('throws RangeError on non-finite k', () => {
            expect(() => rrfBlend([], { k: Number.POSITIVE_INFINITY })).toThrow(RangeError);
            expect(() => rrfBlend([], { k: Number.NaN })).toThrow(RangeError);
        });

        it('accepts k = 0 (formula stays well-defined via the +1 denominator)', () => {
            const out = rrfBlend([[{ documentId: 'a' }]], { k: 0 });
            // rank 0 with k=0 → 1 / (0 + 0 + 1) = 1
            expect(out).toEqual([{ documentId: 'a', score: 1 }]);
        });
    });

    describe('single-list passthrough', () => {
        it('preserves the rank order from a single input list', () => {
            const out = rrfBlend([[{ documentId: 'a' }, { documentId: 'b' }, { documentId: 'c' }]]);
            // With default k=60: ranks 0,1,2 → 1/61, 1/62, 1/63
            expect(out.map((r) => r.documentId)).toEqual(['a', 'b', 'c']);
            expect(out[0].score).toBeCloseTo(1 / 61, 10);
            expect(out[1].score).toBeCloseTo(1 / 62, 10);
            expect(out[2].score).toBeCloseTo(1 / 63, 10);
        });
    });

    describe('multi-list blending', () => {
        it('docs appearing in both lists outrank docs in only one (with equal rank)', () => {
            const lexical = [{ documentId: 'a' }, { documentId: 'b' }];
            const semantic = [{ documentId: 'b' }, { documentId: 'c' }];
            const out = rrfBlend([lexical, semantic]);

            // 'b' is rank 1 in lex (1/62) + rank 0 in sem (1/61)
            // 'a' is rank 0 in lex (1/61) only
            // 'c' is rank 1 in sem (1/62) only
            // So 'b' wins, then 'a', then 'c'.
            expect(out.map((r) => r.documentId)).toEqual(['b', 'a', 'c']);
            expect(out[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
            expect(out[1].score).toBeCloseTo(1 / 61, 10);
            expect(out[2].score).toBeCloseTo(1 / 62, 10);
        });

        it('disjoint lists produce a union ranked by per-list score', () => {
            const lexical = [{ documentId: 'a' }, { documentId: 'b' }];
            const semantic = [{ documentId: 'c' }, { documentId: 'd' }];
            const out = rrfBlend([lexical, semantic]);

            // All four docs at the same per-list rank → tied by score
            // 'a' and 'c' both at 1/61; 'b' and 'd' both at 1/62.
            // Tiebreak: documentId ASC → 'a','c' (in that order), then 'b','d'.
            expect(out.map((r) => r.documentId)).toEqual(['a', 'c', 'b', 'd']);
        });

        it('three-list blend sums contributions correctly', () => {
            const lex = [{ documentId: 'x' }];
            const sem = [{ documentId: 'x' }];
            const recent = [{ documentId: 'x' }];
            const out = rrfBlend([lex, sem, recent]);

            expect(out).toEqual([{ documentId: 'x', score: 3 / 61 }]);
        });
    });

    describe('stability + defensiveness', () => {
        it('breaks ties by documentId ASC (stable across runs)', () => {
            // Two docs at the same rank in the same list → identical
            // scores → stable tiebreak.
            const list = [{ documentId: 'b' }, { documentId: 'a' }];
            const out = rrfBlend([list]);
            // Even though 'a' was at rank 1 (score 1/62) and 'b' at
            // rank 0 (1/61), they don't tie here — 'b' wins. But the
            // sort tiebreak in general is documented to be id ASC; the
            // disjoint-list test above covers the tied case.
            expect(out.map((r) => r.documentId)).toEqual(['b', 'a']);
        });

        it('ignores duplicate documentId within a single list (first occurrence wins)', () => {
            const list = [{ documentId: 'a' }, { documentId: 'a' }, { documentId: 'b' }];
            const out = rrfBlend([list]);
            // 'a' counted once at rank 0 (1/61), 'b' at rank 2 (1/63).
            // If duplicates inflated the score, 'a' would also pick up
            // 1/62 from its second occurrence — this test guards
            // against that bug.
            expect(out).toEqual([
                { documentId: 'a', score: 1 / 61 },
                { documentId: 'b', score: 1 / 63 },
            ]);
        });

        it('honors a custom k', () => {
            const out = rrfBlend([[{ documentId: 'a' }]], { k: 10 });
            expect(out).toEqual([{ documentId: 'a', score: 1 / 11 }]);
        });

        it('ignores empty inner lists without affecting other lists', () => {
            const lex = [{ documentId: 'a' }];
            const sem: ReadonlyArray<{ documentId: string }> = [];
            const out = rrfBlend([lex, sem]);
            expect(out).toEqual([{ documentId: 'a', score: 1 / 61 }]);
        });
    });
});
