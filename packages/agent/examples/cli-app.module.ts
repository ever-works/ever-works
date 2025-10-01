// @ts-nocheck
// @ts-nocheck
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule, DatabaseConfigurations } from '@packages/agent';

/**
 * Example CLI App Module
 *
 * This shows how to configure the database for a CLI application.
 * CLI apps typically use persistent SQLite files stored in the user's home directory.
 */
@Module({
    imports: [
        // Global configuration
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: ['.env.local', '.env'],
        }),

        // Option 1: Use the default DatabaseModule (uses environment variables)
        // DatabaseModule,

        // Option 2: Use the factory configuration (RECOMMENDED)
        DatabaseConfigurations.cli(),

        // Your other modules here
    ],
})
export class CliAppModule {}

/**
 * To use this configuration, you can also set environment variables:
 *
 * APP_TYPE=cli
 *
 * Optional overrides:
 * DATABASE_PATH=/custom/path/to/database.db
 * DATABASE_LOGGING=true
 */

/**
 * To use this configuration, set the following environment variables:
 *
 * APP_TYPE=cli
 *
 * Optional overrides:
 * DATABASE_PATH=/custom/path/to/database.db
 * DATABASE_LOGGING=true
 */
