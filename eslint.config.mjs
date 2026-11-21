/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import importX from "eslint-plugin-import-x";
import unicorn from "eslint-plugin-unicorn";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "tests/vscode/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "no-unsanitized": noUnsanitized,
      "import-x": importX,
      unicorn,
    },
    rules: {
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true, IIFEs: true }],
      'max-params': ['warn', 4],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/require-await": "warn",
      "complexity": ["warn", { max: 20 }],
      "max-depth": ["warn", { max: 4 }],

      // no-unsanitized (XSS detection, warn-only for sandboxed webview)
      "no-unsanitized/property": "warn",
      "no-unsanitized/method": "warn",

      // import-x (circular deps, ordering)
      "import-x/no-cycle": "warn",
      "import-x/order": [
        "warn",
        { groups: ["builtin", "external", "internal", "parent", "sibling"] },
      ],
      "import-x/no-duplicates": "error",

      // unicorn (modern JS best practices)
      "unicorn/no-for-each": "warn",
      "unicorn/prefer-array-find": "warn",
      "unicorn/no-lonely-if": "warn",
      "unicorn/prefer-string-replace-all": "warn",
      "unicorn/prefer-number-properties": "warn",
      "unicorn/no-useless-spread": "warn",

      // Discourage rawHtml — prefer safeNumber/safeCssClass/safeCssValue
      "no-restricted-imports": ["warn", {
        paths: [{
          name: "./shared",
          importNames: ["rawHtml"],
          message: "Prefer safeNumber(), safeCssClass(), or safeCssValue() over rawHtml(). Use rawHtml only in shared.ts internals.",
        }],
      }],
    },
  },
  {
    ignores: ["dist/", "node_modules/", ".vscode-test/", "**/*.mjs", "tests/e2e/"],
  }
);
