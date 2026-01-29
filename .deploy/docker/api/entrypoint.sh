#!/bin/sh
set -e

echo "==> Starting Ever Works API..."

# Run migrations if enabled
if [ "$RUN_MIGRATIONS" = "true" ]; then
    echo "==> Running database migrations..."

    # Wait for database to be ready (if using PostgreSQL/MySQL)
    if [ "$DATABASE_TYPE" = "postgres" ] || [ "$DATABASE_TYPE" = "mysql" ]; then
        echo "==> Waiting for database to be ready..."
        sleep 5
    fi

    # Run migrations using compiled TypeORM config
    node -e "
        require('reflect-metadata');
        const { DataSource } = require('typeorm');
        const { databaseConfig } = require('@packages/agent/database');

        const config = databaseConfig();
        const dataSource = new DataSource({
            ...config,
            migrations: [__dirname + '/dist/migrations/*.js'],
            migrationsTableName: 'migrations',
        });

        dataSource.initialize()
            .then(async () => {
                console.log('==> Running pending migrations...');
                const migrations = await dataSource.runMigrations();
                console.log('==> Migrations completed:', migrations.length, 'migration(s) executed');
                await dataSource.destroy();
                process.exit(0);
            })
            .catch((err) => {
                console.error('==> Migration failed:', err);
                process.exit(1);
            });
    "

    echo "==> Migrations completed successfully"
fi

echo "==> Starting API server..."
exec node /app/dist/main
