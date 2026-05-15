import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { config } from '../config/constants';
import { MailerService } from './providers/mailer.service';
import {
    UserAccountDeletionEvent,
    UserForgotPasswordEvent,
    UserNewDeviceLoginEvent,
    UserPasswordChangedEvent,
    UserCreatedEvent,
    UserConfirmedEvent,
    MemberInvitedEvent,
    WorkInvitationIssuedEvent,
} from '../events';

const OWNER_CLAIM_ROLE = 'owner-claim';

@Injectable()
export class MailService {
    private readonly logger = new Logger(MailService.name);

    constructor(private readonly mailerService: MailerService) {}

    /**
     * EW-617 G2: anonymous users have no email and must never receive
     * transactional mail. All mail handlers early-return when the recipient
     * has no email; in practice they shouldn't fire for anon users at all
     * (we don't emit UserCreated/UserConfirmed/etc. for them) but the guard
     * keeps the type-system honest and prevents accidental sends.
     */
    private requireEmail(email: string | null, context: string): string | null {
        if (!email) {
            this.logger.debug(`Skipping ${context}: recipient has no email (anonymous user?)`);
            return null;
        }
        return email;
    }

    /**
     * Get branding context for email templates
     */
    private getBrandingContext() {
        return {
            appName: config.branding.appName(),
            companyOwner: config.branding.companyOwner(),
            platformWebsite: config.branding.platformWebsite(),
            currentYear: new Date().getFullYear(),
        };
    }

