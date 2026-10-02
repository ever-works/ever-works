import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Controller, Get, RequestMethod, type Type } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY, Public } from '../../auth/decorators/public.decorator';
import { IsPlatformAdminGuard } from '../../auth/guards/platform-admin.guard';
import { InstanceStatsController } from '../instance-stats.controller';
import { InstanceStatsModule } from '../instance-stats.module';

/**
 * The module's route manifest (`ever-connect.routes.json`) is the controller's
 * own registration, written down: every route with the authentication it
 * needs, and the two lists the Ever Platform tooling reads — `public` (answers
 * without a session) and `inbound` (requests Ever Platform makes to the
 * installation). Both are empty: the statistics module only sends.
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

describe('instance statistics — route manifest', () => {
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
        manifest: string;
        product: string;
        module: string;
        public: unknown[];
        inbound: unknown[];
        routes: ManifestRoute[];
    };
    const controllers: Type[] = Reflect.getMetadata('controllers', InstanceStatsModule) ?? [];

    it('is generated from every controller of the module', () => {
        expect(controllers).toEqual([InstanceStatsController]);
        const generated = generate(controllers);
        if (process.env.UPDATE_ROUTES_MANIFEST === '1') {
            writeFileSync(
                MANIFEST_PATH,
                `${JSON.stringify({ ...committed, public: generated.public, routes: generated.routes }, null, 2)}\n`,
            );
            return;
        }
        expect(committed.routes).toEqual(generated.routes);
        expect(committed.public).toEqual(generated.public);
    });

    it('declares no public route and no request from Ever Platform', () => {
        expect(committed).toMatchObject({
            manifest: 'ever-connect.routes.v1',
            product: 'works',
            module: 'instance-stats',
            public: [],
            inbound: [],
        });
        // Only `status` is open to every signed-in person; it answers {enabled} to them.
        expect(committed.routes.filter((route) => route.auth !== 'platform-admin')).toEqual([
            { method: 'GET', path: '/api/instance-stats/status', auth: 'session' },
        ]);
    });

    it('control: a planted unguarded or public route changes the manifest', () => {
        @Controller('api/instance-stats')
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
        expect(generated.public).toEqual([{ method: 'GET', path: '/api/instance-stats/open' }]);
        expect(generated.routes).toContainEqual({
            method: 'GET',
            path: '/api/instance-stats/debug',
            auth: 'session',
        });
    });
});
