import path from 'node:path';
import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';

// Providers
import { FakerMailerService } from './providers/faker-mailer.service';
import { config } from '@src/config/constants';
import { MailerService } from './mailer.service';

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

    providers: [MailService, MailerService, FakerMailerService],
})
export class MailModule {}
