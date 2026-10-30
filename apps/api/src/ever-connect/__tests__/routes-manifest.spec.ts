import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Controller, Get, RequestMethod, type Type } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY, Public } from '../../auth/decorators/public.decorator';
import { IsPlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
import { EverConnectAdminController } from '../ever-connect-admin.controller';
import { EverConnectModule } from '../ever-connect.module';
import { EverConnectWellKnownController } from '../well-known.controller';

/**
 * The module's route manifest (`ever-connect.routes.json`) is the controllers'
 * own registration, written down: every route with the authentication it
 * needs, `public` (answers without a session) and `inbound` (requests Ever
 * Platform makes to the installation). The only public route is the address
 * statement Ever Platform reads; every operator route is for platform
 * administrators.
 *
 * A route added without a guard, or made public, changes the generated
 * manifest and fails here until the committed file is updated on purpose
 * (`UPDATE_ROUTES_MANIFEST=1`).
 */
interface ManifestRoute {
    method: string;
    path: string;
    auth: 'public' | 'session' | 'platform-admin';
}

const MANIFEST_PATH = join(__dirname, '..', 'ever-connect.routes.json');

function routesOf(controller: Type): ManifestRoute[] {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '').replace(
        /^\/|\/$/g,
        '',
    );
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
    const proto = controller.prototype as Record<string, unknown>;
    const out: ManifestRoute[] = [];
    for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler);
        if (path === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const guards: unknown[] = [
            ...classGuards,
            ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
        ];
        const isPublic = classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
        out.push({
            method,
            path: `/${[base, String(path).replace(/^\/|\/$/g, '')].filter(Boolean).join('/')}`,
            auth: isPublic
                ? 'public'
                : guards.includes(IsPlatformAdminGuard)
                  ? 'platform-admin'
                  : 'session',
        });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function generate(controllers: Type[]) {
    const routes = controllers.flatMap(routesOf);
    return {
        public: routes
            .filter((route) => route.auth === 'public')
            .map(({ method, path }) => ({ method, path })),
        routes,
    };
}

describe('Ever Connect — route manifest', () => {
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
        manifest: string;
        product: string;
        module: string;
        public: unknown[];
        inbound: unknown[];
        routes: ManifestRoute[];
    };
    const controllers: Type[] = Reflect.getMetadata('controllers', EverConnectModule) ?? [];

    it('is generated from every controller of the module', () => {
        expect(controllers).toEqual([EverConnectAdminController, EverConnectWellKnownController]);
        const generated = generate(controllers);
        if (process.env.UPDATE_ROUTES_MANIFEST === '1') {
            writeFileSync(
                MANIFEST_PATH,
                `${JSON.stringify({ ...committed, public: generated.public, routes: generated.routes }, null, 4)}\n`,
            );
            return;
        }
        expect(committed.routes).toEqual(generated.routes);
        expect(committed.public).toEqual(generated.public);
    });

    it('opens only the address statement, which is also the one request Ever Platform makes', () => {
        expect(committed).toMatchObject({
            manifest: 'ever-connect.routes.v1',
            product: 'works',
            module: 'ever-connect',
            public: [{ method: 'GET', path: '/.well-known/ever-connect' }],
            inbound: [{ method: 'GET', path: '/.well-known/ever-connect' }],
        });
        expect(
            committed.routes.filter(
                (route) => route.auth !== 'platform-admin' && route.path.startsWith('/api/'),
            ),
        ).toEqual([]);
    });

    it('control: a planted unguarded or public route changes the manifest', () => {
        @Controller('api/ever-connect')
        class Planted {
            @Get('debug')
            debug() {
                return 'x';
            }

            @Public()
            @Get('open')
            open() {
                return 'x';
            }
        }
        const generated = generate([...controllers, Planted]);
        expect(generated.routes).not.toEqual(committed.routes);
        expect(generated.public).toContainEqual({ method: 'GET', path: '/api/ever-connect/open' });
        expect(generated.routes).toContainEqual({
            method: 'GET',
            path: '/api/ever-connect/debug',
            auth: 'session',
        });
    });
});
