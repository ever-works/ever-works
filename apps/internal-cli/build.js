const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const AUTHOR = 'Ever Co. LTD <evereq@gmail.com>';
const FRAMEWORK_EXTERNALS = [
    '@nestjs/cache-manager',
    '@nestjs/common',
    '@nestjs/config',
    '@nestjs/core',
    '@nestjs/event-emitter',
    '@nestjs/microservices',
    '@nestjs/platform-express',
    '@nestjs/typeorm',
    '@nestjs/websockets',
    'cache-manager',
    'class-transformer',
    'class-validator',
    'rxjs',
    'typeorm',
];

async function buildCLI() {
    const buildDir = path.join(__dirname, 'dist');
    const tempDir = path.join(__dirname, 'temp-build');
    const packageJsonPath = path.join(__dirname, 'package.json');

    // Clean build directories
    await fs.remove(buildDir);
    await fs.remove(tempDir);
    await fs.ensureDir(buildDir);
    await fs.ensureDir(tempDir);

    console.log('Building agent package...');

    // First, ensure the agent package is built
    try {
        execSync('pnpm --filter "@ever-works/agent" build', {
            cwd: path.resolve(__dirname, '../..'),
            stdio: 'inherit',
        });
    } catch (error) {
        console.error('Agent package build failed:', error.message);
        throw error;
    }

    console.log('Compiling CLI TypeScript with decorators...');

    // Then, compile CLI TypeScript with proper decorator support
    try {
        execSync(
            'npx tsc --project tsconfig.json --outDir temp-build --emitDecoratorMetadata true --experimentalDecorators true --target ES2020 --module Node16 --moduleResolution Node16 --esModuleInterop true --allowSyntheticDefaultImports true --skipLibCheck true',
            {
                cwd: __dirname,
                stdio: 'inherit',
            },
        );
    } catch (error) {
        console.error('TypeScript compilation failed:', error.message);
        throw error;
    }

    console.log('Bundling with esbuild...');

    // Then bundle the compiled JavaScript
    await esbuild.build({
        entryPoints: ['temp-build/main.js'],
        bundle: true,
        platform: 'node',
        target: 'node20',
        outfile: 'dist/cli.js',
        banner: {
            js: '#!/usr/bin/env node\nprocess.env.NODE_ENV = process.env.NODE_ENV || "production";\nrequire("reflect-metadata");\nrequire("process").removeAllListeners("warning")',
        },
        // External dependencies that should not be bundled
        external: [
            // Native modules that can't be bundled
            'better-sqlite3',
            'libsodium-wrappers',

            // Runtime framework packages are kept external to avoid
            // bundling Nest/TypeORM internals into the single-file CLI.
            ...FRAMEWORK_EXTERNALS,

            // Required for TypeORM decorators
            'reflect-metadata',

            // Optional NestJS modules
            '@nestjs/microservices',
            '@nestjs/websockets/socket-module',

            // class-transformer optional storage (used by @nestjs/mapped-types)
            'class-transformer/storage',

            // Build Dependencies
            'fs-extra',

            // Node.js built-ins (esbuild handles these automatically, but being explicit)
            'fs',
            'path',
            'os',
            'crypto',
            'http',
            'https',
            'url',
            'util',
            'stream',
            'events',
            'buffer',
            'child_process',
            'tty',
            'readline',
        ],
        format: 'cjs',
        // Preserve NestJS metadata and make runtime failures easier to inspect.
        minify: false,
        sourcemap: false,
        metafile: true,
        // Preserve decorator metadata for TypeORM
        keepNames: true,
        // Enable experimental decorators support
        tsconfigRaw: {
            compilerOptions: {
                experimentalDecorators: true,
                emitDecoratorMetadata: true,
                useDefineForClassFields: false,
            },
        },
    });

    // Read the current package.json
    const currentPackageJson = await fs.readJson(packageJsonPath);
    const agentPackageJson = await fs.readJson(path.join(__dirname, '../../packages/agent/package.json'));

    const publishableDependencies = {
        'better-sqlite3': '^11.10.0',
        'libsodium-wrappers': '^0.7.15',
        'reflect-metadata': '^0.2.2',
    };

    const dependencySources = [currentPackageJson.dependencies ?? {}, agentPackageJson.dependencies ?? {}];

    for (const dependency of FRAMEWORK_EXTERNALS) {
        const version = dependencySources.find((source) => source[dependency])?.[dependency];
        if (version) {
            publishableDependencies[dependency] = version;
        }
    }

    // Create publishable package.json
    const publishablePackageJson = {
        name: '@ever-works/cli',
        version: currentPackageJson.version,
        description: 'Ever Works CLI - Open Directory Builder Platform Command Line Interface',
        author: AUTHOR,
        license: 'UNLICENSED',
        homepage: 'https://ever.works',
        repository: {
            type: 'git',
            url: 'https://github.com/ever-works/ever-works.git',
            directory: 'apps/internal-cli',
        },
        bugs: {
            url: 'https://github.com/ever-works/ever-works/issues',
        },
        keywords: [
            'cli',
            'directory',
            'builder',
            'ever-works',
            'automation',
            'ai',
            'markdown',
            'website-generator',
        ],
        bin: {
            ew: './cli.js',
        },
        main: './cli.js',
        files: ['cli.js', 'README.md', 'LICENSE'],
        engines: {
            node: '>=20.0.0',
        },
        // Only include runtime dependencies that remain external to the bundle.
        dependencies: publishableDependencies,
        // Remove dev dependencies and workspace dependencies
        scripts: {
            postinstall:
                'echo "Ever Works CLI installed successfully! Run \'ew --help\' to get started."',
        },
    };

    // Write the publishable package.json
    await fs.writeJson(path.join(buildDir, 'package.json'), publishablePackageJson, { spaces: 2 });

    // Copy README if it exists
    const readmePath = path.join(__dirname, 'README.md');
    if (await fs.pathExists(readmePath)) {
        await fs.copy(readmePath, path.join(buildDir, 'README.md'));
    }

    // Copy LICENSE if it exists
    const licensePath = path.join(__dirname, '../../LICENSE');
    if (
        (await fs.pathExists(licensePath)) ||
        (await fs.pathExists(licensePath + '.md')) ||
        (await fs.pathExists(licensePath + '.txt'))
    ) {
        await fs.copy(licensePath, path.join(buildDir, 'LICENSE'));
    }

    // Clean up temporary directory
    await fs.remove(tempDir);

    console.log('CLI build completed successfully!');
    console.log(`Output directory: ${buildDir}`);
}

buildCLI().catch((error) => {
    console.error('❌ Build failed:', error);
    process.exit(1);
});
