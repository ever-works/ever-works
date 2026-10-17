import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { APP_LICENSE_SERVICE } from '../app-runtime/app-license-gate';
import { APP_UPSTREAM_LICENSE_SERVICE } from '../app-works/app-upstream-sync.service';
import { AppLicenseService } from './app-license.service';

/**
 * APW-03 T42 — the licence service and the two consumer tokens it binds.
 *
 * Imports only leaf modules (`DatabaseModule` for `WorkRepository`, `FacadesModule` for
 * the git facade, `ActivityLogModule`), so the agent `AppWorksModule` can import it
 * without dragging `AppSpecModule` into its bare-graph specs; the App spec state
 * repository is looked up lazily by the service (see its docstring). The
 * `WorkUpstreamStateRepository` it reads for `aheadBy` is `@Optional()` and resolves
 * where the importing graph provides it.
 *
 * Both tokens are `useExisting`, so every consumer — APW-06's gate, APW-01's ready
 * handler, APW-02's sync (through the worker proxy named `AppLicenseService`) — reaches
 * ONE instance.
 */
@Module({
    imports: [DatabaseModule, FacadesModule, ActivityLogModule],
    providers: [
        AppLicenseService,
        { provide: APP_LICENSE_SERVICE, useExisting: AppLicenseService },
        { provide: APP_UPSTREAM_LICENSE_SERVICE, useExisting: AppLicenseService },
    ],
    exports: [AppLicenseService, APP_LICENSE_SERVICE, APP_UPSTREAM_LICENSE_SERVICE],
})
export class AppLicenseModule {}
