/**
 * Trigger.dev build extension: make NestJS core load its two optional
 * transport modules lazily inside the worker bundle.
 *
 * `@nestjs/core/nest-application.js` runs two `optionalRequire` calls at
 * module scope, for `@nestjs/websockets/socket-module` and
 * `@nestjs/microservices/microservices-module`. Both packages are installed
 * in the worker image (they are listed as `build.external` in
 * `trigger.config.ts`). So every process that imports `@nestjs/core` loads both
 * unbundled from `node_modules` at import time: the deploy indexer, which has a
 * fixed 20 s budget, and every worker cold start. That cost ~0.5 s of the
 * ~2.5 s local index. The worker builds Nest only through
 * `NestFactory.createApplicationContext`, which never constructs a
 * `NestApplication`, so it never uses either module.
 *
 * Neither module is stubbed or dropped. The two module-scope lookups move
 * into the `NestApplication` constructor, the only place that reads them. An
 * HTTP app created with `NestFactory.create` still gets its socket and
 * microservices modules exactly as before; they just load on first
 * construction instead of on import.
 *
 * Safe by construction: the file is rewritten only when all four expected
 * snippets are present (verified against `@nestjs/core` 11.2.x). On any other
 * shape the original file is bundled untouched and the build logs a warning,
 * so a Nest upgrade can drop the optimisation but never break the bundle.
 *
 * Gate: set `TRIGGER_NEST_EAGER_OPTIONAL_MODULES=true` at build time to turn
 * the rewrite off and bundle stock `@nestjs/core`.
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BuildExtension } from '@trigger.dev/build';

const SOCKET_IMPORT =
    "const { SocketModule } = (0, optional_require_1.optionalRequire)('@nestjs/websockets/socket-module', () => require('@nestjs/websockets/socket-module'));";
const MICROSERVICES_IMPORT =
    "const { MicroservicesModule } = (0, optional_require_1.optionalRequire)('@nestjs/microservices/microservices-module', () => require('@nestjs/microservices/microservices-module'));";
const SOCKET_CTOR = 'this.socketModule = SocketModule && new SocketModule();';
const MICROSERVICES_CTOR =
    'this.microservicesModule = MicroservicesModule && new MicroservicesModule();';

const LAZY_SOCKET_IMPORT =
    "const loadSocketModule = () => (0, optional_require_1.optionalRequire)('@nestjs/websockets/socket-module', () => require('@nestjs/websockets/socket-module')).SocketModule;";
const LAZY_MICROSERVICES_IMPORT =
    "const loadMicroservicesModule = () => (0, optional_require_1.optionalRequire)('@nestjs/microservices/microservices-module', () => require('@nestjs/microservices/microservices-module')).MicroservicesModule;";
const LAZY_SOCKET_CTOR =
    'this.socketModule = (() => { const SocketModule = loadSocketModule(); return SocketModule && new SocketModule(); })();';
const LAZY_MICROSERVICES_CTOR =
    'this.microservicesModule = (() => { const MicroservicesModule = loadMicroservicesModule(); return MicroservicesModule && new MicroservicesModule(); })();';

const NEST_APPLICATION_FILE = /[\\/]@nestjs[\\/]core[\\/]nest-application\.js$/;

const countOf = (source: string, snippet: string): number => source.split(snippet).length - 1;

/**
 * Rewrite `@nestjs/core/nest-application.js` so the optional socket and
 * microservices modules load in the `NestApplication` constructor instead of
 * at import. Returns `null` (leave the file alone) unless every expected
 * snippet occurs exactly once and the identifiers appear nowhere else.
 */
export function makeNestOptionalModulesLazy(source: string): string | null {
    const snippets = [SOCKET_IMPORT, MICROSERVICES_IMPORT, SOCKET_CTOR, MICROSERVICES_CTOR];
    if (snippets.some((snippet) => countOf(source, snippet) !== 1)) {
        return null;
    }
    const rewritten = source
        .replace(SOCKET_IMPORT, LAZY_SOCKET_IMPORT)
        .replace(MICROSERVICES_IMPORT, LAZY_MICROSERVICES_IMPORT)
        .replace(SOCKET_CTOR, LAZY_SOCKET_CTOR)
        .replace(MICROSERVICES_CTOR, LAZY_MICROSERVICES_CTOR);
    // Any other reference to the old module-scope bindings would now be
    // unbound; refuse rather than emit a file that throws at run time.
    const leftover = [
        LAZY_SOCKET_IMPORT,
        LAZY_MICROSERVICES_IMPORT,
        LAZY_SOCKET_CTOR,
        LAZY_MICROSERVICES_CTOR,
    ].reduce((text, snippet) => text.replace(snippet, ''), rewritten);
    if (/\bSocketModule\b|\bMicroservicesModule\b/.test(leftover)) {
        return null;
    }
    return rewritten;
}

export function lazyNestOptionalModules(): BuildExtension {
    return {
        name: 'lazyNestOptionalModules',
        onBuildStart(context) {
            if (process.env.TRIGGER_NEST_EAGER_OPTIONAL_MODULES === 'true') {
                context.logger.log(
                    '[lazyNestOptionalModules] disabled (TRIGGER_NEST_EAGER_OPTIONAL_MODULES=true)',
                );
                return;
            }
            context.registerPlugin({
                name: 'lazyNestOptionalModules',
                setup(build) {
                    build.onLoad({ filter: NEST_APPLICATION_FILE }, async (args) => {
                        const source = await readFile(args.path, 'utf8');
                        const rewritten = makeNestOptionalModulesLazy(source);
                        if (rewritten === null) {
                            context.logger.warn(
                                `[lazyNestOptionalModules] unexpected shape of ${args.path}; bundling it unchanged`,
                            );
                            return undefined;
                        }
                        return { contents: rewritten, loader: 'js', resolveDir: dirname(args.path) };
                    });
                },
            });
        },
    };
}
