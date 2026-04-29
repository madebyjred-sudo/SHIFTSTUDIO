import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          // B2B Widget Configuration: Force Vite to build a single file without code-splitting
          // This allows external clients (Garnier) to inject the widget with a single <script> tag
          manualChunks: undefined,
          entryFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name].[ext]',
        },
      },
      // Prevent Vite from creating a separate CSS file, injects it into the JS (Crucial for widgets)
      cssCodeSplit: false,
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâ€"file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/graph': {
          target: process.env.SWARM_API_URL || 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
        },
        '/swarm': {
          target: process.env.SWARM_API_URL || 'http://localhost:8000',
          changeOrigin: true,
          secure: false,
          timeout: 300000, // 5 min for debate calls
        },
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
