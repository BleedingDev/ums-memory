import path from "node:path";
import { fileURLToPath } from "node:url";

import jsonc from "eslint-plugin-jsonc";
import * as jsoncParser from "jsonc-eslint-parser";
import tseslint from "typescript-eslint";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**"],
  },
  {
    files: ["apps/**/*.ts", "libs/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./libs/shared/tsconfig.json"],
        tsconfigRootDir,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
  {
    files: ["tsconfig*.json", "apps/*/tsconfig.json", "libs/shared/tsconfig.json"],
    plugins: {
      jsonc,
    },
    languageOptions: {
      parser: jsoncParser,
    },
    rules: {
      "jsonc/no-comments": "error",
      "jsonc/comma-dangle": ["error", "never"],
      "jsonc/valid-json-number": "error",
    },
  },
);
