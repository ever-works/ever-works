// The `@ever-works/agent/services` barrel pulls in the whole agent graph (work module ->
// subscriptions -> api notifications/auth -> ESM-only better-auth, website-generator
// config), which this jest environment cannot load. The controller only needs these
// classes as DI tokens and the spec hands it fakes: stub the barrel, as the other api
// specs do.
jest.mock('@ever-works/agent/services', () => ({
    KnowledgeBaseService: class KnowledgeBaseService {},
    KnowledgeLibraryService: class KnowledgeLibraryService {},
    WorkLifecycleService: class WorkLifecycleService {},
    WorkQueryService: class WorkQueryService {},
    KnowledgeBaseModule: class KnowledgeBaseModule {},
    KnowledgeLibraryModule: class KnowledgeLibraryModule {},
    WorkModule: class WorkModule {},
}));

// The `@ever-works/agent/missions` barrel pulls in the whole agent graph (work module ->
// subscriptions -> api notifications/auth -> ESM-only better-auth, website-generator
// config), which this jest environment cannot load. The controller only needs these
// classes as DI tokens and the spec hands it fakes: stub the barrel, as the other api
// specs do.
jest.mock('@ever-works/agent/missions', () => ({
    MissionsService: class MissionsService {},
    MissionsModule: class MissionsModule {},
}));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    InternalServerErrorException,
    NotFoundException,
} from '@nestjs/common';
import Ajv2020 from 'ajv/dist/2020';
import { getMetadataStorage } from 'class-validator';
import {
    AggregateVersionConflictError,
    DomainEventCursorExpiredError,
} from '@ever-works/agent/domain-events';
import {
    DuplicateExternalRefError,
    IdempotencyConflictError,
    InvalidCursorError,
    ResourceNotFoundError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import {
    INTEGRATION_ERROR_CODES,
    INTEGRATION_KINDS,
    INTEGRATION_SCOPES,
} from '@ever-works/contracts';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import { IntegrationBatchDto, IntegrationBatchOperationDto } from '../batch.controller';
import {
    IntegrationInboundAttachmentDto,
    IntegrationInboundEmailDto,
    IntegrationInboundMessageDto,
} from '../email.controller';
import { IntegrationInboxReplyDto, IntegrationInboxStateDto } from '../inbox.controller';
import {
    IntegrationCreateKbDocumentDto,
    IntegrationCreateKbFolderDto,
    IntegrationKbScopeDto,
    IntegrationMoveKbDocumentDto,
    IntegrationUpdateKbDocumentDto,
    IntegrationUpdateKbFolderDto,
} from '../kb.controller';
import {
    IntegrationCreateGoalDto,
    IntegrationGoalCriterionDto,
    IntegrationGoalDoDCriterionDto,
    IntegrationGoalMetricSourceDto,
    IntegrationGoalSampleDto,
    IntegrationPutGoalCriteriaDto,
    IntegrationPutGoalDodDto,
    IntegrationUpdateGoalDto,
} from '../goals.controller';
import { IntegrationCreateIdeaDto, IntegrationUpdateIdeaDto } from '../ideas.controller';
import { IntegrationExceptionFilter } from '../integration-exception.filter';
import { IntegrationPutLinkDto } from '../links.controller';
import {
    IntegrationCreateMissionDto,
    IntegrationMissionGoalLinkDto,
    IntegrationMissionWorkLinkDto,
    IntegrationPutMissionGoalsDto,
    IntegrationPutMissionWorksDto,
    IntegrationUpdateMissionDto,
} from '../missions.controller';
import { IntegrationCreateOrganizationDto } from '../organizations-write.controller';
import { IntegrationInviteMemberDto } from '../members-write.controller';
import {
    IntegrationCreateCommentDto,
    IntegrationExternalAuthorDto,
    IntegrationUpdateCommentDto,
} from '../task-comments.controller';
import {
    IntegrationRelationRefDto,
    PutTaskAssigneesDto,
    PutTaskBlocksDto,
    PutTaskRelationsDto,
    PutTaskWatchersDto,
} from '../tasks-sets.controller';
import {
    IntegrationCreateTaskDto,
    IntegrationExternalRefDto,
    IntegrationPrincipalRefDto,
    IntegrationTransitionTaskDto,
    IntegrationUpdateTaskDto,
} from '../tasks-write.controller';
import {
    IntegrationCreateTeamDto,
    IntegrationTeamMemberRefDto,
    IntegrationTeamResourceRefDto,
    IntegrationUpdateTeamDto,
    PutTeamMembersDto,
    PutTeamResourcesDto,
} from '../teams-write.controller';
import { IntegrationCreateWebhookDto, IntegrationUpdateWebhookDto } from '../webhooks.controller';
import { IntegrationWhoamiController } from '../whoami.controller';
import { IntegrationCreateWorkDto } from '../works-write.controller';

/**
 * EW-P1-8 (T25, T17b) — the API side of the published contract
 * (`docs/specs/features/integrations-api-v1/contract/`) is the code:
 *
 * - every request body schema matches the class-validator DTO the route
 *   validates with — same properties, same required ones. The app runs
 *   `ValidationPipe({ whitelist, forbidNonWhitelisted })`, so a property the
 *   schema allows and the DTO lacks would answer `400` to a valid request,
 *   and one the DTO takes but the schema omits is an undocumented field;
 * - every DTO property carries `@ApiProperty`, so the OpenAPI document
 *   (`/api/integrations/v1/openapi.json`) shows the whole body (T17b);
 * - every error the integration routes can answer is a valid envelope, with
 *   a status ↔ code pair the schema lists;
 * - the vocabularies (scopes, error codes, integration kinds) are the
 *   TypeScript ones;
 * - `GET /whoami` answers its schema.
 *
 * Resource DTOs and event `data` are checked where they are built
 * (`packages/agent`: the integration services' and the recording specs).
 */
const CONTRACT_DIR = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'specs',
    'features',
    'integrations-api-v1',
    'contract',
);
const SCHEMAS_DIR = join(CONTRACT_DIR, 'schemas');
const BASE = 'https://ever.works/schemas/integrations/v1/';

