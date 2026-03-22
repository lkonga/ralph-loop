import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		pool: 'threads',
		poolOptions: {
			threads: {
				maxThreads: 4,
			},
		},
	},
	resolve: {
		alias: {
			vscode: new URL('./__mocks__/vscode.ts', import.meta.url).pathname,
		},
	},
});
