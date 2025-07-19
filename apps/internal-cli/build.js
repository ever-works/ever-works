const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const AUTHOR = 'Ever Co. LTD <evereq@gmail.com>';

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
        execSync('pnpm --filter "@packages/agent" build', {
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
        target: 'node18',
        outfile: 'dist/cli.js',
        banner: {
            js: '#!/usr/bin/env node\nprocess.env.NODE_ENV = process.env.NODE_ENV || "production";\nrequire("reflect-metadata");',
        },
        // External dependencies that should not be bundled
        external: [
            // Native modules that can't be bundled
            'better-sqlite3',
            'libsodium-wrappers',

            // Required for TypeORM decorators
            'reflect-metadata',

            // Optional NestJS modules
            '@nestjs/microservices',
            '@nestjs/websockets/socket-module',

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
        ],
        // Resolve workspace dependencies
        plugins: [
            {
                name: 'workspace-resolver',
                setup(build) {
                    // Resolve @packages/agent imports to their compiled files
                    build.onResolve({ filter: /^@packages\/agent/ }, (args) => {
                        const importPath = args.path;
                        if (importPath === '@packages/agent') {
                            return {
                                path: path.resolve(__dirname, '../../packages/agent/dist/index.js'),
                            };
                        }
                        // Handle subfolder imports like @packages/agent/database
                        const subfolder = importPath.replace('@packages/agent/', '');
                        return {
                            path: path.resolve(
                                __dirname,
                                `../../packages/agent/dist/${subfolder}/index.js`,
                            ),
                        };
                    });

                    // Resolve internal src/ imports within the agent package
                    build.onResolve({ filter: /^src\// }, (args) => {
                        // Check if this is being resolved from within the agent package
                        if (args.importer.includes('packages/agent/src')) {
                            const relativePath = args.path.replace(/^src\//, '');
                            const resolvedPath = path.resolve(
                                __dirname,
                                '../../packages/agent/src',
                                relativePath,
                            );

                            // Try with .ts extension first, then .js
                            const extensions = ['.ts', '.js', '/index.ts', '/index.js'];
                            for (const ext of extensions) {
                                const fullPath = resolvedPath + ext;
                                if (fs.existsSync(fullPath)) {
                                    return { path: fullPath };
                                }
                            }

                            // If no file found, return the original path and let esbuild handle it
                            return { path: resolvedPath + '.ts' };
                        }
                        return undefined;
                    });
                },
            },
        ],
        format: 'cjs',
        minify: true, // Keep readable for debugging
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

    // Create publishable package.json
    const publishablePackageJson = {
        name: '@ever-works/cli',
        version: currentPackageJson.version,
        description: 'Ever Works CLI - Open Directory Builder Platform Command Line Interface',
        author: AUTHOR,
        license: 'MIT',
        homepage: 'https://ever.works',
        repository: {
            type: 'git',
            url: 'https://github.com/ever-co/ever-works.git',
            directory: 'apps/cli',
        },
        bugs: {
            url: 'https://github.com/ever-co/ever-works/issues',
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
            'ever-works': './cli.js',
            ew: './cli.js',
        },
        main: './cli.js',
        files: ['cli.js', 'README.md', 'LICENSE'],
        engines: {
            node: '>=18.0.0',
        },
        // Only include runtime dependencies that are external
        dependencies: {
            'better-sqlite3': '^11.10.0',
            'libsodium-wrappers': '^0.7.15',
            'reflect-metadata': '^0.2.2',
        },
        // Remove dev dependencies and workspace dependencies
        scripts: {
            postinstall:
                'echo "Ever Works CLI installed successfully! Run \'ever-works --help\' to get started."',
        },
    };

    // Write the publishable package.json
    await fs.writeJson(path.join(buildDir, 'package.json'), publishablePackageJson, { spaces: 2 });

    // Copy README if it exists
    const readmePath = path.join(__dirname, 'README.md');
    if (await fs.pathExists(readmePath)) {
        await fs.copy(readmePath, path.join(buildDir, 'README.md'));
    }

    // Copy LICENSE if it exists, otherwise create MIT license
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
