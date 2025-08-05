import { Injectable, Logger } from '@nestjs/common';
import { MailerService as SmtpMailerService } from '@nestjs-modules/mailer';
import { FakerMailerService } from './providers/faker-mailer.service';
import { config } from '@src/config/constants';
import { SendMailOptions } from './types';

@Injectable()
export class MailerService {
    private readonly logger = new Logger(MailerService.name);

    constructor(
        private readonly smtpMailerService: SmtpMailerService,
        private readonly fakerMailerService: FakerMailerService,
    ) {
        this.logger.log(`Mailer service initialized with provider: ${config.mail.provider()}`);
    }

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
