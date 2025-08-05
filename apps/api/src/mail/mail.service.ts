import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { config } from '../config/constants';
import { MailerService } from './mailer.service';
import {
    UserAccountDeletionEvent,
    UserForgotPasswordEvent,
    UserNewDeviceLoginEvent,
    UserPasswordChangedEvent,
    UserCreatedEvent,
    UserConfirmedEvent,
} from '../events';

@Injectable()
export class MailService {
    constructor(private readonly mailerService: MailerService) {}

    /**
     * Send signup confirmation email
     */
    @OnEvent(UserCreatedEvent.EVENT_NAME)
    async sendSignupConfirmation(data: UserCreatedEvent): Promise<void> {
        await this.mailerService.sendMail({
            to: data.user.email,
            subject: 'Confirm your Ever Works account',
            template: 'signup-confirmation',
            context: {
                firstName: data.user.username,
                confirmationUrl: data.confirmationUrl,
                confirmationToken: data.confirmationToken,
            },
        });
    }

    /**
     * Send forgot password email
     */
    @OnEvent(UserForgotPasswordEvent.EVENT_NAME)
    async sendForgotPassword(data: UserForgotPasswordEvent): Promise<void> {
        const resetUrl = data.resetUrl;

        await this.mailerService.sendMail({
            to: data.user.email,
            subject: 'Reset your Ever Works password',
            template: 'forgot-password',
            context: {
                firstName: data.user.username,
                resetUrl,
                resetToken: data.resetToken,
                expiresIn: data.expiresIn || '1 hour',
            },
        });
    }

    /**
     * Send password changed confirmation email
     */
    @OnEvent(UserPasswordChangedEvent.EVENT_NAME)
    async sendPasswordChanged(data: UserPasswordChangedEvent): Promise<void> {
        const secureAccountUrl = data.secureAccountUrl;

        await this.mailerService.sendMail({
            to: data.user.email,
            subject: 'Your Ever Works password has been changed',
            template: 'password-changed',
            context: {
                firstName: data.user.username,
                changedAt: this.formatDateTime(data.changedAt),
                ipAddress: data.ipAddress,
                location: data.location,
                device: data.device,
                browser: data.browser,
                secureAccountUrl,
            },
        });
    }

    /**
     * Send welcome email after account confirmation
     */
    @OnEvent(UserConfirmedEvent.EVENT_NAME)
    async sendWelcomeEmail(data: UserConfirmedEvent): Promise<void> {
        const dashboardUrl = data.dashboardUrl;

        await this.mailerService.sendMail({
            to: data.user.email,
            subject: 'Welcome to Ever Works!',
            template: 'welcome',
            context: {
                firstName: data.user.username,
                dashboardUrl,
            },
        });
    }

    /**
     * Send new device login alert
     */
    @OnEvent(UserNewDeviceLoginEvent.EVENT_NAME)
    async sendNewDeviceAlert(data: UserNewDeviceLoginEvent): Promise<void> {
        const verifyUrl = data.verifyUrl;
        const secureAccountUrl = data.secureAccountUrl;

        await this.mailerService.sendMail({
            to: data.user.email,
            subject: 'New login to your Ever Works account',
            template: 'new-device-login',
            context: {
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
    }

    /**
     * Send account deletion confirmation email
     */
    @OnEvent(UserAccountDeletionEvent.EVENT_NAME)
    async sendAccountDeletionConfirmation(data: UserAccountDeletionEvent): Promise<void> {
        const deleteUrl = data.deleteUrl;
        const keepAccountUrl = data.keepAccountUrl;

        await this.mailerService.sendMail({
            to: data.user.email,
            subject: 'Confirm account deletion',
            template: 'account-deletion',
            context: {
                firstName: data.user.username,
                deleteUrl,
                deleteToken: data.deleteToken,
                keepAccountUrl,
                expiresIn: data.expiresIn || '24 hours',
            },
        });
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
