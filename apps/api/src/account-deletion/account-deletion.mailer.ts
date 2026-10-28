import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config/constants';
import { MailerService } from '../mail/providers/mailer.service';
import type { AccountDeletionSummary } from '@ever-works/agent/entities';

/**
 * The two emails of self-serve account deletion. Every send passes
 * `redactRecipient`, so the mail log carries a hash handle, never the
 * address; and nothing here ever logs the link (it holds the raw token).
 */
@Injectable()
export class AccountDeletionMailer {
    private readonly logger = new Logger(AccountDeletionMailer.name);

    constructor(private readonly mailer: MailerService) {}

    /** The link email. Throws when the send fails, so the caller can retire the token. */
    async sendDeletionLink(input: {
        to: string;
        firstName: string | null;
        deleteUrl: string;
        keepAccountUrl: string;
        expiresInMinutes: number;
    }): Promise<void> {
        await this.mailer.sendMail(
            {
                to: input.to,
                subject: `Confirm the deletion of your ${config.branding.appName()} account`,
                template: 'account-deletion',
                context: {
                    ...this.branding(),
                    firstName: input.firstName,
                    deleteUrl: input.deleteUrl,
                    keepAccountUrl: input.keepAccountUrl,
                    expiresIn: `${input.expiresInMinutes} minutes`,
                },
            },
            { strict: true, redactRecipient: true },
        );
    }

    /** "Your account was deleted". Best-effort: the deletion already happened. */
    async sendDeletedConfirmation(input: {
        to: string;
        deletedAt: Date;
        summary: AccountDeletionSummary;
    }): Promise<boolean> {
        try {
            await this.mailer.sendMail(
                {
                    to: input.to,
                    subject: `Your ${config.branding.appName()} account was deleted`,
                    template: 'account-deleted',
                    context: {
                        ...this.branding(),
                        deletedAt: input.deletedAt.toUTCString(),
                        workspaceDeleted: input.summary.workspaceDeleted === true,
                        workspaceTransferred: input.summary.workspaceTransferred === true,
                        worksDeleted: input.summary.worksDeleted ?? 0,
                        membershipsRemoved: input.summary.membershipsRemoved ?? 0,
                        subscriptionsCanceled: input.summary.subscriptionsCanceled ?? 0,
                    },
                },
                { redactRecipient: true },
            );
            return true;
        } catch (error) {
            this.logger.warn(
                `account-deletion: the "account deleted" email could not be sent (${
                    error instanceof Error ? error.name : 'error'
                })`,
            );
            return false;
        }
    }

    private branding() {
        return {
            appName: config.branding.appName(),
            companyOwner: config.branding.companyOwner(),
            platformWebsite: config.branding.platformWebsite(),
            currentYear: new Date().getFullYear(),
        };
    }
}
