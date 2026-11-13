import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize } from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

/**
 * pdf.js's own data files (the PDF viewer on phones, `PdfPages.tsx`): CMaps
 * for CJK text, the 14 standard fonts for PDFs that don't embed them, and the
 * wasm decoders (JPEG 2000, colour profiles). Served from our origin under
 * `/pdfjs-<version>/`: the version in the path stands in for a content hash
 * (every built file is cached for a year), and nothing loads from a CDN.
 */
function pdfjsAssets(): Plugin {
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const base = `pdfjs-${version}`;
  const dirs = ["cmaps", "standard_fonts", "wasm"];
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use(`/${base}/`, (req, res, next) => {
        const path = normalize(decodeURIComponent((req.url ?? "").split("?")[0]!)).replace(
          /^([/\\])+/,
          "",
        );
        const [dir] = path.split(/[/\\]/);
        const file = join(root, path);
        if (!dir || !dirs.includes(dir) || !file.startsWith(root) || !existsSync(file)) {
          return next();
        }
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const name of readdirSync(join(root, dir))) {
          const file = join(root, dir, name);
          if (!statSync(file).isFile()) continue;
          this.emitFile({
            type: "asset",
            fileName: `${base}/${dir}/${name}`,
            source: readFileSync(file),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  resolve: {
    alias: [
      // react-pdf imports pdf.js's modern build, which calls APIs only the newest
      // Safari has (Uint8Array.fromBase64, Math.sumPrecise…). The legacy build
      // (same version, polyfilled) runs on the iPhones still in use.
      { find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" },
    ],
  },
  server: { port: 5173 },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
    rollupOptions: {
      output: {
        // pdf.js's worker is an ES module (`.mjs`): emitted as `.js` so the S3
        // upload labels it JavaScript; a module worker refuses any other type.
        assetFileNames: (asset) =>
          asset.names?.some((n) => n.endsWith(".mjs"))
            ? "assets/[name]-[hash].js"
            : "assets/[name]-[hash][extname]",
        // Vendor code in chunks of its own: their hashes survive app-only deploys,
        // so returning browsers download just the (small) app chunk.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          amplify: ["aws-amplify"],
          fullcalendar: [
            "@fullcalendar/core",
            "@fullcalendar/react",
            "@fullcalendar/daygrid",
            "@fullcalendar/timegrid",
            "@fullcalendar/interaction",
          ],
        },
      },
    },
  },
  test: {
    // `.test.tsx`: components rendered in jsdom (each such file opts in with `@vitest-environment jsdom`).
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
