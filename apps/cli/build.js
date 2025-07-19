const esbuild = require('esbuild');

esbuild
	.build({
		entryPoints: ['src/main.ts'],
		bundle: true,
		platform: 'node',
		target: 'node16',
		outfile: 'dist/cli.js',
		banner: {
			js: '#!/usr/bin/env node'
		},
		external: [
			// Core dependencies
			'commander',
			'axios',
			'inquirer',
			'chalk',
			'ora',
			'fs-extra',
			'dotenv',
			// Native modules that can't be bundled
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
			'readline'
		],
		// Ensure production build
		define: {
			'process.env.NODE_ENV': '"production"'
		},
		minify: true, // Keep readable for debugging
		sourcemap: false
	})
	.catch(() => process.exit(1));
