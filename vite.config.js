import { defineConfig } from 'vite';
import { resolve }      from 'path';

export default defineConfig({
  server: {
    cors: true,
    origin: 'http://localhost:5173',
    proxy: {
      // All requests to /spacetrack/* are forwarded to space-track.org.
      // The browser only ever sees localhost — no CORS issue.
      '/spacetrack': {
        target:       'https://www.space-track.org',
        changeOrigin: true,
        secure:       true,
        rewrite:      path => path.replace(/^\/spacetrack/, ''),
      },
      // All requests to /celestrak/* are forwarded to celestrak.org.
      // Required because CelesTrak does not send CORS headers for browser fetches.
      '/celestrak': {
        target:       'https://celestrak.org',
        changeOrigin: true,
        secure:       true,
        rewrite:      path => path.replace(/^\/celestrak/, ''),
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
