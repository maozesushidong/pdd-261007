import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: process.env.PUBLIC_WEB_BASE || '/public/',
  plugins: [react()],
  build: {
    outDir: process.env.PUBLIC_WEB_OUT_DIR || 'dist-public',
    emptyOutDir: true,
    rollupOptions: { input: path.join(root, 'public.html') },
  },
});
