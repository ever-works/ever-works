import { Module } from '@nestjs/common';

import { FacadesModule } from '../../facades/facades.module';
import { CategoryIconService } from './category-icon.service';

/**
 * Category icon resolution subsystem (EW-357).
 *
 * Exports {@link CategoryIconService} so the data-generator and any
 * future consumer (e.g. a Trigger.dev backfill task) can resolve and
 * persist `icon_svg` for AI-classified categories.
 *
 * The service depends on:
 *   - {@link AiFacadeService} — provided by FacadesModule.
 *   - The global `CACHE_MANAGER` — registered at the API root via
 *     `CacheFactory.TypeORM({ isGlobal: true })`. The injection is
 *     marked `@Optional()` in the service so contexts without a cache
 *     (unit tests, the CLI) still work.
 */
@Module({
    imports: [FacadesModule],
    providers: [CategoryIconService],
    exports: [CategoryIconService],
})
export class CategoryIconModule {}
