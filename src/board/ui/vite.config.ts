// Build of the web board UI (ADR-0001 §31): Vue SFCs into dist/board (index.html + assets/*.js|css|svg). Every asset is a file,
// never inlined (CSP default-src 'self' blocks data: URLs and inline styles).
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  base: '/',
  plugins: [vue()],
  build: {
    outDir: path.resolve(here, '../../../dist/board'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    target: 'es2022',
    reportCompressedSize: false,
  },
});
