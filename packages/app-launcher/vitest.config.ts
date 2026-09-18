import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'happy-dom',
		testTimeout: 10000,
		include: ['src/**/*.{test,spec}.ts'],
		exclude: ['node_modules/**', 'dist/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.{test,spec}.ts', 'src/index.ts', 'src/types.ts', 'src/strings.ts'],
			// T11's Done-when: "both specs pass with 100% branch coverage of the
			// two modules". Enforced here so the claim is mechanical, not prose.
			thresholds: {
				'src/grid-navigation.ts': {
					branches: 100,
					functions: 100,
					lines: 100,
					statements: 100
				},
				'src/safe-url.ts': {
					branches: 100,
					functions: 100,
					lines: 100,
					statements: 100
				}
			}
		}
	}
});