    /**
     * Send signup confirmation email
     */
    @OnEvent(UserCreatedEvent.EVENT_NAME)
    async sendSignupConfirmation(data: UserCreatedEvent): Promise<void> {
        try {
            const appName = config.branding.appName();
            const recipient = this.requireEmail(data.user.email, 'mail to user');
            if (!recipient) {
                return;
            }
            await this.mailerService.sendMail({
                to: recipient,
                subject: `Confirm your ${appName} account`,
                template: 'signup-confirmation',
                context: {
                    ...this.getBrandingContext(),
                    firstName: data.user.username,
                    confirmationUrl: data.confirmationUrl,
                    confirmationToken: data.confirmationToken,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send signup confirmation to ${data.user.email}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Send forgot password email
     */
    @OnEvent(UserForgotPasswordEvent.EVENT_NAME)
    async sendForgotPassword(data: UserForgotPasswordEvent): Promise<void> {
        try {
            const resetUrl = data.resetUrl;
            const appName = config.branding.appName();

            const recipient = this.requireEmail(data.user.email, 'mail to user');
            if (!recipient) {
                return;
            }
            await this.mailerService.sendMail({
                to: recipient,
                subject: `Reset your ${appName} password`,
                template: 'forgot-password',
                context: {
                    ...this.getBrandingContext(),
                    firstName: data.user.username,
                    resetUrl,
                    resetToken: data.resetToken,
                    expiresIn: data.expiresIn || '1 hour',
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send forgot-password email to ${data.user.email}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Send password changed confirmation email
     */
    @OnEvent(UserPasswordChangedEvent.EVENT_NAME)
    async sendPasswordChanged(data: UserPasswordChangedEvent): Promise<void> {
        try {
            const secureAccountUrl = data.secureAccountUrl;
            const appName = config.branding.appName();

            const recipient = this.requireEmail(data.user.email, 'mail to user');
            if (!recipient) {
                return;
            }
            await this.mailerService.sendMail({
                to: recipient,
                subject: `Your ${appName} password has been changed`,
                template: 'password-changed',
                context: {
                    ...this.getBrandingContext(),
                    firstName: data.user.username,
                    changedAt: this.formatDateTime(data.changedAt),
                    ipAddress: data.ipAddress,
                    location: data.location,
                    device: data.device,
                    browser: data.browser,
                    secureAccountUrl,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send password-changed email to ${data.user.email}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Send welcome email after account confirmation
     */
    @OnEvent(UserConfirmedEvent.EVENT_NAME)
    async sendWelcomeEmail(data: UserConfirmedEvent): Promise<void> {
        try {
            const dashboardUrl = data.dashboardUrl || `${config.webAppUrl()}/works/new`;
            const appName = config.branding.appName();

            const recipient = this.requireEmail(data.user.email, 'mail to user');
            if (!recipient) {
                return;
            }
            await this.mailerService.sendMail({
                to: recipient,
                subject: `Welcome to ${appName}!`,
                template: 'welcome',
                context: {
                    ...this.getBrandingContext(),
                    firstName: data.user.username,
                    dashboardUrl,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send welcome email to ${data.user.email}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Send new device login alert
     */
    @OnEvent(UserNewDeviceLoginEvent.EVENT_NAME)
    async sendNewDeviceAlert(data: UserNewDeviceLoginEvent): Promise<void> {
        try {
            const verifyUrl = data.verifyUrl;
            const secureAccountUrl = data.secureAccountUrl;
            const appName = config.branding.appName();

            const recipient = this.requireEmail(data.user.email, 'mail to user');
            if (!recipient) {
                return;
            }
            await this.mailerService.sendMail({
                to: recipient,
                subject: `New login to your ${appName} account`,
                template: 'new-device-login',
                context: {
                    ...this.getBrandingContext(),
                    firstName: data.user.username,
                    loginTime: this.formatDateTime(data.loginTime),
                    device: data.device,
                    browser: data.browser,
                    location: data.location,
                    ipAddress: data.ipAddress,
                    verifyUrl,
                    verifyToken: data.verifyToken,
                    secureAccountUrl,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send new-device-login email to ${data.user.email}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Send account deletion confirmation email
     */
    @OnEvent(UserAccountDeletionEvent.EVENT_NAME)
    async sendAccountDeletionConfirmation(data: UserAccountDeletionEvent): Promise<void> {
        try {
            const deleteUrl = data.deleteUrl;
            const keepAccountUrl = data.keepAccountUrl;

            const recipient = this.requireEmail(data.user.email, 'mail to user');
            if (!recipient) {
                return;
            }
            await this.mailerService.sendMail({
                to: recipient,
                subject: 'Confirm account deletion',
                template: 'account-deletion',
                context: {
                    ...this.getBrandingContext(),
                    firstName: data.user.username,
                    deleteUrl,
                    deleteToken: data.deleteToken,
                    keepAccountUrl,
                    expiresIn: data.expiresIn || '24 hours',
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send account-deletion email to ${data.user.email}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Send member invitation email
     */
    @OnEvent(MemberInvitedEvent.EVENT_NAME)
    async sendMemberInvitation(data: MemberInvitedEvent): Promise<void> {
        try {
            const appName = config.branding.appName();

            await this.mailerService.sendMail({
                to: data.invitee.email,
                subject: `You've been invited to collaborate on ${data.work.name}`,
                template: 'member-invitation',
                context: {
                    ...this.getBrandingContext(),
                    inviteeName: data.invitee.username,
                    inviterName: data.inviter.username,
                    workName: data.work.name,
                    roleName: this.formatRoleName(data.role),
                    workUrl: data.workUrl,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send member-invitation email to ${data.invitee.email}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Send tokenised work-invitation email (EW-600 claim flow). Skipped
     * when no recipient email — operator copies the claim URL manually.
     */
    @OnEvent(WorkInvitationIssuedEvent.EVENT_NAME)
    async sendWorkInvitation(data: WorkInvitationIssuedEvent): Promise<void> {
        if (!data.recipientEmail) {
            return;
        }
        try {
            const isOwnerClaim = data.role === OWNER_CLAIM_ROLE;
            await this.mailerService.sendMail({
                to: data.recipientEmail,
                subject: isOwnerClaim
                    ? `Claim ownership of ${data.work.name}`
                    : `You've been invited to ${data.work.name}`,
                template: 'work-invitation-claim',
                context: {
                    ...this.getBrandingContext(),
                    workName: data.work.name,
                    inviterName: data.inviter.username,
                    roleName: this.formatRoleName(data.role),
                    claimUrl: data.claimUrl,
                    expiresAtFormatted: this.formatDateTime(data.expiresAt),
                    isOwnerClaim,
                    expectedProviderUsername: data.expectedProviderUsername,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send work-invitation email to ${data.recipientEmail}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * EW-602 — send a budget threshold alert email. Non-event entrypoint:
     * the BudgetAlertHandler in apps/api/src/budgets/ does the event
     * subscription and user resolution, then calls this with already-
     * normalised display values. Keeps MailService focused on sending.
     */
    async sendBudgetAlertEmail(
        toEmail: string,
        recipientName: string,
        context: {
            workName: string;
            scopeLabel: string;
            pluginId?: string | null;
            capability: string;
            threshold: '75' | '90' | '100' | 'overage';
            currentSpendCents: number;
            capCents: number;
            currency: string;
            periodLabel: string;
            settingsUrl: string;
        },
    ): Promise<void> {
        try {
            const recipient = this.requireEmail(toEmail, 'budget alert');
            if (!recipient) {
                return;
            }

            const appName = config.branding.appName();
            const percent = context.capCents > 0
                ? Math.min(150, Math.round((context.currentSpendCents / context.capCents) * 100))
                : 0;
            const isError = context.threshold === '100' || context.threshold === 'overage';
            const thresholdIcon = isError ? '⛔' : '⚠️';
            const titleByThreshold: Record<typeof context.threshold, string> = {
                '75': 'You are approaching your budget cap',
                '90': 'You are about to hit your budget cap',
                '100': 'Budget cap reached',
                overage: 'Budget overage in progress',
            };
            const subtitleByThreshold: Record<typeof context.threshold, string> = {
                '75': '75% of this period’s cap is now used.',
                '90': '90% of this period’s cap is now used.',
                '100': 'New plugin calls will be blocked until next period unless overage is enabled.',
                overage: 'Calls are continuing past the cap because overage is enabled.',
            };
            const actionGuidance = isError
                ? 'Raise the cap or toggle "Allow overage" in Budgets & Usage to continue.'
                : 'Raise the cap, or wait for next period to reset usage.';
            const progressColor = percent >= 100 ? '#ef4444' : percent >= 90 ? '#f59e0b' : '#3b82f6';
            const formatCents = (cents: number): string => {
                const dollars = cents / 100;
                return new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: context.currency.toUpperCase(),
                    maximumFractionDigits: 2,
                }).format(dollars);
            };

            const subject =
                context.threshold === '100' || context.threshold === 'overage'
                    ? `[${appName}] Budget cap reached for ${context.workName}`
                    : `[${appName}] Budget at ${context.threshold}% for ${context.workName}`;

            await this.mailerService.sendMail({
                to: recipient,
                subject,
                template: 'budget-alert',
                context: {
                    ...this.getBrandingContext(),
                    firstName: recipientName,
                    workName: context.workName,
                    scopeLabel: context.scopeLabel,
                    pluginId: context.pluginId,
                    capability: context.capability,
                    thresholdIcon,
                    thresholdTitle: titleByThreshold[context.threshold],
                    thresholdSubtitle: subtitleByThreshold[context.threshold],
                    spentLabel: formatCents(context.currentSpendCents),
                    capLabel: formatCents(context.capCents),
                    percentLabel: `${percent}%`,
                    progressWidth: `${Math.min(100, percent)}%`,
                    progressColor,
                    periodLabel: context.periodLabel,
                    actionGuidance,
                    settingsUrl: context.settingsUrl,
                },
            });
        } catch (error) {
            this.logger.error(
                `Failed to send budget-alert email to ${toEmail}`,
                error?.stack ?? error,
            );
        }
    }

    /**
     * Helper method to format role name for display
     */
    private formatRoleName(role: string): string {
        return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
    }

    /**
     * Helper method to format date/time consistently
     */
    private formatDateTime(date: Date): string {
        return new Intl.DateTimeFormat('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short',
        }).format(date);
    }
}
