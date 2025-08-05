import { Injectable, Logger } from '@nestjs/common';
import { SendMailOptions } from '../types';

@Injectable()
export class FakerMailerService {
    private readonly logger = new Logger(FakerMailerService.name);

    async sendMail(data: SendMailOptions): Promise<void> {
        this.logger.debug('FakerMailerService:sendMail', data);
    }
}
