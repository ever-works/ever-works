import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WHITELIST, type WhitelistEntry } from '../../../../mcp/src/openapi-tools/whitelist';

/**
 * # The App Works OpenAPI fragments are a subset of the document the API generates
 *
 * `docs/specs/features/app-works/contracts/openapi/apw-*.openapi.yaml` are the published,
 * reviewable contracts of the App Works routes (one per epic that owns routes; see that
 * folder's README). The document `@nestjs/swagger` generates from the controllers is the
 * source of truth. This spec holds the two together: every fragment must be a SUBSET of the
 * generated document, operation by operation.
 *
 * ## Where the generated document comes from
 *
 * The real one: `node apps/api/dist/openapi/generate-openapi.js`, the script that produces the
 * document the MCP image bundles, run in a child process exactly as
 * `.deploy/docker/mcp/Dockerfile` runs it. It needs the API's build output, which CI builds
 * before it runs the tests; locally, run `pnpm --filter ever-works-api build` first (a stale
 * build checks stale controllers). The child process is not a convenience: importing
 * `ApiModule` into this jest process type-checks the whole API program (see
 * `app-works-di-reachability.spec.ts` for the same reasoning).
 *
 * ## What is compared, per fragment operation
 *
 *   1. the path and method exist;
 *   2. every status code the fragment lists is declared;
 *   3. every parameter the fragment lists exists (same `in` and name), and is required when the
 *      fragment requires it;
 *   4. every property the fragment requires in a request body, or in a response body of a listed
 *      status, is required in the generated schema at the same place (nested objects and array
 *      items included);
 *   5. every response header the fragment lists is declared;
 *   6. `x-mcp` agrees with the MCP whitelist (`apps/mcp/src/openapi-tools/whitelist.ts`):
 *      `not-exposed …` means no entry for the route, `{ tool: name }` means exactly that entry,
 *      with the same read-only / destructive hints when the fragment states them.
 *
 * Each fragment is also linted: OpenAPI 3.0.3, `version: fragment`, no `servers`, no 3.1
 * `type: [x, 'null']` spelling, every operation carries `x-source` and `x-mcp`, every `$ref`
 * resolves.
 *
 * ## Known drift is a register, exact both ways
 *
 * The generated document does not describe every App Works route as fully as its fragment yet.
 * Those gaps are listed in {@link KNOWN_DRIFT}, one line per operation and aspect, each with
 * the reason it is open. A finding not in the register fails (new drift); a register entry that
 * no longer fails also fails (the drift was fixed — delete its line). `apw-11.openapi.yaml`, the
 * App Launcher contract another Ever app generates its client from, may have no entry at all.
 */

const FRAGMENT_DIR = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'specs',
    'features',
    'app-works',
    'contracts',
    'openapi',
);
const API_ROOT = join(__dirname, '..', '..', '..');
const GENERATOR = join(API_ROOT, 'dist', 'openapi', 'generate-openapi.js');

/** The fragment that must hold zero findings: the App Launcher contract. */
const STRICT_FRAGMENTS = ['apw-11.openapi.yaml'];

const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'] as const;

type Json = Record<string, any>;

interface Finding {
    /** `<fragment> <METHOD> <path> :: <aspect>` — the register key. */
    key: string;
    detail: string;
}

/**
 * Open drift between a fragment and the generated document, keyed exactly as findings are.
 * Every entry says why it is open; delete the line when the finding disappears.
 */
