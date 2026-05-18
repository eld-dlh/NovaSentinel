import { defineConfig } from 'vite';
import { resolve }      from 'path';

export default defineConfig({
  server: {
    proxy: {
      // All requests to /spacetrack/* are forwarded to space-track.org.
      // The browser only ever sees localhost — no CORS issue.
      '/spacetrack': {
        target:      'https://www.space-track.org',
        changeOrigin: true,                   // sets Host header to space-track.org
        secure:       true,                   // enforce HTTPS on the target
        rewrite:      path => path.replace(/^\/spacetrack/, ''),
      },
    },
  },

  // satellite.js v7 ships a WASM/pthreads build with top-level await.
  // Workers must be bundled as ES modules (not IIFE) to support TLA.
  worker: {
    format: 'es',
  },

  // Ensure satellite.js, TensorFlow.js, Three.js, and Brain.js are pre-bundled
  // for the main thread but not double-bundled inside Workers.
  optimizeDeps: {
    include: ['satellite.js', 'three', '@tensorflow/tfjs', 'brain.js'],
  },

  build: {
    target: 'esnext',   // support top-level await in production
  },
});