type JsonSchema = Record<string, unknown> & {
    $ref?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    additionalProperties?: unknown;
};

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return name.endsWith('.schema.json') ? [path] : [];
    });
}

/** Every schema file, keyed by its path relative to `schemas/` (posix). */
const SCHEMA_FILES = new Map<string, JsonSchema>(
    walk(SCHEMAS_DIR).map((path) => [
        path.slice(SCHEMAS_DIR.length + 1).replace(/\\/g, '/'),
        JSON.parse(readFileSync(path, 'utf8')) as JsonSchema,
    ]),
);

function schemaFile(relative: string): JsonSchema {
    const schema = SCHEMA_FILES.get(relative);
    if (!schema) throw new Error(`no contract schema ${relative}`);
    return schema;
}

/** A `$ref` resolved against the file it appears in; answers the target and its file. */
function resolveRef(ref: string, fromFile: string): { schema: JsonSchema; file: string } {
    const [filePart, pointer = ''] = ref.split('#');
    const file = filePart
        ? posix.normalize(posix.join(posix.dirname(fromFile), filePart))
        : fromFile;
    let node: unknown = schemaFile(file);
    for (const segment of pointer.split('/').filter(Boolean)) {
        node = (node as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
        if (node === undefined) throw new Error(`unresolved $ref ${ref} (from ${fromFile})`);
    }
    return { schema: node as JsonSchema, file };
}

/**
 * The object schema a property describes: through `$ref`s, array `items` and
 * a nullable `anyOf` / `oneOf`. `null` when it is not an object.
 */
function objectSchemaOf(
    schema: JsonSchema,
    file: string,
): { schema: JsonSchema; file: string } | null {
    if (schema.$ref) {
        const target = resolveRef(schema.$ref, file);
        return objectSchemaOf(target.schema, target.file);
    }
    if (schema.properties) return { schema, file };
    if (schema.items) return objectSchemaOf(schema.items, file);
    for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
        const found = objectSchemaOf(branch, file);
        if (found) return found;
    }
    return null;
}

