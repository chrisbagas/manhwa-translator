import { defineConfig } from 'vitest/config';
export default defineConfig({ define: { __TARGET__: '"chrome"' }, test: { include: ['test/unit/**/*.test.ts'], environment: 'jsdom' } });
