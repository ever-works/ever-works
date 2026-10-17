import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * APW-04 — repository detection for the App Provisioner (Ruling A's "AI half").
 *
 * The repository has no usable App spec and no Blueprint matched, so something has to work
 * out how to build and run it. This file is the deterministic part of that: it reads a
 * handful of well-known files (Dockerfile, compose, Helm, manifests, lockfiles, env
 * examples) and answers
 *
 *   - **what the repository is** — language, package manager, framework, the Dockerfile /
 *     compose file / chart it ships, the ports it exposes, the commands it declares, the
 *     managed services its client libraries imply, the env names its example file lists;
 *   - **a first App spec** — a `.works/works.yml` document built from that detection, which
 *     the provisioning agent starts from and the platform validates with the SAME validator
 *     every other spec goes through (`validateAppSpecDocument`).
 *
 * The order of precedence follows the `provision-app` Skill's playbook
 * (`docs/specs/features/app-works/APW-04-app-provisioner/skill-draft/SKILL.md` §1): an
 * existing spec, then compose, then a Dockerfile, then Helm, then descriptor hints, then
 * language detection (`build.strategy: auto`).
 *
 * Pure: no I/O. The service hands it a root listing and the text of the files it read.
 * Repository text is untrusted — nothing here executes or interprets it beyond parsing.
 */

/** Files the provisioner reads, in addition to the root listing, when they exist. */
export const APP_DETECTOR_PROBE_FILES: readonly string[] = [
    '.works/works.yml',
    'Dockerfile',
    'Containerfile',
    'docker/Dockerfile',
    'deploy/Dockerfile',
    'compose.yaml',
    'compose.yml',
    'docker-compose.yml',
    'docker-compose.yaml',
    'docker-compose.prod.yml',
    'Chart.yaml',
    'Procfile',
    'package.json',
    'pyproject.toml',
    'requirements.txt',
    'Pipfile',
    'go.mod',
    'Gemfile',
    'composer.json',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'Cargo.toml',
    '.env.example',
    '.env.sample',
    'example.env',
    'prisma/schema.prisma',
];

export type DetectedLanguage =
    | 'node'
    | 'python'
    | 'go'
    | 'ruby'
    | 'php'
    | 'java'
    | 'rust'
    | 'static';

export type DetectedDependency = 'postgres' | 'redis' | 'objectStorage' | 'smtp';

/** What the detector found. Every field is evidence-backed; `evidence` says by what. */
export interface AppRepositoryDetection {
    readonly existingSpec: boolean;
    readonly dockerfile: string | null;
    readonly dockerTarget: string | null;
    readonly composeFile: string | null;
    readonly helmChart: string | null;
    readonly procfile: boolean;
    readonly language: DetectedLanguage | null;
    readonly packageManager: string | null;
    readonly framework: string | null;
    readonly port: number | null;
    readonly startCommand: readonly string[] | null;
    readonly healthPath: string | null;
    readonly dependencies: readonly DetectedDependency[];
    readonly envExampleFile: string | null;
    readonly envNames: readonly string[];
    /** `dockerfile` | `auto` | `none` — what the draft spec will use. */
    readonly buildStrategy: 'dockerfile' | 'auto' | 'none';
    /** False when nothing in the repository serves HTTP that we could tell. */
    readonly runnable: boolean;
    readonly evidence: readonly string[];
}

/** The detector's input: the root entry names and the text of each probe file found. */
export interface AppRepositorySnapshot {
    readonly rootEntries: readonly string[];
    readonly files: Readonly<Record<string, string>>;
}

const MAX_ENV_ENTRIES = 60;

/** Detect what a repository is from a snapshot. */
export function detectAppRepository(snapshot: AppRepositorySnapshot): AppRepositoryDetection {
    const root = new Set(snapshot.rootEntries.map((name) => name.toLowerCase()));
    const files = snapshot.files;
    const has = (path: string) => typeof files[path] === 'string';
    const evidence: string[] = [];

    const existingSpec =
        has('.works/works.yml') && /\bkind:\s*app\b/.test(files['.works/works.yml']);
    if (existingSpec) evidence.push('.works/works.yml declares kind: app');

    // ── container definitions ────────────────────────────────────────────
    const dockerfile =
        ['Dockerfile', 'Containerfile', 'docker/Dockerfile', 'deploy/Dockerfile'].find(has) ?? null;
    let dockerTarget: string | null = null;
    let dockerPort: number | null = null;
    let dockerHealth: string | null = null;
    if (dockerfile) {
        const parsed = parseDockerfile(files[dockerfile]);
        dockerTarget = parsed.target;
        dockerPort = parsed.ports[0] ?? null;
        dockerHealth = parsed.healthPath;
        evidence.push(
            `${dockerfile} found${parsed.ports.length ? ` (EXPOSE ${parsed.ports.join(', ')})` : ''}${dockerTarget ? `, production stage "${dockerTarget}"` : ''}`,
        );
    }
    const composeFile =
        [
            'docker-compose.prod.yml',
            'compose.yaml',
            'compose.yml',
            'docker-compose.yml',
            'docker-compose.yaml',
        ].find(has) ?? null;
    let composePort: number | null = null;
    const composeDeps = new Set<DetectedDependency>();
    if (composeFile) {
        const parsed = parseCompose(files[composeFile]);
        composePort = parsed.port;
        parsed.dependencies.forEach((dep) => composeDeps.add(dep));
        evidence.push(
            `${composeFile} found${parsed.dependencies.length ? ` (services imply ${parsed.dependencies.join(', ')})` : ''}`,
        );
    }
    const helmChart = has('Chart.yaml') ? 'Chart.yaml' : root.has('charts') ? 'charts/' : null;
    if (helmChart) evidence.push(`Helm chart at ${helmChart}`);
    const procfile = has('Procfile');
    let procfileWeb: string | null = null;
    if (procfile) {
        // Line-wise, never a backtracking regex over repository text (CodeQL js/polynomial-redos).
        const web = files['Procfile'].split(/\r?\n/).find((line) => line.startsWith('web:'));
        procfileWeb = web ? web.slice('web:'.length).trim() || null : null;
        evidence.push(`Procfile${procfileWeb ? ` (web: ${procfileWeb})` : ''}`);
    }

    // ── language, package manager, framework ─────────────────────────────
    let language: DetectedLanguage | null = null;
    let packageManager: string | null = null;
    let framework: string | null = null;
    let defaultPort: number | null = null;
    let startCommand: string[] | null = null;
    const deps = new Set<DetectedDependency>(composeDeps);

    if (has('package.json')) {
        language = 'node';
        const pkg = safeJson(files['package.json']);
        const all = {
            ...(record(pkg?.dependencies) ?? {}),
            ...(record(pkg?.devDependencies) ?? {}),
        };
        const names = new Set(Object.keys(all));
        packageManager =
            (typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null) ??
            (root.has('pnpm-lock.yaml')
                ? 'pnpm'
                : root.has('yarn.lock')
                  ? 'yarn'
                  : root.has('bun.lockb') || root.has('bun.lock')
                    ? 'bun'
                    : 'npm');
        const fw = nodeFramework(names);
        framework = fw?.name ?? null;
        defaultPort = fw?.port ?? 3000;
        const scripts = record(pkg?.scripts) ?? {};
        if (typeof scripts['start'] === 'string') {
            startCommand =
                packageManager === 'npm' ? ['npm', 'run', 'start'] : [packageManager, 'start'];
        }
        nodeDependencies(names, files['prisma/schema.prisma']).forEach((dep) => deps.add(dep));
        evidence.push(
            `package.json (${packageManager}${framework ? `, ${framework}` : ''}${typeof scripts['start'] === 'string' ? ', has a start script' : ''})`,
        );
    } else if (has('pyproject.toml') || has('requirements.txt') || has('Pipfile')) {
        language = 'python';
        const text = [files['pyproject.toml'], files['requirements.txt'], files['Pipfile']]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();
        packageManager = has('Pipfile')
            ? 'pipenv'
            : root.has('uv.lock')
              ? 'uv'
              : root.has('poetry.lock') || /\[tool\.poetry\]/.test(text)
                ? 'poetry'
                : 'pip';
        framework =
            /\bdjango\b/.test(text) || root.has('manage.py')
                ? 'django'
                : /\bfastapi\b/.test(text)
                  ? 'fastapi'
                  : /\bflask\b/.test(text)
                    ? 'flask'
                    : null;
        defaultPort = 8000;
        if (/psycopg|asyncpg|pg8000/.test(text)) deps.add('postgres');
        if (/\bredis\b|celery/.test(text)) deps.add('redis');
        if (/boto3|minio/.test(text)) deps.add('objectStorage');
        evidence.push(`Python manifest (${packageManager}${framework ? `, ${framework}` : ''})`);
    } else if (has('go.mod')) {
        language = 'go';
        packageManager = 'go';
        defaultPort = 8080;
        const text = files['go.mod'];
        framework = /gin-gonic/.test(text)
            ? 'gin'
            : /labstack\/echo/.test(text)
              ? 'echo'
              : /gofiber/.test(text)
                ? 'fiber'
                : null;
        if (/jackc\/pgx|lib\/pq/.test(text)) deps.add('postgres');
        if (/go-redis|redis\/go-redis/.test(text)) deps.add('redis');
        if (/minio-go|aws-sdk-go/.test(text)) deps.add('objectStorage');
        evidence.push(`go.mod${framework ? ` (${framework})` : ''}`);
    } else if (has('Gemfile')) {
        language = 'ruby';
        packageManager = 'bundler';
        const text = files['Gemfile'];
        framework = /['"]rails['"]/.test(text)
            ? 'rails'
            : /['"]sinatra['"]/.test(text)
              ? 'sinatra'
              : null;
        defaultPort = 3000;
        if (/['"]pg['"]/.test(text)) deps.add('postgres');
        if (/['"](redis|sidekiq)['"]/.test(text)) deps.add('redis');
        if (/aws-sdk-s3/.test(text)) deps.add('objectStorage');
        evidence.push(`Gemfile${framework ? ` (${framework})` : ''}`);
    } else if (has('composer.json')) {
        language = 'php';
        packageManager = 'composer';
        framework = root.has('artisan')
            ? 'laravel'
            : /symfony\//.test(files['composer.json'])
              ? 'symfony'
              : null;
        defaultPort = 8000;
        evidence.push(`composer.json${framework ? ` (${framework})` : ''}`);
    } else if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
        language = 'java';
        packageManager = has('pom.xml') ? 'maven' : 'gradle';
        const text = [files['pom.xml'], files['build.gradle'], files['build.gradle.kts']]
            .filter(Boolean)
            .join('\n');
        framework = /spring-boot/.test(text)
            ? 'spring-boot'
            : /quarkus/.test(text)
              ? 'quarkus'
              : null;
        defaultPort = 8080;
        if (/postgresql/.test(text)) deps.add('postgres');
        evidence.push(`${packageManager} build${framework ? ` (${framework})` : ''}`);
    } else if (has('Cargo.toml')) {
        language = 'rust';
        packageManager = 'cargo';
        const text = files['Cargo.toml'];
        framework = /\baxum\b/.test(text)
            ? 'axum'
            : /actix-web/.test(text)
              ? 'actix-web'
              : /\brocket\b/.test(text)
                ? 'rocket'
                : null;
        defaultPort = 8080;
        if (/sqlx|tokio-postgres|diesel/.test(text)) deps.add('postgres');
        if (/\bredis\b/.test(text)) deps.add('redis');
        evidence.push(`Cargo.toml${framework ? ` (${framework})` : ''}`);
    } else if (root.has('index.html')) {
        language = 'static';
        defaultPort = 8080;
        evidence.push('index.html at the root (static site)');
    }

    // ── env example ──────────────────────────────────────────────────────
    const envExampleFile = ['.env.example', '.env.sample', 'example.env'].find(has) ?? null;
    const envNames = envExampleFile
        ? parseEnvNames(files[envExampleFile]).slice(0, MAX_ENV_ENTRIES)
        : [];
    for (const name of envNames) {
        if (/^(DATABASE_URL|POSTGRES_|PG(HOST|USER|PASSWORD|DATABASE))/.test(name))
            deps.add('postgres');
        if (/^REDIS_/.test(name)) deps.add('redis');
        if (/^(S3_|AWS_S3|MINIO_)/.test(name)) deps.add('objectStorage');
        if (/^(SMTP_|EMAIL_SERVER|MAIL_)/.test(name)) deps.add('smtp');
    }
    if (envExampleFile) evidence.push(`${envExampleFile} lists ${envNames.length} variables`);

    const port = dockerPort ?? composePort ?? defaultPort;
    const buildStrategy: AppRepositoryDetection['buildStrategy'] = dockerfile
        ? 'dockerfile'
        : language
          ? 'auto'
          : 'none';
    const runnable = buildStrategy !== 'none';
    if (!runnable) evidence.push('nothing that builds or serves HTTP was recognised');

    return {
        existingSpec,
        dockerfile,
        dockerTarget,
        composeFile,
        helmChart,
        procfile,
        language,
        packageManager,
        framework,
        port,
        startCommand: dockerfile ? null : startCommand,
        healthPath: dockerHealth,
        dependencies: [...deps].sort(),
        envExampleFile,
        envNames,
        buildStrategy,
        runnable,
        evidence,
    };
}

/* -------------------------------------------------------------------------- *
 * The first App spec
 * -------------------------------------------------------------------------- */

/** What the draft keeps from the Work. */
export interface AppSpecDraftContext {
    /** The Work's name, used for `name:` at the root. */
    readonly name: string;
    /** The existing `.works/works.yml`, when the repository has one (its owned blocks are kept). */
    readonly existingText?: string | null;
    /** The source relation, when there is no existing file to read it from. */
    readonly source?: {
        relation: string;
        upstream?: { repo: string; defaultBranch?: string };
    } | null;
}

/** Blocks the provisioner never rewrites (SKILL.md hard rule 5). */
const OWNED_BLOCKS = [
    'source',
    'blueprint',
    'license',
    'upstreamSync',
    'upstreamPullRequests',
    'provisioning',
];

/**
 * Build a `.works/works.yml` document from a detection. The owned blocks of an existing
 * file are carried over verbatim; everything the detection can justify is added.
 */
export function draftAppSpecDocument(
    detection: AppRepositoryDetection,
    context: AppSpecDraftContext,
): string {
    const existing = parseExisting(context.existingText);
    const existingSpec = record(existing?.spec) ?? {};
    const spec: Record<string, unknown> = {};
    for (const key of OWNED_BLOCKS) {
        if (existingSpec[key] !== undefined) spec[key] = existingSpec[key];
    }
    if (spec['source'] === undefined && context.source) {
        spec['source'] = context.source;
    }

    if (detection.runnable) {
        const build: Record<string, unknown> = { strategy: detection.buildStrategy };
        if (detection.buildStrategy === 'dockerfile' && detection.dockerfile) {
            if (detection.dockerfile !== 'Dockerfile') build['dockerfile'] = detection.dockerfile;
            if (detection.dockerTarget) build['target'] = detection.dockerTarget;
        }
        spec['build'] = build;

        const component: Record<string, unknown> = {
            name: 'web',
            role: 'web',
            port: detection.port ?? 8080,
        };
        if (detection.startCommand && detection.buildStrategy === 'auto') {
            component['command'] = [...detection.startCommand];
        }
        component['probes'] = {
            readiness: detection.healthPath ? { http: detection.healthPath } : { tcp: true },
        };
        spec['components'] = [component];

        const dependencies: Record<string, unknown> = {};
        for (const dep of detection.dependencies) {
            if (dep === 'postgres') dependencies['postgres'] = { version: '16' };
            if (dep === 'redis') dependencies['redis'] = { version: '7' };
            if (dep === 'objectStorage') dependencies['objectStorage'] = { buckets: ['uploads'] };
            if (dep === 'smtp') dependencies['smtp'] = { required: false };
        }
        if (Object.keys(dependencies).length > 0) spec['dependencies'] = dependencies;

        const env = detection.envNames
            .map((name) => envEntry(name, detection.dependencies))
            .filter((entry): entry is Record<string, unknown> => entry !== null);
        if (env.length > 0) spec['env'] = env;
    }

    const document: Record<string, unknown> = {
        version: typeof existing?.version === 'number' ? existing.version : 2,
        kind: 'app',
        name:
            typeof existing?.name === 'string' && existing.name
                ? existing.name
                : slugName(context.name),
        spec,
    };
    return stringifyYaml(document, { lineWidth: 0 });
}

/* -------------------------------------------------------------------------- *
 * Parsers (small, forgiving, never executing anything)
 * -------------------------------------------------------------------------- */

export function parseDockerfile(text: string): {
    ports: number[];
    target: string | null;
    healthPath: string | null;
} {
    const ports: number[] = [];
    const stages: string[] = [];
    let healthPath: string | null = null;
    // Token-wise, never a backtracking regex over repository text (CodeQL js/polynomial-redos).
    for (const raw of text.split(/\r?\n/)) {
        const tokens = raw
            .trim()
            .split(/[ \t]+/)
            .filter(Boolean);
        const instruction = (tokens[0] ?? '').toUpperCase();
        if (instruction === 'EXPOSE') {
            for (const token of tokens.slice(1)) {
                const port = Number.parseInt(token.split('/')[0], 10);
                if (Number.isInteger(port) && port > 0 && port < 65536) ports.push(port);
            }
        }
        if (instruction === 'FROM' && tokens.length === 4 && tokens[2].toUpperCase() === 'AS') {
            if (/^[A-Za-z0-9._-]{1,64}$/.test(tokens[3])) stages.push(tokens[3]);
        }
        if (instruction === 'HEALTHCHECK') {
            const path = localHealthPath(tokens.slice(1));
            if (path) healthPath = path;
        }
    }
    // The last stage is what `docker build` produces; name it only when it is clearly the
    // production one, otherwise leave `target` unset (the default is the last stage anyway).
    const last = stages[stages.length - 1] ?? null;
    const target =
        stages.find((stage) => /^(prod|production|runner|runtime|release|final)$/i.test(stage)) ??
        null;
    return { ports, target: target && target !== last ? target : null, healthPath };
}

export function parseCompose(text: string): {
    port: number | null;
    dependencies: DetectedDependency[];
} {
    const doc = parseExisting(text);
    const services = record(doc?.services) ?? {};
    const dependencies = new Set<DetectedDependency>();
    let port: number | null = null;
    for (const value of Object.values(services)) {
        const service = record(value) ?? {};
        const image = typeof service['image'] === 'string' ? service['image'].toLowerCase() : '';
        if (/postgres|postgis|timescale/.test(image)) dependencies.add('postgres');
        else if (/redis|valkey|keydb|dragonfly/.test(image)) dependencies.add('redis');
        else if (/minio|localstack/.test(image)) dependencies.add('objectStorage');
        else if (/mailhog|mailpit|smtp/.test(image)) dependencies.add('smtp');
        else if (port === null && Array.isArray(service['ports'])) {
            const first = service['ports'][0];
            const text =
                typeof first === 'number' ? String(first) : typeof first === 'string' ? first : '';
            const container = Number.parseInt(text.split(':').pop() ?? '', 10);
            if (Number.isInteger(container) && container > 0 && container < 65536) port = container;
        }
    }
    return { port, dependencies: [...dependencies] };
}

export function parseEnvNames(text: string): string[] {
    const names: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{0,127})\s*=/.exec(raw);
        if (match && !names.includes(match[1]) && !match[1].startsWith('EVER_WORKS_')) {
            names.push(match[1]);
        }
    }
    return names;
}

const PUBLIC_URL_NAMES =
    /^(APP_URL|BASE_URL|SITE_URL|PUBLIC_URL|NEXTAUTH_URL|AUTH_URL|ORIGIN|NEXT_PUBLIC_(APP|SITE|BASE)_URL|VITE_(APP|SITE|BASE)_URL)$/;
const GENERATED_SECRET_NAMES =
    /(SECRET|SALT|SESSION_KEY|JWT_KEY|SIGNING_KEY|ENCRYPTION_KEY|COOKIE_KEY|APP_KEY)$/;
const SECRET_NAMES = /(SECRET|TOKEN|PASSWORD|PASS|PRIVATE|API_KEY|_KEY|SALT|DSN|CREDENTIALS?)$/;
const BUILD_PREFIXES = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|NUXT_PUBLIC_|EXPO_PUBLIC_|GATSBY_)/;

function envEntry(
    name: string,
    deps: readonly DetectedDependency[],
): Record<string, unknown> | null {
    const phase = BUILD_PREFIXES.test(name) ? 'both' : undefined;
    const withPhase = (entry: Record<string, unknown>) => (phase ? { ...entry, phase } : entry);
    if (deps.includes('postgres') && name === 'DATABASE_URL') {
        return { name, secret: true, from: 'deps.postgres.url' };
    }
    if (deps.includes('postgres') && name === 'DIRECT_URL') {
        return null; // needs `directUrl: true`; left for the agent to decide.
    }
    if (deps.includes('redis') && name === 'REDIS_URL') {
        return { name, secret: true, from: 'deps.redis.url' };
    }
    if (PUBLIC_URL_NAMES.test(name)) {
        return withPhase({ name, from: 'domains.primary.url' });
    }
    if (GENERATED_SECRET_NAMES.test(name) && !BUILD_PREFIXES.test(name)) {
        return { name, secret: true, generate: { kind: 'hex', bytes: 32, rotate: 'never' } };
    }
    if (SECRET_NAMES.test(name) && !BUILD_PREFIXES.test(name)) {
        return {
            name,
            secret: true,
            prompt: {
                description: `${name} (listed in the repository's example env file).`,
                required: false,
            },
        };
    }
    return withPhase({
        name,
        prompt: {
            description: `${name} (listed in the repository's example env file).`,
            required: false,
        },
    });
}

function nodeFramework(names: Set<string>): { name: string; port: number } | null {
    if (names.has('next')) return { name: 'next', port: 3000 };
    if (names.has('nuxt') || names.has('nuxt3')) return { name: 'nuxt', port: 3000 };
    if ([...names].some((n) => n.startsWith('@remix-run/'))) return { name: 'remix', port: 3000 };
    if (names.has('@sveltejs/kit')) return { name: 'sveltekit', port: 3000 };
    if (names.has('astro')) return { name: 'astro', port: 4321 };
    if (names.has('@nestjs/core')) return { name: 'nestjs', port: 3000 };
    if (names.has('fastify')) return { name: 'fastify', port: 3000 };
    if (names.has('hono')) return { name: 'hono', port: 3000 };
    if (names.has('koa')) return { name: 'koa', port: 3000 };
    if (names.has('express')) return { name: 'express', port: 3000 };
    if (names.has('vite')) return { name: 'vite', port: 4173 };
    return null;
}

function nodeDependencies(names: Set<string>, prismaSchema?: string): DetectedDependency[] {
    const out = new Set<DetectedDependency>();
    if (
        names.has('pg') ||
        names.has('postgres') ||
        names.has('pg-promise') ||
        names.has('@neondatabase/serverless')
    ) {
        out.add('postgres');
    }
    if (prismaSchema && /provider\s*=\s*"postgres(ql)?"/.test(prismaSchema)) out.add('postgres');
    if (names.has('ioredis') || names.has('redis') || names.has('bullmq') || names.has('bull'))
        out.add('redis');
    if (names.has('@aws-sdk/client-s3') || names.has('aws-sdk') || names.has('minio'))
        out.add('objectStorage');
    if (names.has('nodemailer')) out.add('smtp');
    return [...out];
}

function parseExisting(text: string | null | undefined): Record<string, unknown> | null {
    if (!text) return null;
    try {
        return record(parseYaml(text));
    } catch {
        return null;
    }
}

function safeJson(text: string): Record<string, unknown> | null {
    try {
        return record(JSON.parse(text));
    } catch {
        return null;
    }
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function slugName(name: string): string {
    const dashed = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let start = 0;
    let end = dashed.length;
    while (start < end && dashed[start] === '-') start += 1;
    while (end > start && dashed[end - 1] === '-') end -= 1;
    const slug = dashed.slice(start, end).slice(0, 63);
    return slug || 'app';
}

/** The path of a `curl`/`wget` health URL on the container itself, from HEALTHCHECK tokens. */
function localHealthPath(tokens: readonly string[]): string | null {
    for (const raw of tokens) {
        let token = raw;
        while (token.startsWith('"') || token.startsWith("'")) token = token.slice(1);
        while (token.endsWith('"') || token.endsWith("'")) token = token.slice(0, -1);
        const scheme = token.startsWith('http://') ? 7 : token.startsWith('https://') ? 8 : 0;
        if (!scheme) continue;
        const rest = token.slice(scheme);
        const slash = rest.indexOf('/');
        const host = (slash < 0 ? rest : rest.slice(0, slash)).split(':')[0];
        if (!['localhost', '127.0.0.1', '0.0.0.0'].includes(host)) continue;
        const path = slash < 0 ? '/' : rest.slice(slash);
        return path.length <= 255 ? path : null;
    }
    return null;
}
