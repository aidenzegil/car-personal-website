import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // Multi-page setup: `/` is the personal website (placeholder for now),
  // `/library.html` is the standalone asset library.
  build: {
    rollupOptions: {
      input: {
        main:    resolve(__dirname, 'index.html'),
        library: resolve(__dirname, 'library.html'),
      },
    },
  },
});
