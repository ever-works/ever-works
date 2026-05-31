import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Single source of truth for the Ever Works OpenAPI document metadata.
 *
 * Shared between the runtime Swagger setup in `main.ts` (dev/non-prod only,
 * gated by C-09) and the build-time `generate-openapi` script that bundles
 * the spec into the MCP image. Keeping it here prevents the two from drifting.
 */
export function buildOpenApiConfig() {
    return new DocumentBuilder()
        .setTitle('Ever Works API')
        .setDescription(
            'The Ever Works Platform API - Build and manage AI-powered works with automated content generation, deployment, and integrations.',
        )
        .setVersion('1.0')
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                name: 'Authorization',
                description: 'Enter your JWT token',
                in: 'header',
            },
            'JWT-auth',
        )
        .addTag('Health', 'API health check endpoints')
        .addTag('Auth', 'Authentication and authorization endpoints')
        .addTag('Works', 'Work management endpoints')
        .addTag('Deploy', 'Deployment endpoints')
        .addTag('AI Conversation', 'AI-powered conversation and content generation')
        .addTag('Screenshot', 'Screenshot capture and smart image preview')
        .addTag('Subscriptions', 'Subscription and billing management')
        .addTag('Notifications', 'User notifications')
        .addTag('Members', 'Work member management')
        .build();
}
