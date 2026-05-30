import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { ApiModule } from '../api.module';
import { buildOpenApiConfig } from './openapi-document.config';

/**
 * Build-time OpenAPI spec generator.
 *
 * Emits the dereferenced OpenAPI JSON document WITHOUT starting an HTTP
 * listener or connecting to the database. The MCP image bundles the output
 * so `OpenApiLoaderService` can load it locally at runtime — see C-09
 * (`apps/api/src/main.ts`), which deliberately disables the live spec
 * endpoint in production, and the MCP's hard dependency on the spec.
 *
 * Runs under Nest **preview mode** (`{ preview: true }`): controllers and
 * routes are introspected for the document, but providers are NOT
 * instantiated and lifecycle hooks do NOT run — so no real DATABASE_URL,
 * Redis, or external services are needed during the build.
 *
 * Usage: `node dist/openapi/generate-openapi.js [outputPath]`
 *   (defaults to `openapi.json` in the current working directory)
 */
async function generateOpenApi(): Promise<void> {
    const outputPath = resolve(process.argv[2] ?? 'openapi.json');

    const app = await NestFactory.create(ApiModule, {
        preview: true,
        abortOnError: false,
        logger: ['error', 'warn'],
    });

    try {
        const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, JSON.stringify(document, null, 2), 'utf8');
        const pathCount = Object.keys(document.paths ?? {}).length;
        // eslint-disable-next-line no-console
        console.log(`Wrote OpenAPI spec (${pathCount} paths) to ${outputPath}`);
    } finally {
        await app.close();
    }
}

generateOpenApi().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to generate OpenAPI spec:', error);
    process.exit(1);
});
