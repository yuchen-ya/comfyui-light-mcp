import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Benchmark captures and their independent tooling are outside the shipped server.
  { ignores: ["dist", "node_modules", "data", "output", ".analysis", "workflows", "benchmarks", "*.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error"
    }
  }
);
