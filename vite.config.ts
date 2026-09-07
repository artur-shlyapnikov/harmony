import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

const src = new URL("./src/", import.meta.url).pathname;

const aliases = {
  "@app": `${src}app`,
  "@domain": `${src}domain`,
  "@state": `${src}state`,
  "@audio": `${src}audio`,
  "@persistence": `${src}persistence`,
  "@midi": `${src}midi`,
  "@features": `${src}features`,
  "@shared": `${src}shared`,
} as const;

// Under Vitest the babel-based react plugin is skipped: oxc's transform reads
// "jsx": "react-jsx" from tsconfig and emits the same react/jsx-runtime calls
// without the fast-refresh pass on every .tsx module. Dev/build keep the
const isVitest = !!process.env.VITEST;

export default defineConfig({
  plugins: isVitest ? [] : [react()],
  resolve: {
    alias: aliases,
  },
  test: {
    globals: true,
    environment: "node",
    // Playwright owns e2e/ (§3.19 file table); vitest must not pick it up.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
  server: {
    // Pre-transform the whole source graph at server start: the editor route
    // (lanes/blocks/domain) is otherwise transformed on first navigation,
    // which turns the first project open into a ~2s waterfall in dev.
    warmup: {
      clientFiles: ["src/**/*.ts", "src/**/*.tsx"],
    },
  },
});
