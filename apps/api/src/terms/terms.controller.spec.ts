import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '@nestjs/common';
import { TermsController } from './terms.controller';

/**
 * Route-prefix guard.
 *
 * This app has no `setGlobalPrefix`: every controller carries the `api/`
 * segment itself. That convention is invisible until it is broken, and breaking
 * it is silent — the route still registers, it just answers on a path nobody
 * calls.
 *
 * `TermsController` was declared `@Controller('terms')`, so it served
 * `/terms/required`. The web app reaches the API through `API_URL`, which
 * `apps/web/src/lib/constants.ts` guarantees ends in `/api`, so the register
 * page requested `/api/terms/required` and got a 404. It swallowed the error,
 * passed the form an empty document list, and the form — correctly refusing to
 * record an acceptance it could not identify — rendered the checkbox
 * `disabled`. Every signup on stage and production was blocked, with no error
 * anywhere: a 200 page containing a form that could not be submitted.
 *
 * Nothing caught it. Unit tests do not exercise route paths, and no e2e test
 * asserts that the register page can actually be submitted.
 */
describe('API route prefix convention', () => {
    it('serves TermsController under api/', () => {
        // Reflect the real registered path rather than trusting the source text.
        const path = Reflect.getMetadata('path', TermsController);
        expect(path).toBe('api/terms');
    });

    it('publishes the required-documents route where the web app looks for it', () => {
        const controllerPath = Reflect.getMetadata('path', TermsController) as string;
        const routePath = Reflect.getMetadata(
            'path',
            TermsController.prototype.getRequired,
        ) as string;

        // `serverFetch` builds `${API_URL}${endpoint}` where API_URL always ends
        // in `/api` and endpoint is `/terms/required`.
        expect(`/${controllerPath}/${routePath}`).toBe('/api/terms/required');
    });

    /**
     * The class-wide guard. Source-level on purpose: importing every controller
     * drags in the DI graph and TypeORM, which is exactly what
     * `_entity-names.ts` exists to avoid elsewhere in this repo.
     */
    it('declares every controller under api/ (or a deliberate exception)', () => {
        // Routes that are intentionally NOT part of the public `/api` surface.
        const EXEMPT = new Set(['internal/trigger']);

        const srcRoot = join(__dirname, '..');
        const offenders: string[] = [];

        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full);
                    continue;
                }
                if (!entry.name.endsWith('.controller.ts')) continue;

                const source = readFileSync(full, 'utf-8');
                for (const [, declared] of source.matchAll(/@Controller\(\s*'([^']*)'\s*\)/g)) {
                    if (EXEMPT.has(declared)) continue;
                    if (declared === 'api' || declared.startsWith('api/')) continue;
                    offenders.push(`${entry.name}: @Controller('${declared}')`);
                }
            }
        };

        walk(srcRoot);

        expect(offenders).toEqual([]);
    });
});
