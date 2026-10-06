import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // Es un paquete de politica: si una rama no esta cubierta, el tope que
      // protege la cuota del estudio no esta probado.
      thresholds: { lines: 100, functions: 100, branches: 95, statements: 100 },
    },
  },
});
