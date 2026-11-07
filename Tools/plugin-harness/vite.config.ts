// A development harness that renders the plugin's client components in a browser.
// Paseo supplies `@getpaseo/plugin/client` and its UI kit at runtime;
// the harness replaces them with stand-ins in `src/`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const plugin = (path: string) => here(`../../Plugin/${path}`);

export default defineConfig({
  root: here("."),
  // The plugin's tsconfig.json, which sets the JSX runtime, does not cover this folder.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: [
      { find: /^@getpaseo\/plugin\/client\/ui$/, replacement: here("src/plugin-ui.tsx") },
      { find: /^@getpaseo\/plugin\/client$/, replacement: here("src/plugin-client.tsx") },
      { find: /^react-native$/, replacement: "react-native-web" },
      // React and TanStack Query come from the plugin's development dependencies,
      // so the plugin's components and the harness share one copy of each.
      { find: /^react(\/.*)?$/, replacement: `${plugin("node_modules/react")}$1` },
      {
        find: /^@tanstack\/react-query$/,
        replacement: plugin("node_modules/@tanstack/react-query"),
      },
    ],
    extensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".js", ".json"],
  },
  server: { fs: { allow: [here("../..")] } },
});