/** The DTO's whitelisted properties (any class-validator decorator) and the optional ones. */
function dtoShape(dto: new () => object): {
    properties: Set<string>;
    optional: Set<string>;
    allowed: Map<string, unknown[]>;
} {
    const metadata = getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false);
    const properties = new Set(metadata.map((entry) => entry.propertyName));
    // `@IsOptional()` only: a bare `@ValidateIf(v => v !== null)` makes a
    // property nullable, still required (e.g. MoveKbDocument.folderId).
    const optional = new Set(
        metadata
            .filter(
                (entry) => entry.type === 'conditionalValidation' && entry.name === 'isOptional',
            )
            .map((entry) => entry.propertyName),
    );
    // `@IsIn(values)` (also `{ each: true }` on arrays): the values it accepts.
    const allowed = new Map<string, unknown[]>();
    for (const entry of metadata) {
        if (entry.name === 'isIn' && Array.isArray(entry.constraints?.[0])) {
            allowed.set(entry.propertyName, entry.constraints[0] as unknown[]);
        }
    }
    return { properties, optional, allowed };
}

/**
 * The values a property schema allows (`const` / `enum`, through `$ref`s and
 * array `items`), without `null` (nullability is `@IsOptional`'s business).
 * `null` when the schema does not enumerate them.
 */
function schemaValues(schema: JsonSchema, file: string): unknown[] | null {
    if (schema.$ref) {
        const target = resolveRef(schema.$ref, file);
        return schemaValues(target.schema, target.file);
    }
    if ('const' in schema) return [schema.const];
    if (Array.isArray(schema.enum)) return schema.enum.filter((value) => value !== null);
    if (schema.items) return schemaValues(schema.items, file);
    return null;
}

const sortedValues = (values: readonly unknown[]): string[] => values.map(String).sort();

/** Where `@nestjs/swagger` lists each `@ApiProperty` (as `:name`) on the prototype. */
const SWAGGER_PROPERTIES = 'swagger/apiModelPropertiesArray';

/** The DTO's properties the OpenAPI document shows. */
function documentedProperties(dto: new () => object): Set<string> {
    const names =
        (Reflect.getMetadata(SWAGGER_PROPERTIES, dto.prototype) as string[] | undefined) ?? [];
    return new Set(names.map((name) => name.replace(/^:/, '')));
}

interface BodyPair {
    readonly dto: new () => object;
    /** Nested bodies (`@ValidateNested` + `@Type`), by property. */
    readonly nested?: Readonly<Record<string, BodyPair>>;
}

const EXTERNAL_REF: BodyPair = { dto: IntegrationExternalRefDto };
const GOAL_METRIC_SOURCE: BodyPair = { dto: IntegrationGoalMetricSourceDto };
const GOAL_CRITERION: BodyPair = {
    dto: IntegrationGoalCriterionDto,
    nested: { metricSource: GOAL_METRIC_SOURCE },
};
const GOAL_DOD_ITEM: BodyPair = { dto: IntegrationGoalDoDCriterionDto };

