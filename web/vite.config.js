import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const devPort = Number(env.VITE_PORT || env.PORT || 3000);
  const devHost = env.VITE_HOST || env.HOST || '0.0.0.0';
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || env.API_PROXY_TARGET || 'http://localhost:4000';
  const allowedHostsRaw = env.VITE_ALLOWED_HOSTS || env.ALLOWED_HOSTS || '';
  const allowedHosts = allowedHostsRaw.split(',').map(host => host.trim()).filter(Boolean);

  const previewPort = Number(env.VITE_PREVIEW_PORT || env.PREVIEW_PORT || 4173);

  return {
    root: __dirname,
    plugins: [react()],
    server: {
      host: devHost,
      port: devPort,
      allowedHosts: allowedHosts.length ? allowedHosts : true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: devHost,
      port: previewPort,
      allowedHosts: allowedHosts.length ? allowedHosts : true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    resolve: {
      alias: {
        child_process: fileURLToPath(new URL('./shims/child-process.js', import.meta.url)),
      },
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
  };
});
