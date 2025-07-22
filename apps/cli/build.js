const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const AUTHOR = 'Ever Co. LTD <evereq@gmail.com>';

async function buildCLI() {
    const buildDir = path.join(__dirname, 'dist');
    const packageJsonPath = path.join(__dirname, 'package.json');

    // Clean build directories
    await fs.remove(buildDir);
    await fs.ensureDir(buildDir);

    console.log('Building cli-shared package...');

    // First, ensure the cli-shared package is built
    try {
        execSync('pnpm --filter "@packages/cli-shared" build', {
            cwd: path.resolve(__dirname, '../..'),
            stdio: 'inherit',
        });
    } catch (error) {
        console.error('CLI shared package build failed:', error.message);
        throw error;
    }

    console.log('Bundling with esbuild...');

    // Bundle the compiled JavaScript
    await esbuild.build({
        entryPoints: ['src/main.ts'],
        bundle: true,
        platform: 'node',
        target: 'node18',
        outfile: 'dist/cli.js',
        banner: {
            js: '#!/usr/bin/env node\nprocess.env.NODE_ENV = process.env.NODE_ENV || "production";',
        },
        // External dependencies that should not be bundled
        external: [
            // Core dependencies that users need to install
            'commander',
            'axios',
            'inquirer',
            'chalk',
            'ora',
            'fs-extra',
            'dotenv',

            // Node.js built-ins
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
        minify: true,
        sourcemap: false,
        metafile: true,
        keepNames: true,
    });

    // Read the current package.json
    const currentPackageJson = await fs.readJson(packageJsonPath);

    // Create publishable package.json
    const publishablePackageJson = {
        name: 'ever-works-cli',
        version: currentPackageJson.version,
        description: 'Ever Works CLI - Open Directory Builder Platform Command Line Interface',
        author: AUTHOR,
        license: 'MIT',
        homepage: 'https://ever.works',
        repository: {
            type: 'git',
            url: 'https://github.com/ever-works/ever-works.git',
            directory: 'apps/cli',
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
            'api-client',
        ],
        bin: {
            'ever-works': './cli.js',
        },
        main: './cli.js',
        files: ['cli.js', 'README.md', 'LICENSE'],
        engines: {
            node: '>=18.0.0',
        },
        // Runtime dependencies
        dependencies: {
            commander: '^14.0.0',
            axios: '^1.10.0',
            inquirer: '^12.7.0',
            chalk: '^4.1.2',
            ora: '^5.4.1',
            'fs-extra': '^11.3.0',
            dotenv: '^17.2.0',
        },
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
    } else {
        // Create a basic MIT license
        const mitLicense = `MIT License

Copyright (c) ${new Date().getFullYear()} ${AUTHOR}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
        await fs.writeFile(path.join(buildDir, 'LICENSE'), mitLicense);
    }

    console.log('CLI build completed successfully!');
    console.log(`Output directory: ${buildDir}`);
}

buildCLI().catch((error) => {
    console.error('❌ Build failed:', error);
    process.exit(1);
});
