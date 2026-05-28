import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '@src/auth';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';

/**
 * EW-650 / EW-669 — Email module wiring.
 *
 * Re-uses FacadesModule's EmailFacadeService for plugin orchestration
 * and DatabaseModule for the new email_* repositories.
 *
 * Mounted by the root api module alongside the existing MailModule
 * (v1 transactional email) and NotificationsModule. Both v1 surfaces
 * keep working unchanged — see notifications-v2 hard rule (additive).
 */
@Module({
    imports: [DatabaseModule, FacadesModule, AuthModule],
    controllers: [EmailController],
    providers: [EmailService],
    exports: [EmailService],
})
export class EmailModule {}
