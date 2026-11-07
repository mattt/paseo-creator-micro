// A development harness that renders the plugin's client components in a browser.
// Paseo supplies `@getpaseo/plugin/client` and its UI kit at runtime;
// the harness replaces them with stand-ins in `src/`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here("."),
  resolve: {
    alias: [
      { find: /^@getpaseo\/plugin\/client\/ui$/, replacement: here("src/plugin-ui.tsx") },
      { find: /^@getpaseo\/plugin\/client$/, replacement: here("src/plugin-client.tsx") },
      { find: /^react-native$/, replacement: "react-native-web" },
    ],
    dedupe: ["react", "react-dom", "@tanstack/react-query", "zod"],
    extensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js", ".json"],
  },
  server: { fs: { allow: [here("..")] } },
});
