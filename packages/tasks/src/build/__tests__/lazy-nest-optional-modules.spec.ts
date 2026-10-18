import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNestOptionalModulesLazy } from '../lazy-nest-optional-modules';

const requireFromHere = createRequire(__filename);
const nestApplicationPath = requireFromHere.resolve('@nestjs/core/nest-application.js');
const stockSource = readFileSync(nestApplicationPath, 'utf8');

type ModuleInternals = typeof Module & {
    _nodeModulePaths(dir: string): string[];
};

/** Compile `source` as if it were `@nestjs/core/nest-application.js` itself. */
function compileAsNestApplication(source: string): Record<string, unknown> {
    const mod = new Module(nestApplicationPath) as Module & {
        _compile(code: string, filename: string): void;
    };
    mod.filename = nestApplicationPath;
    mod.paths = (Module as ModuleInternals)._nodeModulePaths(dirname(nestApplicationPath));
    mod._compile(source, nestApplicationPath);
    return mod.exports as Record<string, unknown>;
}

const loadedOptionalModules = (): string[] =>
    Object.keys(requireFromHere.cache).filter((key) =>
        /[\\/]@nestjs[\\/](websockets[\\/]socket-module|microservices[\\/]microservices-module)\.js$/.test(
            key,
        ),
    );

describe('lazyNestOptionalModules', () => {
    it('rewrites the installed @nestjs/core nest-application.js', () => {
        const rewritten = makeNestOptionalModulesLazy(stockSource);
        expect(rewritten).not.toBeNull();
        expect(rewritten).not.toContain('const { SocketModule } =');
        expect(rewritten).not.toContain('const { MicroservicesModule } =');
        expect(rewritten).toContain('const loadSocketModule = () =>');
        expect(rewritten).toContain('const loadMicroservicesModule = () =>');
    });

    it('leaves any other file shape untouched', () => {
        expect(makeNestOptionalModulesLazy('module.exports = {};')).toBeNull();
        // A second copy of a snippet means the shape is not the one we know.
        const doubled = stockSource.replace(
            'this.socketModule = SocketModule && new SocketModule();',
            'this.socketModule = SocketModule && new SocketModule(); this.socketModule = SocketModule && new SocketModule();',
        );
        expect(makeNestOptionalModulesLazy(doubled)).toBeNull();
        // A stray use of the old binding would be unbound after the rewrite.
        expect(makeNestOptionalModulesLazy(`${stockSource}\nvoid SocketModule;\n`)).toBeNull();
    });

    it('defers both optional modules to NestApplication construction and still wires them', () => {
        const rewritten = makeNestOptionalModulesLazy(stockSource);
        expect(rewritten).not.toBeNull();

        const before = loadedOptionalModules();
        const { NestApplication } = compileAsNestApplication(rewritten as string) as {
            NestApplication: new (...args: unknown[]) => {
                socketModule: unknown;
                microservicesModule: unknown;
            };
        };
        // Importing the rewritten file loads neither optional module...
        expect(loadedOptionalModules()).toEqual(before);

        const { NestContainer } = requireFromHere('@nestjs/core/injector/container');
        const { ApplicationConfig } = requireFromHere('@nestjs/core/application-config');
        const { GraphInspector } = requireFromHere('@nestjs/core/inspector/graph-inspector');
        const container = new NestContainer();
        const httpAdapter = { initHttpServer: () => undefined, getHttpServer: () => ({}) };
        const app = new NestApplication(
            container,
            httpAdapter,
            new ApplicationConfig(),
            new GraphInspector(container),
            {},
        );

        // ...and constructing an HTTP app still gets both, exactly as stock Nest.
        expect(app.socketModule).toBeTruthy();
        expect(app.microservicesModule).toBeTruthy();
        expect(loadedOptionalModules()).toHaveLength(2);
    });
});
