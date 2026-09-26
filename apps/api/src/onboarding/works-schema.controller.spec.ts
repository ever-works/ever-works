import { RequestMethod } from '@nestjs/common';
import { HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_SPEC_SCHEMA_ID, WORKS_CONFIG_SCHEMA_ID } from '@ever-works/agent/works-config';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { WorksSchemaController } from './works-schema.controller';

/**
 * The controller's import path is `@ever-works/agent/works-config`, whose barrel
 * pulls the whole `works-config` feature — Nest services, DI metadata and the
 * event listener — none of which this app's test runner can load (that is why
 * no spec imported it before). Only the two **generators** are replaced here,
 * and with the real ones, reached directly: the documents these tests assert on
 * are the documents the route serves. The barrel's own re-export of them is
 * pinned in `packages/agent`'s `emit-app-spec-json-schema.spec.ts`.
 */
jest.mock('@ever-works/agent/works-config', () => ({
    ...jest.requireActual('../../../../packages/agent/src/works-config/schema/emit-json-schema'),
    ...jest.requireActual(
        '../../../../packages/agent/src/works-config/schema/emit-app-spec-json-schema',
    ),
}));

/**
 * APW-03 T8 — both published JSON Schemas, served anonymously (schema.md §25,
 * ACC-03-07).
 *
 * The routes exist for editors, not for the platform: a `yaml-language-server`
 * directive in a user's own repository fetches one of these documents with no
 * credentials and caches it. So the three things that matter are asserted here
 * rather than left to an integration test — the **exact path**, the `@Public()`
 * metadata that lets Nest's auth guard through, and the **cache and content-type
 * headers** that make the document useful to a caching editor.
 */
describe('WorksSchemaController', () => {
    const controller = new WorksSchemaController();

    const routes = [
        {
            handler: 'worksConfigSchema',
            path: 'api/schema/works.yml.schema.json',
            id: WORKS_CONFIG_SCHEMA_ID,
        },
        {
            handler: 'appSpecSchema',
            path: 'api/schema/app-spec.schema.json',
            id: APP_SPEC_SCHEMA_ID,
        },
    ] as const;

    const documentOf = (handler: (typeof routes)[number]['handler']): Record<string, unknown> =>
        (controller[handler] as () => Record<string, unknown>).call(controller);

    it.each(routes)('serves $path as a public, 5-minute-cached JSON Schema', (route) => {
        const handler = controller[route.handler] as unknown as object;

        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(route.path);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
        // Without this the auth guard answers 401 and no editor can load it.
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);

        const headers = Reflect.getMetadata(HEADERS_METADATA, handler) as Array<{
            name: string;
            value: string;
        }>;
        expect(headers).toContainEqual({ name: 'Cache-Control', value: 'public, max-age=300' });
        expect(headers).toContainEqual({
            name: 'Content-Type',
            value: 'application/schema+json; charset=utf-8',
        });
    });

    it('returns a document whose $id is the URL it is served from', () => {
        for (const route of routes) {
            const document = documentOf(route.handler);
            expect(document.$id).toBe(route.id);
            expect(new URL(String(document.$id)).pathname).toBe(`/${route.path}`);
        }
    });

    it('serves the App spec on the app route, and the envelope on the other', () => {
        const works = documentOf('worksConfigSchema');
        const appSpec = documentOf('appSpecSchema');

        // The App document is the envelope's `$defs.appSpec` plus its own root
        // keywords, so the two routes cannot drift — and they are not the same
        // document.
        const appSpecBody = Object.fromEntries(
            Object.entries(appSpec).filter(([key]) => key !== '$id' && key !== '$schema'),
        );
        expect((works.$defs as Record<string, unknown>).appSpec).toEqual(appSpecBody);
        expect(appSpec.$id).not.toBe(works.$id);
        expect(Object.keys(appSpec.properties as object)).toContain('components');
        // The envelope's own keys are the v1 ones; the App document has none of them.
        expect(Object.keys(appSpec.properties as object)).not.toContain('initial_prompt');
        expect(Object.keys(works.properties as object)).toContain('initial_prompt');
    });

    it('publishes the x- allowance the runtime strips (schema.md §2:74-75)', () => {
        expect(documentOf('appSpecSchema').patternProperties).toEqual({ '^x-': {} });
    });

    it('answers the same document on every call (no per-request work)', () => {
        expect(documentOf('appSpecSchema')).toBe(documentOf('appSpecSchema'));
        expect(documentOf('worksConfigSchema')).toBe(documentOf('worksConfigSchema'));
    });
});
