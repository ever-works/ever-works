import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

@Injectable()
export class DatabaseInitService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseInitService.name);

    constructor(@InjectDataSource() private dataSource: DataSource) {}

    async onModuleInit() {
        try {
            // Ensure database connection is established
            if (!this.dataSource.isInitialized) {
                await this.dataSource.initialize();
                this.logger.debug('Database connection initialized');
            }

            // Force synchronization for CLI to ensure tables exist
            if (process.env.APP_TYPE === 'cli') {
                await this.dataSource.synchronize();
                this.logger.debug('Database schema synchronized');
            }
        } catch (error) {
            this.logger.error('Failed to initialize database', error);
            throw error;
        }
    }
}
