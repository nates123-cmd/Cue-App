import { defineConfig } from 'vitest/config'

// Test-only config. Does NOT touch the app's vite.config.js or build.
//
// src/lib/supabase.js throws at import time if VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY are absent, and claude.js (which exports the pure
// extractJSON we want to test) imports supabase.js transitively. We provide
// throwaway values here so those modules import cleanly under the test runner.
// No network is performed by the pure functions under test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,jsx}'],
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
})
