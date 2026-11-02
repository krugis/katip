// SPDX-License-Identifier: AGPL-3.0-only
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { sourcemap: false },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
