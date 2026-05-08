import {
    GENERATION_CANCELLED,
    GIT_TOKEN_NOT_AVAILABLE,
    IMPORT_CANCELLED,
} from './messages';
import * as constantsBarrel from './index';

describe('constants/messages.ts', () => {
    describe('exact string literals (consumers grep these)', () => {
        it('GENERATION_CANCELLED equals "Generation cancelled"', () => {
            expect(GENERATION_CANCELLED).toBe('Generation cancelled');
        });

        it('IMPORT_CANCELLED equals "Import cancelled"', () => {
            expect(IMPORT_CANCELLED).toBe('Import cancelled');
        });

        it('GIT_TOKEN_NOT_AVAILABLE equals "GitHub token not available"', () => {
            expect(GIT_TOKEN_NOT_AVAILABLE).toBe('GitHub token not available');
        });
    });

    describe('compile-time const-ness (TS readonly behavior)', () => {
        it('all three are non-empty strings', () => {
            for (const value of [GENERATION_CANCELLED, IMPORT_CANCELLED, GIT_TOKEN_NOT_AVAILABLE]) {
                expect(typeof value).toBe('string');
                expect(value.length).toBeGreaterThan(0);
            }
        });

        it('the three messages are distinct from one another', () => {
            const values = new Set([
                GENERATION_CANCELLED,
                IMPORT_CANCELLED,
                GIT_TOKEN_NOT_AVAILABLE,
            ]);
            expect(values.size).toBe(3);
        });
    });

    describe('barrel re-export', () => {
        it('index.ts re-exports all three constants verbatim', () => {
            expect(constantsBarrel.GENERATION_CANCELLED).toBe(GENERATION_CANCELLED);
            expect(constantsBarrel.IMPORT_CANCELLED).toBe(IMPORT_CANCELLED);
            expect(constantsBarrel.GIT_TOKEN_NOT_AVAILABLE).toBe(GIT_TOKEN_NOT_AVAILABLE);
        });

        it('barrel exposes exactly the three message constants and nothing else', () => {
            const exported = Object.keys(constantsBarrel).sort();
            expect(exported).toEqual([
                'GENERATION_CANCELLED',
                'GIT_TOKEN_NOT_AVAILABLE',
                'IMPORT_CANCELLED',
            ]);
        });
    });
});
