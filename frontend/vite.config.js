import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    {
      // ONNX Runtime dynamically import()s .mjs loader files from wasmPaths.
      // Since wasmPaths points to publicDir (/assets/ort/), Vite blocks the
      // import because publicDir files skip the transform pipeline.
      // This plugin redirects those imports to node_modules where Vite CAN
      // process them as regular modules.
      name: "ort-wasm-resolve",
      resolveId(source) {
        if (
          source.startsWith("/assets/ort/") &&
          (source.endsWith(".mjs") || source.endsWith(".js"))
        ) {
          const filename = source.split("/").pop();
          return path.resolve(
            "node_modules/onnxruntime-web/dist",
            filename
          );
        }
        return null;
      },
    },
  ],
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  publicDir: "models",
  build: {
    outDir: "dist",
    assetsDir: "assets",
    assetsInlineLimit: 20_000_000, // 20MB
    assetsInclude: ["**/*.onnx"],
  },
});
