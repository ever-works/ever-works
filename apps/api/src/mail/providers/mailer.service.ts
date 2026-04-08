import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import Handlebars from 'handlebars';
import { Resend } from 'resend';
import { MailerService as SmtpMailerService } from '@nestjs-modules/mailer';
import { FakerMailerService } from './faker-mailer.service';
import { config } from '@src/config/constants';
import { Address, SendMailOptions } from '../types';

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
        const provider = config.mail.provider();
        const recipient = data.to ? this.getDestination(data.to).join(', ') : 'unknown';

        switch (provider) {
            case 'smtp':
                this.logger.log(`Sending email via SMTP to=${recipient} subject="${data.subject}"`);
                await this.smtpMailerService.sendMail(data);
                this.logger.log(`Email sent via SMTP to=${recipient}`);
                break;

            case 'resend': {
                if (!this.resend) {
                    this.logger.warn(
                        `Resend client not initialized (missing RESEND_APIKEY?), falling back to faker for to=${recipient}`,
                    );
                    await this.fakerMailerService.sendMail(data);
                    break;
                }

                const from = config.mail.resend.emailFrom();
                this.logger.log(
                    `Sending email via Resend to=${recipient} from="${from}" subject="${data.subject}"`,
                );
                const result = await this.resend.emails.send({
                    to: this.getDestination(data.to),
                    from,
                    subject: data.subject,
                    html: await this.readHtmlTemplate(data),
                });
                this.logger.log(
                    `Email sent via Resend to=${recipient} id=${result.data?.id ?? 'unknown'}`,
                );
                break;
            }

            default:
                this.logger.debug(`No mail provider configured, using faker for to=${recipient}`);
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
