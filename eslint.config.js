import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    rules: {
      eqeqeq: "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
