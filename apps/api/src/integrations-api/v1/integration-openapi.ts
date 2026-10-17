import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { IntegrationsApiV1Module } from './integrations-api-v1.module';

/** Where the integration API's OpenAPI document is served (every environment). */
export const INTEGRATION_OPENAPI_PATH = '/api/integrations/v1/openapi.json';

/**
 * The OpenAPI document of `/api/integrations/v1` ONLY (EW-P1-4, contract v1).
 *
 * Unlike the general `/api/openapi.json` (non-production only: it inventories
 * every internal route), this one describes nothing but the integration
 * namespace — a published, stable contract — so it is served in production
 * too, with the two schemes integrations authenticate with: `Authorization:
 * Bearer ew_int_…` and `x-api-key`.
 */
export function buildIntegrationOpenApiDocument(app: INestApplication): OpenAPIObject {
    const config = new DocumentBuilder()
        .setTitle('Ever Works Integration API')
        .setDescription(
            'Integration API v1 (`/api/integrations/v1`): the stable contract integrations (Ever Gauzy and others) code against. JSON Schemas and webhook signature vectors: docs/specs/features/integrations-api-v1/contract/.',
        )
        .setVersion('1')
        .addBearerAuth({
            type: 'http',
            scheme: 'bearer',
            description: 'An integration key (`ew_int_…`).',
        })
        .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'x-api-key')
        .build();
    const document = SwaggerModule.createDocument(app, config, {
        include: [IntegrationsApiV1Module],
    });
    document.security = [{ bearer: [] }, { 'x-api-key': [] }];
    return document;
}

/** Mount `GET /api/integrations/v1/openapi.json` (public, every environment). */
export function serveIntegrationOpenApi(app: INestApplication): void {
    const document = buildIntegrationOpenApiDocument(app);
    const adapter = app.getHttpAdapter();
    adapter.get(INTEGRATION_OPENAPI_PATH, (_req: unknown, res: { json(body: unknown): void }) => {
        res.json(document);
    });
}
