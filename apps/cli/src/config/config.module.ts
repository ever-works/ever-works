import { Module, Global, OnModuleInit } from '@nestjs/common';
import { ConfigService } from './config.service';
import { Logger } from '@nestjs/common';

@Global()
@Module({
    providers: [ConfigService],
    exports: [ConfigService],
})
export class ConfigModule implements OnModuleInit {
    private readonly logger = new Logger(ConfigModule.name);

    constructor(private readonly configService: ConfigService) {}

    async onModuleInit() {
        try {
            // Auto-load configuration into process.env when module initializes
            await this.configService.loadConfigIntoEnv();
            this.logger.log('Configuration auto-loaded into environment variables');
        } catch (error) {
            this.logger.warn(`Failed to auto-load configuration: ${error.message}`);
            this.logger.warn('Some features may not work without proper configuration');
        }
    }
}
