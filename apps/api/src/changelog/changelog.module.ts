import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '@src/auth';
import { CHANGELOG_ENTRY_SOURCE } from './changelog-entry-source';
import { ChangelogController } from './changelog.controller';
import { ChangelogService } from './changelog.service';
import { BundledChangelogEntrySource } from './sources/bundled-changelog-entry.source';

/**
 * What's new (AW-14) — the in-product product changelog.
 *
 * `CHANGELOG_ENTRY_SOURCE` is the one seam for where entries come from. It is
 * bound here to the entries file committed in this repository; binding a
 * different `ChangelogEntrySource` implementation is the whole change needed
 * to read entries from somewhere else.
 *
 * No background work: there is nothing to precompute, deliver or ingest.
 */
@Module({
    imports: [DatabaseModule, AuthModule],
    controllers: [ChangelogController],
    providers: [
        ChangelogService,
        {
            provide: CHANGELOG_ENTRY_SOURCE,
            useFactory: () => new BundledChangelogEntrySource(),
        },
    ],
    exports: [ChangelogService],
})
export class ChangelogModule {}
