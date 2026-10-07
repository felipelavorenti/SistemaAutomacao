import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Os testes de API e de gatilhos recriam o mesmo banco e limpam o mesmo Redis: um arquivo por vez.
    fileParallelism: false,
  },
});
