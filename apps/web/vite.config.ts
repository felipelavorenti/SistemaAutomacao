import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      // Endereços públicos dos webhooks e formulários, iguais aos do n8n.
      '^/(webhook|webhook-test|webhook-waiting|form|form-test|form-waiting)/': 'http://localhost:3000',
    },
  },
});
