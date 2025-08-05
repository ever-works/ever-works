import { Injectable } from '@nestjs/common';
import { MailerService as SmtpMailerService } from '@nestjs-modules/mailer';
import { FakerMailerService } from './providers/faker-mailer.service';
import { config } from '@src/config/constants';
import { SendMailOptions } from './types';

@Injectable()
export class MailerService {
    constructor(
        private readonly smtpMailerService: SmtpMailerService,
        private readonly fakerMailerService: FakerMailerService,
    ) {}

    async sendMail(data: SendMailOptions): Promise<void> {
        switch (config.mail.provider()) {
            case 'smtp':
                await this.smtpMailerService.sendMail(data);
                break;

            default:
                await this.fakerMailerService.sendMail(data);
                break;
        }
    }
}
