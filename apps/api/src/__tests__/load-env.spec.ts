import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `EVER_STATS_ENABLED=false` written in the API's `.env` FILE switches the
 * anonymous usage statistics module off — through the real boot order.
 *
 * `ApiModule` decides whether to import the statistics module when its
 * `@Module` decorator is evaluated, i.e. when `main.ts` imports it. The `.env`
 * file used to be loaded later, inside `bootstrap()`, so a value written there
 * was invisible to that decision: the module stayed loaded and kept sending.
 * Every other test passed an explicit environment object and could not see it.
 *
 * This spec runs `main.ts` itself from a working directory holding a `.env`,
 * with nothing in `process.env`. Two things are replaced, and nothing else:
 *
 *   - `./api.module` by a root module whose decorator evaluates exactly what
 *     `ApiModule`'s does for statistics (`...instanceStatsModuleImports()`),
 *     at exactly the moment `main.ts` imports it — the real `ApiModule` cannot
 *     be loaded under this app's jest (see `app-works-di-reachability.spec.ts`),
 *     and `off.spec.ts` pins that this spread is the only way it reaches the
 *     module;
 *   - `NestFactory.create`, which records the root module it is given instead
 *     of booting it;
 *   - `@scalar/nestjs-api-reference`, which jest cannot load (an ESM-only
 *     dependency) and which `main.ts` uses only after `NestFactory.create`.
 *
 * With `main.ts` loading `.env` after importing `./api.module`, the switch is
 * blind to the file. Statistics are off by default (`EVER_STATS_DEFAULT_ENABLED`),
 * so the case that catches that order is `EVER_STATS_ENABLED=true` in `.env`:
 * the module would be missing from the graph although the file opts in. (While
 * the default was on, the `false` case failed instead: the module stayed in the
 * graph although the file said `false`.)
 */

const STATS_SWITCH = 'EVER_STATS_ENABLED';
/** Variables this spec sets or that `bootstrap()` would act on before `NestFactory.create`. */
const ISOLATED_VARS = [STATS_SWITCH, 'AUTH_SECRET', 'SENTRY_DSN', 'POSTHOG_API_KEY'] as const;

interface BootResult {
    /** The `imports` of the root module `main.ts` handed to `NestFactory.create`. */
    imports: unknown[];
    /** The statistics module class of the same module registry. */
    statsModule: unknown;
}

/** Run `main.ts` from a directory whose `.env` holds `dotenv` (`null`: no file). */
function bootMain(dotenv: string | null, env: Record<string, string> = {}): BootResult {
    const dir = mkdtempSync(join(tmpdir(), 'ew-api-dotenv-'));
    if (dotenv !== null) writeFileSync(join(dir, '.env'), dotenv);

    const saved = new Map(ISOLATED_VARS.map((name) => [name, process.env[name]]));
    for (const name of ISOLATED_VARS) delete process.env[name];
    // `bootstrap()` refuses a short AUTH_SECRET before it reaches NestFactory.
    process.env.AUTH_SECRET = 'a-test-only-secret-of-at-least-32-characters';
    Object.assign(process.env, env);

    const cwd = process.cwd();
    let root: unknown;
    let statsModule: unknown;
    process.chdir(dir);
    try {
        jest.isolateModules(() => {
            jest.doMock('../api.module', () => {
                // What `ApiModule`'s decorator does for the statistics module,
                // evaluated when `main.ts` imports `./api.module`.
                const { Module } = jest.requireActual('@nestjs/common');
                const stats = jest.requireActual('../instance-stats');
                statsModule = stats.InstanceStatsModule;
                class ApiModule {}
                Module({ imports: [...stats.instanceStatsModuleImports()] })(ApiModule);
                return { ApiModule };
            });
            jest.doMock('@scalar/nestjs-api-reference', () => ({
                apiReference: () => () => undefined,
            }));
            jest.doMock('@nestjs/core', () => ({
                ...jest.requireActual('@nestjs/core'),
                NestFactory: {
                    // Record the root and never resolve: nothing is booted.
                    create: (module: unknown) => {
                        root = module;
                        return new Promise(() => undefined);
                    },
                },
            }));
            require('../main');
        });
    } finally {
        process.chdir(cwd);
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        rmSync(dir, { recursive: true, force: true });
    }

    if (!root) throw new Error('main.ts never reached NestFactory.create');
    return { imports: Reflect.getMetadata('imports', root as object) ?? [], statsModule };
}

describe('API boot order: the .env file is loaded before ApiModule is evaluated', () => {
    it('main.ts imports ./load-env before anything else', () => {
        const source = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
        const firstImport = source.split('\n').find((line) => /^import\b/.test(line));
        expect(firstImport).toBe("import './load-env';");
    });

    it('EVER_STATS_ENABLED=false in .env: the statistics module is NOT in the graph', () => {
        const { imports, statsModule } = bootMain(`${STATS_SWITCH}=false\n`);
        expect(statsModule).toBeDefined();
        expect(imports).not.toContain(statsModule);
        expect(imports).toEqual([]);
    });

    it('EVER_STATS_ENABLED=true in .env: the module is in the graph (the opt-in survives the boot order)', () => {
        const { imports, statsModule } = bootMain(`${STATS_SWITCH}=true\n`);
        expect(statsModule).toBeDefined();
        expect(imports).toEqual([statsModule]);
    });

    it('no .env at all: off by default — the module is NOT in the graph', () => {
        const { imports, statsModule } = bootMain(null);
        expect(statsModule).toBeDefined();
        expect(imports).toEqual([]);
    });

    it('a .env that does not mention the switch: off by default', () => {
        const { imports } = bootMain('# settings of this installation, none about statistics\n');
        expect(imports).toEqual([]);
    });

    it('a value already in the environment still wins over the file, both ways', () => {
        const on = bootMain(`${STATS_SWITCH}=false\n`, { [STATS_SWITCH]: 'true' });
        expect(on.imports).toEqual([on.statsModule]);
        const off = bootMain(`${STATS_SWITCH}=true\n`, { [STATS_SWITCH]: 'false' });
        expect(off.imports).toEqual([]);
    });
});