/** `requests.schema.json` `$defs` → the DTO its route validates the body with. */
const REQUEST_BODIES: Readonly<Record<string, BodyPair>> = {
    CreateTeam: { dto: IntegrationCreateTeamDto, nested: { externalRef: EXTERNAL_REF } },
    UpdateTeam: { dto: IntegrationUpdateTeamDto },
    PutTeamMembers: {
        dto: PutTeamMembersDto,
        nested: { members: { dto: IntegrationTeamMemberRefDto } },
    },
    PutTeamResources: {
        dto: PutTeamResourcesDto,
        nested: { resources: { dto: IntegrationTeamResourceRefDto } },
    },
    CreateTask: {
        dto: IntegrationCreateTaskDto,
        nested: { externalRef: EXTERNAL_REF, assignees: { dto: IntegrationPrincipalRefDto } },
    },
    UpdateTask: { dto: IntegrationUpdateTaskDto },
    TransitionTask: { dto: IntegrationTransitionTaskDto },
    PutTaskAssignees: {
        dto: PutTaskAssigneesDto,
        nested: { assignees: { dto: IntegrationPrincipalRefDto } },
    },
    PutTaskWatchers: { dto: PutTaskWatchersDto },
    PutTaskBlocks: { dto: PutTaskBlocksDto },
    PutTaskRelations: {
        dto: PutTaskRelationsDto,
        nested: { relations: { dto: IntegrationRelationRefDto } },
    },
    CreateComment: {
        dto: IntegrationCreateCommentDto,
        nested: {
            externalAuthor: { dto: IntegrationExternalAuthorDto },
            externalRef: EXTERNAL_REF,
        },
    },
    UpdateComment: { dto: IntegrationUpdateCommentDto },
    InboxReply: { dto: IntegrationInboxReplyDto },
    InboxStateChange: { dto: IntegrationInboxStateDto },
    InboundEmail: {
        dto: IntegrationInboundEmailDto,
        nested: {
            message: {
                dto: IntegrationInboundMessageDto,
                nested: { attachments: { dto: IntegrationInboundAttachmentDto } },
            },
        },
    },
    CreateKbDocument: {
        dto: IntegrationCreateKbDocumentDto,
        nested: { scope: { dto: IntegrationKbScopeDto }, externalRef: EXTERNAL_REF },
    },
    UpdateKbDocument: { dto: IntegrationUpdateKbDocumentDto },
    MoveKbDocument: { dto: IntegrationMoveKbDocumentDto },
    CreateKbFolder: { dto: IntegrationCreateKbFolderDto, nested: { externalRef: EXTERNAL_REF } },
    UpdateKbFolder: { dto: IntegrationUpdateKbFolderDto },
    PutLink: { dto: IntegrationPutLinkDto },
    // EW-P2-1 — Ideas.
    CreateIdea: { dto: IntegrationCreateIdeaDto, nested: { externalRef: EXTERNAL_REF } },
    UpdateIdea: { dto: IntegrationUpdateIdeaDto },
    // EW-P2-2 — Goals.
    CreateGoal: {
        dto: IntegrationCreateGoalDto,
        nested: {
            metricSource: GOAL_METRIC_SOURCE,
            criteria: GOAL_CRITERION,
            dodCriteria: GOAL_DOD_ITEM,
            externalRef: EXTERNAL_REF,
        },
    },
    UpdateGoal: { dto: IntegrationUpdateGoalDto },
    PutGoalCriteria: { dto: IntegrationPutGoalCriteriaDto, nested: { criteria: GOAL_CRITERION } },
    PutGoalDod: { dto: IntegrationPutGoalDodDto, nested: { dodCriteria: GOAL_DOD_ITEM } },
    GoalDoDItem: GOAL_DOD_ITEM,
    GoalSample: { dto: IntegrationGoalSampleDto },
    // EW-P2-5 — Missions.
    CreateMission: { dto: IntegrationCreateMissionDto, nested: { externalRef: EXTERNAL_REF } },
    UpdateMission: { dto: IntegrationUpdateMissionDto },
    PutMissionGoals: {
        dto: IntegrationPutMissionGoalsDto,
        nested: { goals: { dto: IntegrationMissionGoalLinkDto } },
    },
    PutMissionWorks: {
        dto: IntegrationPutMissionWorksDto,
        nested: { works: { dto: IntegrationMissionWorkLinkDto } },
    },
    // EW-P2-6 — organization create.
    CreateOrganization: { dto: IntegrationCreateOrganizationDto },
    // CR-13 — member invitations.
    InviteMember: { dto: IntegrationInviteMemberDto },
    // EW-P2-4 — Project Works (Gauzy CR-6).
    CreateWork: { dto: IntegrationCreateWorkDto, nested: { externalRef: EXTERNAL_REF } },
    CreateWebhook: { dto: IntegrationCreateWebhookDto },
    UpdateWebhook: { dto: IntegrationUpdateWebhookDto },
    Batch: {
        dto: IntegrationBatchDto,
        nested: { operations: { dto: IntegrationBatchOperationDto } },
    },
};

/** `$defs` of `requests.schema.json` that are not a request body. */
const NOT_A_BODY = new Set(['WritableVisibility', 'BatchResult']);

