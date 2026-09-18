import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { buildAppSpecJsonSchema, buildWorksConfigJsonSchema } from '@ever-works/agent/works-config';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Publishes the JSON Schemas for `.works/works.yml` and for the App spec.
 *
 * Public and cacheable because they are meant to be referenced directly from a
 * user's own repository:
 *
 *     # yaml-language-server: $schema=https://api.ever.works/api/schema/works.yml.schema.json
 *     # yaml-language-server: $schema=https://api.ever.works/api/schema/app-spec.schema.json
 *
 * Editors fetch them anonymously to drive completion and inline validation, so
 * requiring auth here would make a schema useless for exactly the case it exists
 * to serve. Both documents are generated from the same zod schemas the server
 * validates with, so the published schema and the runtime cannot drift — and the
 * App spec document is the very object `works.yml.schema.json` embeds as
 * `$defs.appSpec` (`app-spec.schema.json` §25, APW-03 T8).
 *
 * The App spec's own `$id` is `https://api.ever.works/api/schema/app-spec.schema.json`
 * (`APP_SPEC_SCHEMA_ID`), which is why the route below is spelled exactly that
 * way: a `$schema` pointing here resolves to the document served here.
 */
@ApiExcludeController()
@Controller()
export class WorksSchemaController {
    /** Generated once — the schemas are static for the lifetime of the process. */
    private readonly schema = buildWorksConfigJsonSchema();

    /** The stand-alone App spec document — `$defs.appSpec` of {@link schema}, published on its own. */
    private readonly appSpecDocument = buildAppSpecJsonSchema();

    @Public()
    @Get('api/schema/works.yml.schema.json')
    @Header('Cache-Control', 'public, max-age=300')
    @Header('Content-Type', 'application/schema+json; charset=utf-8')
    worksConfigSchema(): Record<string, unknown> {
        return this.schema;
    }

    @Public()
    @Get('api/schema/app-spec.schema.json')
    @Header('Cache-Control', 'public, max-age=300')
    @Header('Content-Type', 'application/schema+json; charset=utf-8')
    appSpecSchema(): Record<string, unknown> {
        return this.appSpecDocument;
    }
}
