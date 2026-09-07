import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// §3.3 architectural boundaries: the domain layer stays pure — no
// React/Redux/Tone/Dexie/DOM and no app-layer imports. Static mirror of
// tests/domain/domainPurity.test.ts (the test remains as belt-and-braces).
const DOMAIN_FORBIDDEN = [
  "react",
  "react-dom",
  "react-redux",
  "@reduxjs/*",
  "tone",
  "dexie",
  "jsdom",
  "@app/*",
  "@state/*",
  "@audio/*",
  "@persistence/*",
  "@midi/*",
  "@features/*",
  "@shared/*",
];

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "playwright-report/",
      "test-results/",
      "coverage/",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DOMAIN_FORBIDDEN,
              message:
                "src/domain must stay pure (§3.3): no React/Redux/Tone/Dexie/DOM or app-layer imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    ignores: ["src/domain/theory/tonalAdapter.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...DOMAIN_FORBIDDEN, "tonal", "tonal/*"],
              message:
                "Boundary violation (§3.3): only src/domain/theory/tonalAdapter.ts may import 'tonal'.",
            },
          ],
        },
      ],
    },
  },
  // §3.3 dependency rule: features reach infrastructure only through the app
  // composition root (src/app/dependencies.ts) or @audio controllers — never
  // via direct @persistence/*, @midi/*, dexie or tone imports.
  {
    files: ["src/features/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@persistence/*", "@midi/*", "dexie", "tone"],
              message:
                "Boundary violation (§3.3): src/features must go through src/app/dependencies.ts (or the @audio controller) instead of importing persistence/midi infrastructure directly.",
            },
          ],
        },
      ],
    },
  },
  // Spy/matcher access patterns (expect(spy.method)) trip unbound-method in
  // every test file; async test fixtures legitimately omit awaits.
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);