/** Each difference between a body schema and its DTO, as readable lines. */
function bodyDrift(path: string, schema: JsonSchema, file: string, pair: BodyPair): string[] {
    const drift: string[] = [];
    const { properties, optional, allowed } = dtoShape(pair.dto);
    const schemaProperties = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    for (const name of schemaProperties) {
        if (!properties.has(name)) {
            drift.push(`${path}.${name}: in the schema, not in ${pair.dto.name} (answers 400)`);
        } else if (required.has(name) === optional.has(name)) {
            drift.push(
                `${path}.${name}: ${required.has(name) ? 'required' : 'optional'} in the schema, ${
                    optional.has(name) ? 'optional' : 'required'
                } in ${pair.dto.name}`,
            );
        }
        // Enumerated values: what `@IsIn` accepts is what the schema allows
        // (a property the route checks in code instead, e.g. `visibility`,
        // has no `@IsIn` and is not compared).
        const values = schema.properties?.[name]
            ? schemaValues(schema.properties[name], file)
            : null;
        const accepted = allowed.get(name);
        if (values && accepted) {
            const expected = sortedValues(values);
            const actual = sortedValues(accepted);
            if (JSON.stringify(expected) !== JSON.stringify(actual)) {
                drift.push(
                    `${path}.${name}: the schema allows [${expected.join(', ')}], ${
                        pair.dto.name
                    } @IsIn [${actual.join(', ')}]`,
                );
            }
        }
    }
    const documented = documentedProperties(pair.dto);
    for (const name of properties) {
        if (!schemaProperties.includes(name)) {
            drift.push(`${path}.${name}: in ${pair.dto.name}, not in the schema (undocumented)`);
        }
        if (!documented.has(name)) {
            drift.push(
                `${path}.${name}: ${pair.dto.name} has no @ApiProperty (missing from OpenAPI)`,
            );
        }
    }
    if (schema.additionalProperties !== false) {
        drift.push(
            `${path}: the schema must say additionalProperties: false (forbidNonWhitelisted)`,
        );
    }
    for (const [name, nested] of Object.entries(pair.nested ?? {})) {
        const property = schema.properties?.[name];
        const target = property ? objectSchemaOf(property, file) : null;
        if (!target) {
            drift.push(
                `${path}.${name}: ${nested.dto.name} is nested, the schema has no object there`,
            );
            continue;
        }
        drift.push(...bodyDrift(`${path}.${name}`, target.schema, target.file, nested));
    }
    return drift;
}

function contractAjv() {
    // Formats are documentation here; the shapes are what is checked.
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    for (const schema of SCHEMA_FILES.values()) ajv.addSchema(schema);
    return (ref: string, value: unknown): string[] => {
        const validate = ajv.getSchema(BASE + ref);
        if (!validate) throw new Error(`no schema ${ref}`);
        return validate(JSON.parse(JSON.stringify(value)))
            ? []
            : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
    };
}

