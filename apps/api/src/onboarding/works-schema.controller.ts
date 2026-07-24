import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { buildWorksConfigJsonSchema } from '@ever-works/agent/works-config';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Publishes the JSON Schema for `.works/works.yml`.
 *
 * Public and cacheable because it is meant to be referenced directly from a
 * user's own repository:
 *
 *     # yaml-language-server: $schema=https://api.ever.works/api/schema/works.yml.schema.json
 *
 * Editors fetch it anonymously to drive completion and inline validation, so
 * requiring auth here would make the schema useless for exactly the case it
 * exists to serve. The document is generated from the same zod schema the
 * server validates with, so the two cannot drift.
 */
@ApiExcludeController()
@Controller()
export class WorksSchemaController {
    /** Generated once — the schema is static for the lifetime of the process. */
    private readonly schema = buildWorksConfigJsonSchema();

    @Public()
    @Get('api/schema/works.yml.schema.json')
    @Header('Cache-Control', 'public, max-age=300')
    @Header('Content-Type', 'application/schema+json; charset=utf-8')
    worksConfigSchema(): Record<string, unknown> {
        return this.schema;
    }
}
