// The auth barrel drags the whole agent service graph (and ESM-only
// dependencies Jest cannot parse) into this spec. Authentication is not what
// this file guards, so stand in a provider-free AuthModule and guard.
// `@src/auth` (the module) and `../auth` (the controller) resolve to the same
// file, so this one mock covers both import spellings.
jest.mock('@src/auth', () => {
    const { Module } = jest.requireActual('@nestjs/common');
    class AuthModule {}
    Module({})(AuthModule);
    return {
        AuthModule,
        AuthSessionGuard: class AuthSessionGuard {},
        CurrentUser: () => () => undefined,
    };
});

import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTITIES, ProductChangelogReadRepository } from '@ever-works/agent/database';
import { ChangelogModule } from './changelog.module';
import { ChangelogController } from './changelog.controller';
import { ChangelogService } from './changelog.service';
import { CHANGELOG_ENTRY_SOURCE, type ChangelogEntrySource } from './changelog-entry-source';
import { BundledChangelogEntrySource } from './sources/bundled-changelog-entry.source';
import { CHANGELOG_ENTRIES } from './changelog.catalog';

/**
 * What's new (AW-14) — `ChangelogModule` against a REAL Nest container and a
 * real (in-memory sqlite) TypeORM connection, so a missing import, an
 * unregistered entity or an unbound source token fails here instead of at
 * API boot. The controller spec constructs the controller positionally and
 * cannot see any of that.
 */
describe('ChangelogModule — dependency injection', () => {
    async function compile(override?: ChangelogEntrySource) {
        const builder = Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                ChangelogModule,
            ],
        });
        if (override) {
            builder.overrideProvider(CHANGELOG_ENTRY_SOURCE).useValue(override);
        }
        return builder.compile();
    }

    it('resolves the controller, the service and the read repository', async () => {
        const moduleRef = await compile();

        expect(moduleRef.get(ChangelogController)).toBeInstanceOf(ChangelogController);
        expect(moduleRef.get(ChangelogService)).toBeInstanceOf(ChangelogService);
        expect(moduleRef.get(ProductChangelogReadRepository, { strict: false })).toBeInstanceOf(
            ProductChangelogReadRepository,
        );

        await moduleRef.close();
    });

    it('binds the entries file committed in this repository as the default source', async () => {
        const moduleRef = await compile();

        const source = moduleRef.get<ChangelogEntrySource>(CHANGELOG_ENTRY_SOURCE);
        expect(source).toBeInstanceOf(BundledChangelogEntrySource);
        await expect(source.load()).resolves.toBe(CHANGELOG_ENTRIES);

        await moduleRef.close();
    });

    it('lets a different source replace the default through the token alone', async () => {
        const replacement: ChangelogEntrySource = { id: 'replacement', load: async () => [] };
        const moduleRef = await compile(replacement);

        expect(moduleRef.get(CHANGELOG_ENTRY_SOURCE)).toBe(replacement);
        expect(moduleRef.get(ChangelogService)).toBeInstanceOf(ChangelogService);

        await moduleRef.close();
    });
});
