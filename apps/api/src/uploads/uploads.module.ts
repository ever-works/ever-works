import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '../auth/auth.module';
import { UploadsController } from './uploads.controller';
import { UploadsService, WORK_REPO_RESOLVER } from './uploads.service';
import { WorkRepoResolverService } from './work-repo-resolver.service';

@Module({
    // EW-637 — AuthModule exports AnonymousAuthService, which the
    // /api/uploads/anonymous and /api/uploads/presign endpoints use to
    // inline-mint an anon user when the request arrives without a
    // bearer.
    //
    // EW-644 — WorkRepoResolverService depends on WorkRepository (from
    // DatabaseModule) and GitFacadeService (from FacadesModule) to map
    // a workId to the Work's data repo coordinates + a usable GitHub
    // token. It's wired into the storage-backend plugin context so
    // github-storage in `mode: 'data-repo'` can resolve per upload.
    // The resolver is bound to a Symbol token (`WORK_REPO_RESOLVER`) so
    // UploadsService can type-only-import the contract and avoid
    // pulling the agent package into the upload unit-test import graph.
    imports: [AuthModule, DatabaseModule, FacadesModule],
    controllers: [UploadsController],
    providers: [
        UploadsService,
        WorkRepoResolverService,
        { provide: WORK_REPO_RESOLVER, useExisting: WorkRepoResolverService },
    ],
    exports: [UploadsService],
})
export class UploadsModule {}