const KNOWN_DRIFT: Readonly<Record<string, string>> = {
    // APW-01 — the App Works create surface. Its error bodies are not described to the
    // generated document (the controllers declare only the status codes), the create body's
    // `repositoryUrl` is optional in the shared DTO because a website Work has none, the two
    // deletion refusals are not declared, and the `inspect_app_source` tool is not whitelisted
    // yet (APW-01 T19).
    'apw-01.openapi.yaml POST /api/works/app-source/inspect :: response 400':
        'error body not described by the controller',
    'apw-01.openapi.yaml POST /api/works/app-source/inspect :: x-mcp':
        'inspect_app_source is not in the MCP whitelist yet (APW-01 T19)',
    'apw-01.openapi.yaml POST /api/works :: request body':
        '`repositoryUrl` is required for an App Work only, so the shared DTO marks it optional',
    'apw-01.openapi.yaml POST /api/works :: response 400':
        'error body not described by the controller',
    'apw-01.openapi.yaml POST /api/works :: response 409':
        'error body not described by the controller',
    'apw-01.openapi.yaml POST /api/works/{id}/delete :: status 400':
        'the refusal is returned but not declared on the route',
    'apw-01.openapi.yaml POST /api/works/{id}/delete :: status 422':
        'the refusal is returned but not declared on the route',

    // APW-12 — Ever ID. Every refusal answers `{ status, code, message }`, but the controller
    // declares the statuses without a body schema, and the administration status is returned
    // without a described schema.
    'apw-12.openapi.yaml POST /api/auth/ever-id/authorize :: response 400':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/authorize :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/callback :: response 400':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/callback :: response 401':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/callback :: response 403':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/callback :: response 422':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/sign-up/confirm :: response 400':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/sign-up/confirm :: response 403':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/sign-up/confirm :: response 409':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/sign-up/confirm :: response 422':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/connect/authorize :: response 403':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/connect/confirm :: response 409':
        'Ever ID error body not described',
    'apw-12.openapi.yaml GET /api/auth/ever-id/identities :: response 403':
        'Ever ID error body not described',
    'apw-12.openapi.yaml DELETE /api/auth/ever-id/identities/{id} :: response 403':
        'Ever ID error body not described',
    'apw-12.openapi.yaml DELETE /api/auth/ever-id/identities/{id} :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml DELETE /api/auth/ever-id/identities/{id} :: response 409':
        'Ever ID error body not described',
    'apw-12.openapi.yaml GET /api/auth/ever-id/logout-url :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/backchannel-logout :: response 400':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/session :: response 401':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/session :: response 403':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/admin/test :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml GET /api/auth/ever-id/admin/health :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml GET /api/auth/ever-id/admin/status :: response 200':
        'the administration status is returned without a described schema',
    'apw-12.openapi.yaml GET /api/auth/ever-id/admin/status :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/admin/enable :: response 200':
        'the administration status is returned without a described schema',
    'apw-12.openapi.yaml POST /api/auth/ever-id/admin/enable :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/admin/enable :: response 409':
        'Ever ID error body not described',
    'apw-12.openapi.yaml POST /api/auth/ever-id/admin/disable :: response 200':
        'the administration status is returned without a described schema',
    'apw-12.openapi.yaml POST /api/auth/ever-id/admin/disable :: response 404':
        'Ever ID error body not described',
    'apw-12.openapi.yaml PATCH /api/auth/ever-id/admin/settings :: response 200':
        'the administration status is returned without a described schema',
    'apw-12.openapi.yaml PATCH /api/auth/ever-id/admin/settings :: response 400':
        'Ever ID error body not described',
    'apw-12.openapi.yaml PATCH /api/auth/ever-id/admin/settings :: response 404':
        'Ever ID error body not described',
};

// ---------------------------------------------------------------------------
// The comparison: pure functions over two parsed documents
// ---------------------------------------------------------------------------

/** Follows local `$ref`s (`#/a/b`), stopping on a cycle or a dangling reference. */
function deref(doc: Json, schema: any, seen = new Set<string>()): any {
    let current = schema;
    while (current && typeof current === 'object' && typeof current.$ref === 'string') {
        if (seen.has(current.$ref)) return undefined;
        seen.add(current.$ref);
        current = resolvePointer(doc, current.$ref);
    }
    return current;
}

function resolvePointer(doc: Json, ref: string): any {
    if (!ref.startsWith('#/')) return undefined;
    return ref
        .slice(2)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<any>((node, part) => (node == null ? undefined : node[part]), doc);
}

/** The `application/json` schema of a request body or a response, dereferenced. */
function jsonSchemaOf(doc: Json, holder: any): any {
    const target = deref(doc, holder);
    const media = target?.content?.['application/json'];
    return media ? deref(doc, media.schema) : undefined;
}

/**
 * Every required property path in `schema`: `a`, `a.b`, `items[].key` — through nested
 * objects and array items, to a bounded depth (fragments are shallow; the bound only stops a
 * self-referencing schema).
 */
