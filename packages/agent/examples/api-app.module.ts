// @ts-nocheck
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule, DatabaseConfigurations } from '@packages/agent';

/**
 * Example API App Module
 *
 * This shows how to configure the database for an API application.
 * API apps can use either in-memory or persistent SQLite depending on the environment.
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

        // Option 2: Use predefined configurations (RECOMMENDED)
        // Development
        DatabaseConfigurations.apiDevelopment(),

        // Production
        // DatabaseConfigurations.apiProduction('/var/lib/ever-works/api.db'),

        // Your other modules here
    ],
})
export class ApiAppModule {}

/**
 * Environment Variables for API:
 *
 * Development:
 * APP_TYPE=api
 * NODE_ENV=development
 * DATABASE_IN_MEMORY=true (default)
 * DATABASE_LOGGING=true
 *
 * Production:
 * APP_TYPE=api
 * NODE_ENV=production
 * DATABASE_IN_MEMORY=false
 * DATABASE_PATH=/var/lib/ever-works/api.db
 * DATABASE_LOGGING=false
 *
 * Test:
 * NODE_ENV=test
 * (automatically uses in-memory database)
 */
