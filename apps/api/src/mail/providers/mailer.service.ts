import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import Handlebars from 'handlebars';
import { Resend } from 'resend';
import { MailerService as SmtpMailerService } from '@nestjs-modules/mailer';
import { FakerMailerService } from './faker-mailer.service';
import { config } from '@src/config/constants';
import { SendMailOptions } from '../types';
import type { Address } from '@nestjs-modules/mailer/dist/interfaces/send-mail-options.interface';

@Injectable()
export class MailerService {
    private readonly logger = new Logger(MailerService.name);

    constructor(
        private readonly smtpMailerService: SmtpMailerService,
        private readonly fakerMailerService: FakerMailerService,
        @Optional() @Inject('RESEND_CLIENT') private readonly resend?: Resend,
    ) {
        this.logger.log(`Mailer service initialized with provider: ${config.mail.provider()}`);
    }

    async sendMail(data: SendMailOptions): Promise<void> {
        switch (config.mail.provider()) {
            case 'smtp':
                await this.smtpMailerService.sendMail(data);
                break;

            case 'resend': {
                if (this.resend) {
                    await this.resend.emails.send({
                        to: this.getDestination(data.to),
                        from: config.mail.resend.emailFrom(),
                        subject: data.subject,
                        html: await this.readHtmlTemplate(data),
                    });
                    break;
                }
            }

            default:
                await this.fakerMailerService.sendMail(data);
                break;
        }
    }

    private getDestination(destination: string | Address | (string | Address)[]) {
        const dest = Array.isArray(destination) ? destination : [destination];
        return dest.map((to) => (typeof to === 'string' ? to : 'address' in to ? to.address : to));
    }

    private async readHtmlTemplate(data: SendMailOptions) {
        if (data.template) {
            const content = await fs.readFile(
                path.join(process.cwd(), 'src/templates', `${data.template}.hbs`),
                { encoding: 'utf8' },
            );

            const template = Handlebars.compile(content);
            const result = template(data.context || {});

            return result;
        }

        if (data.html) {
            return data.html instanceof Buffer ? data.html.toString() : (data.html as string);
        } else if (data.text) {
            return data.text instanceof Buffer ? data.text.toString() : (data.text as string);
        }

        return '';
    }
}
