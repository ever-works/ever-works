import path from 'node:path';
import { Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { Resend } from 'resend';
import { MailService } from './mail.service';

// Providers
import { FakerMailerService } from './providers/faker-mailer.service';
import { config } from '@src/config/constants';
import { MailerService } from './providers/mailer.service';

@Module({
    imports: [
        MailerModule.forRootAsync({
            useFactory: () => ({
                transport: {
                    host: config.mail.smtpHost(),
                    port: config.mail.smtpPort(),
                    secure: config.mail.smtpSecure(),
                    ignoreTLS: config.mail.smtpIgnoreTLS(),
                    auth: {
                        user: config.mail.smtpUser(),
                        pass: config.mail.smtpPassword(),
                    },
                    tls: {
                        rejectUnauthorized: false,
                    },
                },
                defaults: {
                    from: config.mail.from(),
                },
                template: {
                    dir: path.join(process.cwd(), 'src/templates'),
                    adapter: new HandlebarsAdapter(undefined, { inlineCssEnabled: true }),
                    options: {
                        strict: true,
                    },
                },
            }),
        }),
    ],

    providers: [
        {
            provide: 'RESEND_CLIENT',
            useFactory: () => {
                const apiKey = config.mail.resend.apiKey();
                if (apiKey) {
                    return new Resend(apiKey || '');
                }
                return undefined;
            },
        },
        MailService,
        MailerService,
        FakerMailerService,
    ],
    // EW-602 follow-up: `BudgetAlertHandler` (in BudgetsModule) injects
    // `MailService` to send threshold-crossed emails. Without an
    // `exports` list, MailService is module-private and Nest fails at
    // boot with `Nest can't resolve dependencies of the
    // BudgetAlertHandler ... MailService at index [2] is available in
    // the BudgetsModule module`. Exporting both the public surface
    // (MailService) and the underlying transport wrapper (MailerService)
    // lets downstream modules consume them; internal providers
    // (RESEND_CLIENT, FakerMailerService) stay private as intended.
    exports: [MailService, MailerService],
})
export class MailModule {}
