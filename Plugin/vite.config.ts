import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  lint: {
    ignorePatterns: ["node_modules/**"],
    options: {
      typeAware: true,
    },
    rules: {
      // The Paseo SDK declares its callbacks, such as `rpc` and `openSettings`,
      // with method syntax, though they are bound functions.
      "typescript/unbound-method": "off",
    },
  },
  fmt: {
    ignorePatterns: ["node_modules/**", "package-lock.json"],
    printWidth: 100,
  },
});
