import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

if (!process.env.ROLLUP_SKIP_NODE_NATIVE) {
  process.env.ROLLUP_SKIP_NODE_NATIVE = 'true';
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1'
  },
  envPrefix: ['VITE_', 'TAURI_'],
  clearScreen: false
});
