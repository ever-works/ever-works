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
			'commander',
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
			'child_process'
		]
	})
	.catch(() => process.exit(1));