describe('integration contract v1 — the API side (EW-P1-8, T25)', () => {
    const validate = contractAjv();
    const requests = schemaFile('requests.schema.json');
    const defs = (requests.$defs ?? {}) as Record<string, JsonSchema>;

    describe('request bodies ↔ class-validator DTOs', () => {
        it('maps every request body of requests.schema.json to its DTO', () => {
            const unmapped = Object.keys(defs).filter(
                (name) => !NOT_A_BODY.has(name) && !REQUEST_BODIES[name],
            );
            // A new body: add its DTO to REQUEST_BODIES (or NOT_A_BODY).
            expect(unmapped).toEqual([]);
            expect(Object.keys(REQUEST_BODIES).filter((name) => !defs[name])).toEqual([]);
        });

        it.each(Object.entries(REQUEST_BODIES))(
            '%s has the properties and the required ones of its DTO, all in OpenAPI',
            (name, pair) => {
                expect(bodyDrift(name, defs[name], 'requests.schema.json', pair)).toEqual([]);
            },
        );
    });

    describe('vocabularies', () => {
        it('scopes are INTEGRATION_SCOPES', () => {
            const whoami = schemaFile('resources/whoami.schema.json');
            const scope = (whoami.$defs as Record<string, { enum: string[] }>).Scope;
            expect([...scope.enum].sort()).toEqual([...INTEGRATION_SCOPES].sort());
        });

        it('error codes are INTEGRATION_ERROR_CODES', () => {
            const error = schemaFile('error.schema.json');
            const codes = (error.$defs as Record<string, { enum: string[] }>).ErrorCode;
            expect([...codes.enum].sort()).toEqual([...INTEGRATION_ERROR_CODES].sort());
        });

        it('integration kinds are the documented ones', () => {
            const whoami = schemaFile('resources/whoami.schema.json');
            const kind = whoami.properties?.integrationKind as { examples: string[] };
            expect([...kind.examples].sort()).toEqual([...INTEGRATION_KINDS].sort());
        });
    });

    describe('error envelope', () => {
        const filter = new IntegrationExceptionFilter();
        const statusCodes = (schemaFile('error.schema.json')['x-status-codes'] ?? {}) as Record<
            string,
            string[]
        >;
        const answer = (exception: unknown) => {
            let status = 0;
            let body: unknown;
            const response = {
                status(code: number) {
                    status = code;
                    return {
                        json(value: unknown) {
                            body = value;
                        },
                    };
                },
            };
            filter.catch(exception, {
                switchToHttp: () => ({ getResponse: () => response }),
            } as never);
            return { status, body: body as { error: { code: string } } };
        };

        const cases: ReadonlyArray<readonly [string, unknown]> = [
            ['validation (ValidationPipe)', new BadRequestException(['title must be a string'])],
            [
                'validation (route)',
                new IntegrationHttpException(400, 'validation_failed', 'Bad field.', {
                    fields: [{ path: 'title', message: 'must be a string' }],
                }),
            ],
            ['invalid key', new IntegrationHttpException(401, 'invalid_key', 'Invalid key.')],
            [
                'scope missing',
                new IntegrationHttpException(403, 'scope_missing', 'Needs tasks:write.'),
            ],
            ['org not pinned', new IntegrationHttpException(403, 'org_not_pinned', 'Not pinned.')],
            [
                'act-as forbidden',
                new IntegrationHttpException(403, 'act_as_forbidden', 'Not a member.', {
                    reason: 'not_the_recipient',
                }),
            ],
            ['domain 403', new ForbiddenException('not yours')],
            ['not found (domain)', new ResourceNotFoundError('task', 'task-1')],
            ['not found (Nest)', new NotFoundException('gone')],
            [
                'transition blocked',
                new ConflictException({
                    error: {
                        code: 'transition_blocked',
                        message: 'Blocked.',
                        details: {
                            from: 'todo',
                            to: 'done',
                            blockers: [],
                            pendingApprovers: [],
                            path: ['in_progress'],
                        },
                    },
                }),
            ],
            ['duplicate externalRef', new DuplicateExternalRefError('external', 'task-1', 'g-1')],
            ['idempotency conflict', new IdempotencyConflictError('request_mismatch')],
            ['conflict (Nest)', new ConflictException('slug taken')],
            ['cursor expired', new DomainEventCursorExpiredError('10', '200')],
            ['foreign cursor', new InvalidCursorError()],
            ['If-Match pre-check', new VersionMismatchError(3, 4)],
            ['If-Match re-check', new AggregateVersionConflictError('task', 'task-1', 3, 4)],
            ['domain rule', new IntegrationHttpException(422, 'domain_rule', 'Archived.')],
            ['rate limited', new IntegrationHttpException(429, 'rate_limited', 'Slow down.')],
            ['server error', new InternalServerErrorException('boom')],
            ['unknown throw', new Error('boom')],
        ];

        it.each(cases)(
            '%s answers a valid envelope with a listed status ↔ code pair',
            (_label, exception) => {
                const { status, body } = answer(exception);
                expect(validate('error.schema.json', body)).toEqual([]);
                const code = body.error.code;
                if (status >= 500) {
                    expect(code).toBe('internal_error');
                } else {
                    expect(statusCodes[String(status)] ?? []).toContain(code);
                }
            },
        );
    });

    describe('GET /whoami', () => {
        it('answers its schema', async () => {
            const tenantId = '7c1e9a52-3b0d-4c8e-9f21-5d6a7b8c9d01';
            const organizationId = '0f4b2c6d-8e1a-4b3c-9d5e-6f7a8b9c0d12';
            const controller = new IntegrationWhoamiController(
                { findById: async () => ({ id: tenantId, slug: 'acme' }) } as never,
                {
                    findByTenantId: async () => [
                        { id: organizationId, slug: 'acme', displayName: 'Acme' },
                    ],
                } as never,
                { head: async () => '42' } as never,
            );
            const body = await controller.whoami({
                userId: 'owner-1',
                integration: {
                    keyId: '5d6a7b8c-9d01-4c8e-9f21-7c1e9a523b0d',
                    keyName: 'Gauzy',
                    integrationKind: 'ever-gauzy',
                    tenantId,
                    allowedOrganizationIds: [organizationId],
                    scopes: ['tasks:read', 'events:read'],
                    ownerUserId: 'owner-1',
                    actAsUserId: null,
                },
            } as never);
            expect(validate('resources/whoami.schema.json', body)).toEqual([]);
        });
    });
});
