import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vite multi-page setup for STATS 401 Labs.
//
// `base` MUST match the GitHub Pages project subpath. This repo is served
// from https://<user>.github.io/stats401-labs/, so all emitted asset URLs
// need the /stats401-labs/ prefix. Forgetting this makes assets 404.
//
// Each lab's index.html is listed explicitly so Vite emits one hashed JS
// bundle per entry and Rollup keeps a clean chunk graph.
export default defineConfig({
  base: '/stats401-labs/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:  resolve(__dirname, 'index.html'),
        lab1:  resolve(__dirname, 'lab1/index.html'),
        lab2:  resolve(__dirname, 'lab2/index.html'),
        lab3:  resolve(__dirname, 'lab3/index.html'),
        lab4:  resolve(__dirname, 'lab4/index.html'),
        lab5:  resolve(__dirname, 'lab5/index.html'),
        lab6:  resolve(__dirname, 'lab6/index.html'),
        lab7:  resolve(__dirname, 'lab7/index.html'),
        lab8:  resolve(__dirname, 'lab8/index.html'),
        lab9:  resolve(__dirname, 'lab9/index.html'),
        lab10: resolve(__dirname, 'lab10/index.html'),
      },
    },
  },
});