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
} from '../events';

@Injectable()
export class MailService {
    private readonly logger = new Logger(MailService.name);

    constructor(private readonly mailerService: MailerService) {}

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
            await this.mailerService.sendMail({
                to: data.user.email,
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

            await this.mailerService.sendMail({
                to: data.user.email,
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

            await this.mailerService.sendMail({
                to: data.user.email,
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

            await this.mailerService.sendMail({
                to: data.user.email,
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

            await this.mailerService.sendMail({
                to: data.user.email,
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

            await this.mailerService.sendMail({
                to: data.user.email,
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