function requiredPaths(doc: Json, schema: any, prefix = '', depth = 0): string[] {
    const node = deref(doc, schema);
    if (!node || typeof node !== 'object' || depth > 8) return [];
    if (node.type === 'array' || node.items) {
        return requiredPaths(doc, node.items, `${prefix}[]`, depth + 1);
    }
    const out: string[] = [];
    for (const name of Array.isArray(node.required) ? node.required : []) {
        out.push(prefix ? `${prefix}.${name}` : name);
    }
    for (const [name, child] of Object.entries<any>(node.properties ?? {})) {
        out.push(...requiredPaths(doc, child, prefix ? `${prefix}.${name}` : name, depth + 1));
    }
    return out;
}

/**
 * Whether the property at the dotted path (`items[].key`) exists along the way and its LAST
 * link is required in `schema`. Intermediate links only have to exist: the fragment may mark an
 * object optional and still require a property inside it when it is present, and its own
 * `required` list for that object is checked as a path of its own.
 */
function isRequiredAt(doc: Json, schema: any, path: string): boolean {
    let node = deref(doc, schema);
    const steps = path.split('.');
    for (let index = 0; index < steps.length; index += 1) {
        let step = steps[index];
        // A leading `[]` (the body itself is an array) descends into the items first.
        while (step.startsWith('[]')) {
            node = deref(doc, node?.items);
            step = step.slice(2);
        }
        if (step === '') continue; // the link was only the hop into an array body's items
        let arrayDepth = 0;
        while (step.endsWith('[]')) {
            arrayDepth += 1;
            step = step.slice(0, -2);
        }
        if (!node || typeof node !== 'object') return false;
        const last = index === steps.length - 1;
        if (last) return Array.isArray(node.required) && node.required.includes(step);
        node = deref(doc, node.properties?.[step]);
        for (let level = 0; level < arrayDepth; level += 1) {
            node = deref(doc, node?.items);
        }
    }
    return false;
}

function operationsOf(doc: Json): Array<{ path: string; method: string; op: Json }> {
    const out: Array<{ path: string; method: string; op: Json }> = [];
    for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
        for (const method of METHODS) {
            if (item?.[method]) out.push({ path, method, op: item[method] });
        }
    }
    return out;
}

