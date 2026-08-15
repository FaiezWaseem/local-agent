import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {defineConfig} from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(rootDir, 'src/background.ts'),
        content: resolve(rootDir, 'src/content.ts'),
        'deepseek-stream': resolve(rootDir, 'src/deepseek-stream.ts'),
        'zai-stream': resolve(rootDir, 'src/zai-stream.ts'),
        popup: resolve(rootDir, 'popup.html')
      },
      output: {
        entryFileNames: '[name].js'
      }
    }
  },
  plugins: [{
    name: 'manifest',
    closeBundle() {
      fs.copyFileSync(
        resolve(rootDir, 'manifest.json'),
        resolve(rootDir, 'dist/manifest.json')
      );
    }
  }]
});
