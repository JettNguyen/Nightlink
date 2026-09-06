import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import pluginReact from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    // `ios/` holds the native project plus the web bundle Capacitor copies into
    // it, so linting it just re-reports thousands of errors from generated and
    // vendored code, and it was failing CI.
    ignores: ["dist/**", "ios/**", "**/*.min.js", "dev-dist/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      pluginReact.configs.flat.recommended,
      pluginReact.configs.flat["jsx-runtime"],
    ],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      // A hook placed below a component's early return is skipped on one render
      // and runs on the next, so react throws mid render and the whole page
      // becomes the error boundary. That shipped once past a green build and a
      // clean production bundle, because nothing was checking for it.
      "react-hooks/rules-of-hooks": "error",
      // Left off deliberately: several effects here intentionally omit deps to
      // run once, so turning this on would bury the rule above in warnings.
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: [
      "vite.config.{js,ts,mjs,cjs}",
      "eslint.config.{js,ts,mjs,cjs}",
      "api/**/*.{js,ts,mjs,cjs}",
      "scripts/**/*.{js,ts,mjs,cjs}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

