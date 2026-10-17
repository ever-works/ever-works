import {
    Body,
    Controller,
    HttpCode,
    HttpStatus,
    Post,
    Req,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import type { AddressInfo } from 'node:net';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import { validationFailed } from './integration-request';

export const BATCH_MAX_OPERATIONS = 100;
const BATCH_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
const PREFIX = '/api/integrations/v1';
/** Per-operation request headers a batch may set (contract v1 `Batch`). */
const OPERATION_HEADERS = ['idempotency-key', 'if-match', 'x-act-as-user', 'x-sync-origin'];
/** Headers every operation takes from the outer request. */
const OUTER_HEADERS = [
    'authorization',
    'x-api-key',
    'x-scope-slug',
    'x-organization-id',
    'x-sync-origin',
    'x-act-as-user',
];
const OPERATION_TIMEOUT_MS = 60_000;

export class IntegrationBatchOperationDto {
    @ApiProperty({ enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] })
    @IsIn(BATCH_METHODS)
    method!: (typeof BATCH_METHODS)[number];

    @ApiProperty({ description: 'Relative to /api/integrations/v1, e.g. /tasks/<id>.' })
    @IsString()
    @MaxLength(2048)
    path!: string;

    @ApiProperty({
        required: false,
        description:
            'Per-operation Idempotency-Key, If-Match, X-Act-As-User. Auth and X-Scope-Slug come from the outer request.',
    })
    @IsOptional()
    @IsObject()
    headers?: Record<string, string>;

    @ApiProperty({ required: false })
    @IsOptional()
    body?: unknown;
}

/** `Batch` (contract v1 requests.schema.json). */
export class IntegrationBatchDto {
    @ApiProperty({
        type: () => IntegrationBatchOperationDto,
        isArray: true,
        minItems: 1,
        maxItems: 100,
    })
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(BATCH_MAX_OPERATIONS)
    @ValidateNested({ each: true })
    @Type(() => IntegrationBatchOperationDto)
    operations!: IntegrationBatchOperationDto[];
}

export interface IntegrationBatchResult {
    readonly results: Array<{ status: number; body: unknown }>;
}

interface OuterRequest {
    readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * `POST /api/integrations/v1/batch` (EW-P1-4, contract v1 B.6): at most 100
 * operations, run IN ORDER and NOT atomically; the answer is one
 * `{status, body}` per operation, in the same order.
 *
 * Each operation is a real request to this API over loopback, carrying the
 * outer request's credential and organization pin, so it goes through every
 * guard, scope check, validation pipe and rate limit exactly as if the
 * integration had sent it (each operation counts against the key's limits).
 * An operation may only address `/api/integrations/v1/*` and never `/batch`
 * itself; its headers are limited to `Idempotency-Key`, `If-Match`,
 * `X-Act-As-User` and `X-Sync-Origin`.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationBatchController {
    constructor(private readonly adapterHost: HttpAdapterHost) {}

    @Post('batch')
    // Any integration key: each operation is scope-checked on its own route.
    @RequireScopes()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Run up to 100 operations in order (not atomic)' })
    async batch(
        @Body() dto: IntegrationBatchDto,
        @Req() req: OuterRequest,
    ): Promise<IntegrationBatchResult> {
        const urls = dto.operations.map((operation, index) => operationPath(operation.path, index));
        const base = this.baseUrl();
        const results: Array<{ status: number; body: unknown }> = [];
        for (const [index, operation] of dto.operations.entries()) {
            results.push(await this.run(base, urls[index], operation, req));
        }
        return { results };
    }

    private async run(
        base: string,
        path: string,
        operation: IntegrationBatchOperationDto,
        req: OuterRequest,
    ): Promise<{ status: number; body: unknown }> {
        const headers: Record<string, string> = { accept: 'application/json' };
        for (const name of OUTER_HEADERS) {
            const value = req.headers[name];
            const first = Array.isArray(value) ? value[0] : value;
            if (first) headers[name] = first;
        }
        for (const [name, value] of Object.entries(operation.headers ?? {})) {
            const lower = name.toLowerCase();
            if (OPERATION_HEADERS.includes(lower) && typeof value === 'string') {
                headers[lower] = value;
            }
        }
        const hasBody = operation.body !== undefined && operation.method !== 'GET';
        if (hasBody) headers['content-type'] = 'application/json';
        try {
            const response = await fetch(base + path, {
                method: operation.method,
                headers,
                body: hasBody ? JSON.stringify(operation.body) : undefined,
                redirect: 'manual',
                signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
            });
            return { status: response.status, body: await readBody(response) };
        } catch {
            return {
                status: HttpStatus.SERVICE_UNAVAILABLE,
                body: {
                    error: {
                        code: 'internal_error',
                        message: 'The operation did not complete; retry with back-off.',
                    },
                },
            };
        }
    }

    /** This process's own listener (loopback), whatever port it was given. */
    private baseUrl(): string {
        const server = this.adapterHost.httpAdapter?.getHttpServer() as
            | { address(): AddressInfo | string | null }
            | undefined;
        const address = server?.address();
        const port =
            address && typeof address === 'object'
                ? address.port
                : Number(process.env.PORT ?? 3100);
        return `http://127.0.0.1:${port}`;
    }
}

/**
 * The operation's path under `/api/integrations/v1`, normalised (dot segments
 * resolved) and checked to stay there; `/batch` is refused (no nesting).
 */
export function operationPath(path: string, index: number): string {
    const field = `operations[${index}].path`;
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
        throw validationFailed(
            field,
            'must be a path relative to /api/integrations/v1, e.g. /tasks/<id>',
        );
    }
    let url: URL;
    try {
        url = new URL(PREFIX + path, 'http://batch.invalid');
    } catch {
        throw validationFailed(field, 'is not a valid path');
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    if (
        !pathname.startsWith(`${PREFIX}/`) ||
        /^\/api\/integrations\/v1\/batch(\/|$)/i.test(pathname)
    ) {
        throw validationFailed(field, 'must address /api/integrations/v1 and not /batch');
    }
    return pathname + url.search;
}

async function readBody(response: Response): Promise<unknown> {
    if (response.status === HttpStatus.NO_CONTENT) return null;
    const text = await response.text();
    if (!text) return null;
    if ((response.headers.get('content-type') ?? '').includes('json')) {
        try {
            return JSON.parse(text) as unknown;
        } catch {
            return text;
        }
    }
    return text;
}
