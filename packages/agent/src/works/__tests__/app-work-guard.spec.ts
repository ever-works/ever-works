import { BadRequestException } from '@nestjs/common';

import { APP_WORK_REFUSAL, assertNotAppWork, isAppWork } from '../app-work-guard';
import { REPOSITORY_WORK_REFUSAL, assertNotRepositoryWork } from '../repository-work-guard';

/**
 * APW-01 T9 (lane aw-safety, 2026-10-26) — the App Work guard (ACC-01-11): refuses `app`, passes
 * every other kind, in the exact message shape of the repository guard.
 */
describe('app-work-guard', () => {
    it('recognises the app kind through the contracts’ normalisation', () => {
        expect(isAppWork({ kind: 'app' })).toBe(true);
        expect(isAppWork({ kind: ' APP ' })).toBe(true);
        expect(isAppWork({ kind: 'repo' })).toBe(false);
        expect(isAppWork({ kind: 'directory' })).toBe(false);
        expect(isAppWork({ kind: 'default' })).toBe(false);
        expect(isAppWork({ kind: 'unknown-kind' })).toBe(false);
        expect(isAppWork({})).toBe(false);
        expect(isAppWork(null)).toBe(false);
    });

    it('refuses an App Work with a 400 that names the Work and the action', () => {
        let caught: unknown;
        try {
            assertNotAppWork({ kind: 'app', name: 'Cal' }, 'item submission');
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(BadRequestException);
        const message = String((caught as BadRequestException).message);
        expect(message).toContain('Work "Cal"');
        expect(message).toContain(APP_WORK_REFUSAL);
        expect(message).toContain('item submission is not available for it');
    });

    it.each(['repo', 'default', 'directory', 'website', 'unknown-kind', undefined])(
        'passes kind %s',
        (kind) => {
            expect(() => assertNotAppWork({ kind, slug: 'w' }, 'item submission')).not.toThrow();
        },
    );

    it('has the same message shape as the repository guard, and leaves it unchanged', () => {
        const shape = (fn: () => void): string => {
            try {
                fn();
            } catch (error) {
                return String((error as Error).message).replace(
                    / is an? [A-Z][a-z]+ Work — .*$/,
                    '',
                );
            }
            return '';
        };

        expect(shape(() => assertNotAppWork({ kind: 'app', slug: 'w' }, 'x'))).toBe('Work "w"');
        expect(shape(() => assertNotRepositoryWork({ kind: 'repo', slug: 'w' }, 'x'))).toBe(
            'Work "w"',
        );
        expect(REPOSITORY_WORK_REFUSAL).toBe('is a Repository Work');
    });
});
