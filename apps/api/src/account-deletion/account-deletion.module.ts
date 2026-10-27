import { Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { User } from '@ever-works/agent/entities';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { config } from '../config/constants';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionMailer } from './account-deletion.mailer';
import {
    AccountDeletionRequestStore,
    TypeormAccountDeletionRequestStore,
} from './account-deletion-request.store';
import {
    AccountDeletionTokenService,
    DELETION_LINK_URLS,
    DELETION_SCHEDULER,
    DeletionLinkRecipient,
    DeletionLinkSender,
    DeletionLinkUrls,
    DeletionRecipientLookup,
    DeletionScheduler,
} from './account-deletion-token.service';
import { AccountDeletionService } from './account-deletion.service';

/** Where the emailed link and "Keep my account" point, and which caller hosts may be used. */
export function resolveDeletionLinkUrls(env: NodeJS.ProcessEnv = process.env): DeletionLinkUrls {
    const web = config.webAppUrl().replace(/\/+$/, '');
    const hosts = new Set<string>();
    try {
        hosts.add(new URL(web).host.toLowerCase());
    } catch {
        // WEB_URL is validated at boot.
    }
    for (const raw of (env.ALLOWED_CALLBACK_HOSTS ?? '').split(',')) {
        const host = raw.trim().toLowerCase();
        if (host) hosts.add(host);
    }
    return {
        defaultConfirmUrl: env.ACCOUNT_DELETION_CONFIRM_URL?.trim() || `${web}/delete-account/confirm`,
        keepAccountUrl: `${web}/login`,
        allowedCallbackHosts: hosts,
    };
}

/** Run after the HTTP answer is on its way; errors are handled by the task itself. */
const afterResponse: DeletionScheduler = (task) => {
    setImmediate(() => {
        void task();
    });
};

/**
 * Self-serve account deletion: the public email-link flow and the signed-in
 * delete (Settings → Danger Zone). See `AccountDeletionController`.
 */
@Module({
    imports: [DatabaseModule, AuthModule, MailModule],
    controllers: [AccountDeletionController],
    providers: [
        { provide: AccountDeletionRequestStore, useClass: TypeormAccountDeletionRequestStore },
        AccountDeletionMailer,
        {
            provide: DeletionLinkSender,
            useFactory: (mailer: AccountDeletionMailer): DeletionLinkSender => ({
                send: (input) => mailer.sendDeletionLink(input),
            }),
            inject: [AccountDeletionMailer],
        },
        {
            provide: DeletionRecipientLookup,
            useFactory: (dataSource: DataSource): DeletionRecipientLookup => ({
                async findByEmail(normalisedEmail: string): Promise<DeletionLinkRecipient | null> {
                    // Case-insensitive: addresses were stored as typed at sign-up.
                    const user = await dataSource
                        .getRepository(User)
                        .createQueryBuilder('user')
                        .select(['user.id', 'user.email', 'user.username', 'user.isAnonymous'])
                        .where('LOWER(user.email) = :email', { email: normalisedEmail })
                        .getOne();
                    if (!user || !user.email || user.isAnonymous) return null;
                    return { id: user.id, email: user.email, username: user.username ?? null };
                },
            }),
            inject: [getDataSourceToken()],
        },
        { provide: DELETION_LINK_URLS, useFactory: () => resolveDeletionLinkUrls() },
        { provide: DELETION_SCHEDULER, useValue: afterResponse },
        AccountDeletionTokenService,
        AccountDeletionService,
    ],
    exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
