import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused arguments are fine when prefixed with an underscore.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Money must never be a floating-point number; see docs/architecture.md.
      "no-restricted-globals": ["error", { name: "parseFloat", message: "Amounts are integers in smallest units." }],
    },
  },
  {
    // Tests read loosely typed JSON responses.
    files: ["tests/**", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
