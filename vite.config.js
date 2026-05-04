import { defineConfig } from 'vite';

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
});
