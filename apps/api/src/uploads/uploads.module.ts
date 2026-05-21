import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
    // EW-637 — AuthModule exports AnonymousAuthService, which the
    // /api/uploads/anonymous and /api/uploads/presign endpoints use to
    // inline-mint an anon user when the request arrives without a
    // bearer.
    imports: [AuthModule],
    controllers: [UploadsController],
    providers: [UploadsService],
    exports: [UploadsService],
})
export class UploadsModule {}