/** `:id` → `{id}`; the generated document always uses braces. */
function normalisePath(path: string): string {
    return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Lints one fragment. These findings are never allowed into the register. */
export function lintFragment(name: string, fragment: Json): string[] {
    const problems: string[] = [];
    if (fragment.openapi !== '3.0.3') problems.push(`${name}: openapi must be 3.0.3`);
    if (fragment.info?.version !== 'fragment')
        problems.push(`${name}: info.version must be "fragment"`);
    if ('servers' in fragment) problems.push(`${name}: a fragment carries no servers`);

    const operations = operationsOf(fragment);
    if (operations.length === 0) problems.push(`${name}: no operation`);
    for (const { path, method, op } of operations) {
        const where = `${name} ${method.toUpperCase()} ${path}`;
        if (typeof op['x-source'] !== 'string' || op['x-source'].trim() === '') {
            problems.push(`${where}: missing x-source`);
        }
        if (op['x-mcp'] === undefined) problems.push(`${where}: missing x-mcp`);
    }

    const walk = (node: any, trail: string): void => {
        if (Array.isArray(node)) {
            node.forEach((child, index) => walk(child, `${trail}[${index}]`));
            return;
        }
        if (!node || typeof node !== 'object') return;
        if (typeof node.$ref === 'string' && resolvePointer(fragment, node.$ref) === undefined) {
            problems.push(`${name}: dangling $ref ${node.$ref} at ${trail}`);
        }
        if (Array.isArray(node.type)) {
            problems.push(`${name}: OpenAPI 3.1 type array at ${trail} (use nullable: true)`);
        }
        for (const [key, child] of Object.entries(node)) walk(child, `${trail}.${key}`);
    };
    walk(fragment, '$');
    return problems;
}

/** Compares one fragment with the generated document and the MCP whitelist. */
export function compareFragment(
    name: string,
    fragment: Json,
    generated: Json,
    whitelist: readonly WhitelistEntry[],
): Finding[] {
    const findings: Finding[] = [];
    for (const { path, method, op } of operationsOf(fragment)) {
        const generatedPath = normalisePath(path);
        const target = generated.paths?.[generatedPath]?.[method];
        const base = `${name} ${method.toUpperCase()} ${generatedPath}`;
        const add = (aspect: string, detail: string) =>
            findings.push({ key: `${base} :: ${aspect}`, detail });

        // 6. x-mcp against the whitelist — independent of the generated document.
        const entry = whitelist.find(
            (candidate) =>
                candidate.method.toUpperCase() === method.toUpperCase() &&
                normalisePath(candidate.path) === generatedPath,
        );
        const mcp = op['x-mcp'];
        if (typeof mcp === 'string' && mcp.trim().startsWith('not-exposed')) {
            if (entry)
                add('x-mcp', `not-exposed, but the whitelist has ${entry.toolName ?? 'an entry'}`);
        } else if (mcp && typeof mcp === 'object' && typeof mcp.tool === 'string') {
            if (!entry) {
                add('x-mcp', `tool ${mcp.tool} has no whitelist entry`);
            } else if (entry.toolName !== mcp.tool) {
                add('x-mcp', `tool ${mcp.tool}, whitelist names ${entry.toolName}`);
            } else {
                for (const hint of ['readOnlyHint', 'destructiveHint'] as const) {
                    if (
                        typeof mcp[hint] === 'boolean' &&
                        Boolean(entry.annotations?.[hint]) !== mcp[hint]
                    ) {
                        add(
                            'x-mcp',
                            `${hint} ${mcp[hint]}, whitelist says ${Boolean(entry.annotations?.[hint])}`,
                        );
                    }
                }
            }
        } else {
            add('x-mcp', 'x-mcp is neither "not-exposed …" nor { tool }');
        }

        // 1. the operation itself.
        if (!target) {
            add('operation', 'absent from the generated document');
            continue;
        }

        // 2. status codes.
        const declared = Object.keys(target.responses ?? {});
        for (const status of Object.keys(op.responses ?? {})) {
            if (!declared.includes(status))
                add(`status ${status}`, `declared: ${declared.join(', ')}`);
        }

        // 3. parameters.
        for (const raw of op.parameters ?? []) {
            const parameter = deref(fragment, raw);
            const match = (target.parameters ?? [])
                .map((candidate: any) => deref(generated, candidate))
                .find(
                    (candidate: any) =>
                        candidate?.name === parameter?.name && candidate?.in === parameter?.in,
                );
            if (!match) {
                add(`parameter ${parameter?.in} ${parameter?.name}`, 'absent');
            } else if (parameter.required === true && match.required !== true) {
                add(`parameter ${parameter.in} ${parameter.name}`, 'required in the fragment only');
            }
        }

        // 4. required properties — request body.
        const fragmentBody = jsonSchemaOf(fragment, op.requestBody);
        if (fragmentBody) {
            const generatedBody = jsonSchemaOf(generated, target.requestBody);
            const missing = requiredPaths(fragment, fragmentBody).filter(
                (property) => !isRequiredAt(generated, generatedBody, property),
            );
            if (missing.length > 0) add('request body', `not required: ${missing.join(', ')}`);
        }

        // 4 and 5. required properties and headers — every listed response.
        for (const [status, rawResponse] of Object.entries<any>(op.responses ?? {})) {
            if (!declared.includes(status)) continue; // already reported as a missing status
            const fragmentSchema = jsonSchemaOf(fragment, rawResponse);
            if (fragmentSchema) {
                const generatedSchema = jsonSchemaOf(generated, target.responses[status]);
                const missing = requiredPaths(fragment, fragmentSchema).filter(
                    (property) => !isRequiredAt(generated, generatedSchema, property),
                );
                if (missing.length > 0)
                    add(`response ${status}`, `not required: ${missing.join(', ')}`);
            }
            const fragmentHeaders = Object.keys(deref(fragment, rawResponse)?.headers ?? {});
            const generatedHeaders = Object.keys(target.responses[status]?.headers ?? {}).map(
                (header) => header.toLowerCase(),
            );
            for (const header of fragmentHeaders) {
                if (!generatedHeaders.includes(header.toLowerCase())) {
                    add(`header ${status} ${header}`, 'not declared');
                }
            }
        }
    }
    return findings;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function loadFragments(): Array<{ name: string; fragment: Json }> {
    return readdirSync(FRAGMENT_DIR)
        .filter((file) => /^apw-\d{2}\.openapi\.yaml$/.test(file))
        .sort()
        .map((name) => ({
            name,
            fragment: parseYaml(readFileSync(join(FRAGMENT_DIR, name), 'utf8')) as Json,
        }));
}

/** Runs the API's own generator in a child process and returns the document it writes. */
function generateDocument(): Json {
    if (!existsSync(GENERATOR)) {
        throw new Error(
            `The API build output is missing (${GENERATOR}). Run \`pnpm --filter ever-works-api build\` ` +
                'first; CI builds before it tests.',
        );
    }
    const dir = mkdtempSync(join(tmpdir(), 'ever-works-openapi-'));
    const output = join(dir, 'openapi.json');
    try {
        const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
        // The same placeholders the MCP image's build passes: they satisfy module configuration
        // checks only; preview mode instantiates nothing and connects to nothing.
        env.DATABASE_URL ||= 'postgres://user:pass@localhost:5432/everworks';
        env.AUTH_SECRET ||= '00000000000000000000000000000000';
        env.JWT_SECRET ||= '00000000000000000000000000000000';
        const run = spawnSync(process.execPath, [GENERATOR, output], {
            cwd: API_ROOT,
            env,
            encoding: 'utf8',
            timeout: 240_000,
            maxBuffer: 64 * 1024 * 1024,
        });
        if (run.status !== 0 || !existsSync(output)) {
            throw new Error(
                `generate-openapi exited with ${run.status ?? run.signal}:\n${run.stderr || run.stdout}`,
            );
        }
        return JSON.parse(readFileSync(output, 'utf8')) as Json;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe('the comparison itself (controls — a checker that finds nothing proves nothing)', () => {
    const generated: Json = {
        paths: {
            '/api/things/{id}': {
                get: {
                    parameters: [{ name: 'id', in: 'path', required: true }],
                    responses: {
                        '200': {
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/Thing' },
                                },
                            },
                        },
                    },
                },
            },
        },
        components: {
            schemas: {
                Thing: {
                    type: 'object',
                    required: ['id', 'parts'],
                    properties: {
                        id: { type: 'string' },
                        parts: {
                            type: 'array',
                            items: { type: 'object', required: ['a'], properties: {} },
                        },
                        meta: { type: 'object', properties: {} },
                    },
                },
            },
        },
    };

    function fragmentWith(op: Json): Json {
        return { paths: { '/api/things/:id': { get: { 'x-mcp': 'not-exposed (test)', ...op } } } };
    }

    it('passes an exact subset, through $refs, arrays and the :id spelling', () => {
        const fragment = fragmentWith({
            parameters: [{ name: 'id', in: 'path', required: true }],
            responses: {
                '200': {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['id', 'parts'],
                                properties: {
                                    parts: {
                                        type: 'array',
                                        items: { type: 'object', required: ['a'] },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        expect(compareFragment('t.yaml', fragment, generated, [])).toEqual([]);
    });

    it('reports a missing operation, status, parameter, required property and header', () => {
        const missingOperation = {
            paths: { '/api/other': { get: { 'x-mcp': 'not-exposed', responses: {} } } },
        };
        expect(
            compareFragment('t.yaml', missingOperation, generated, []).map((f) => f.key),
        ).toEqual(['t.yaml GET /api/other :: operation']);

        const keys = compareFragment(
            't.yaml',
            fragmentWith({
                parameters: [{ name: 'q', in: 'query' }],
                responses: {
                    '200': {
                        headers: { 'Cache-Control': { schema: { type: 'string' } } },
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['id', 'meta'],
                                    properties: { meta: { type: 'object', required: ['total'] } },
                                },
                            },
                        },
                    },
                    '404': { description: 'off' },
                },
            }),
            generated,
            [],
        ).map((f) => f.key);

        expect(keys).toEqual([
            't.yaml GET /api/things/{id} :: status 404',
            't.yaml GET /api/things/{id} :: parameter query q',
            't.yaml GET /api/things/{id} :: response 200',
            't.yaml GET /api/things/{id} :: header 200 Cache-Control',
        ]);
    });

    it('reports a property required in a nested array item only in the fragment', () => {
        const keys = compareFragment(
            't.yaml',
            fragmentWith({
                responses: {
                    '200': {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        parts: {
                                            type: 'array',
                                            items: { type: 'object', required: ['a', 'b'] },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            generated,
            [],
        );
        expect(keys).toEqual([
            {
                key: 't.yaml GET /api/things/{id} :: response 200',
                detail: 'not required: parts[].b',
            },
        ]);
    });

    it('holds x-mcp to the whitelist in both directions', () => {
        const entry: WhitelistEntry = {
            method: 'GET',
            path: '/api/things/{id}',
            toolName: 'get_thing',
            annotations: { readOnlyHint: true },
        };
        const notExposed = fragmentWith({ responses: {} });
        expect(compareFragment('t.yaml', notExposed, generated, [entry]).map((f) => f.key)).toEqual(
            ['t.yaml GET /api/things/{id} :: x-mcp'],
        );

        const tool = fragmentWith({
            responses: {},
            'x-mcp': { tool: 'get_thing', readOnlyHint: true },
        });
        expect(compareFragment('t.yaml', tool, generated, [entry])).toEqual([]);
        expect(compareFragment('t.yaml', tool, generated, []).map((f) => f.key)).toEqual([
            't.yaml GET /api/things/{id} :: x-mcp',
        ]);

        const wrongHint = fragmentWith({
            responses: {},
            'x-mcp': { tool: 'get_thing', readOnlyHint: false },
        });
        expect(compareFragment('t.yaml', wrongHint, generated, [entry])).toHaveLength(1);
    });

    it('lints the fragment conventions', () => {
        const problems = lintFragment('t.yaml', {
            openapi: '3.1.0',
            info: { version: '1.0' },
            servers: [{ url: 'https://api.example.com' }],
            paths: {
                '/api/x': {
                    get: {
                        responses: {
                            '200': {
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: '#/components/schemas/Gone',
                                            type: ['string', 'null'],
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        expect(problems).toEqual(
            expect.arrayContaining([
                't.yaml: openapi must be 3.0.3',
                't.yaml: info.version must be "fragment"',
                't.yaml: a fragment carries no servers',
                't.yaml GET /api/x: missing x-source',
                't.yaml GET /api/x: missing x-mcp',
                expect.stringContaining('dangling $ref #/components/schemas/Gone'),
                expect.stringContaining('OpenAPI 3.1 type array'),
            ]),
        );
    });
});

describe('App Works OpenAPI fragments ⊆ the generated API document', () => {
    const fragments = loadFragments();
    let generated: Json;

    beforeAll(() => {
        generated = generateDocument();
    }, 300_000);

    it('reads every fragment, the launcher contract included', () => {
        expect(fragments.map((entry) => entry.name)).toEqual(
            expect.arrayContaining([
                'apw-01.openapi.yaml',
                'apw-11.openapi.yaml',
                'apw-12.openapi.yaml',
            ]),
        );
    });

    it('generates the real document (not an empty one)', () => {
        expect(Object.keys(generated.paths ?? {}).length).toBeGreaterThan(100);
        expect(generated.openapi).toMatch(/^3\.0\./);
    });

    it.each(fragments.map((entry) => [entry.name, entry.fragment] as const))(
        'lints %s',
        (name, fragment) => {
            expect(lintFragment(name, fragment)).toEqual([]);
        },
    );

    it('finds exactly the drift the register lists — nothing new, nothing already fixed', () => {
        const findings = fragments.flatMap(({ name, fragment }) =>
            compareFragment(name, fragment, generated, WHITELIST),
        );
        const found = new Map(findings.map((finding) => [finding.key, finding.detail]));

        const unexpected = [...found.entries()]
            .filter(([key]) => !(key in KNOWN_DRIFT))
            .map(([key, detail]) => `${key} — ${detail}`);
        const fixed = Object.keys(KNOWN_DRIFT).filter((key) => !found.has(key));

        expect({ unexpected, fixed }).toEqual({ unexpected: [], fixed: [] });
    });

    it.each(STRICT_FRAGMENTS)('holds %s to zero findings, with no register entry', (name) => {
        const entry = fragments.find((candidate) => candidate.name === name);
        expect(entry).toBeDefined();
        expect(compareFragment(name, entry!.fragment, generated, WHITELIST)).toEqual([]);
        expect(Object.keys(KNOWN_DRIFT).filter((key) => key.startsWith(`${name} `))).toEqual([]);
    });
});
