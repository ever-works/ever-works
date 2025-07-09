// @ts-nocheck
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule, DatabaseConfigurations } from '@packages/agent';

/**
 * Example PostgreSQL App Module
 *
 * This shows how to configure the database for PostgreSQL in production.
 */
@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Option 1: Use environment variables with DatabaseModule
    // DatabaseModule,

    // Option 2: Use the configuration factory (RECOMMENDED)
    DatabaseConfigurations.postgres({
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      databaseName: process.env.DATABASE_NAME || 'ever_works',
      logging: process.env.NODE_ENV === 'development',
    }),

    // Your other modules here
  ],
})
export class PostgresAppModule {}

/**
 * Environment Variables for PostgreSQL:
 * 
 * DATABASE_TYPE=postgres
 * DATABASE_HOST=localhost
 * DATABASE_PORT=5432
 * DATABASE_USERNAME=postgres
 * DATABASE_PASSWORD=your_password
 * DATABASE_NAME=ever_works
 * DATABASE_LOGGING=false
 * 
 * Example Docker Compose for PostgreSQL:
 * 
 * version: '3.8'
 * services:
 *   postgres:
 *     image: postgres:15
 *     environment:
 *       POSTGRES_DB: ever_works
 *       POSTGRES_USER: postgres
 *       POSTGRES_PASSWORD: your_password
 *     ports:
 *       - "5432:5432"
 *     volumes:
 *       - postgres_data:/var/lib/postgresql/data
 * 
 * volumes:
 *   postgres_data:
 */
