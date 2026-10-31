import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const apiTarget = process.env.DUBLE_API_URL ?? "http://127.0.0.1:5080";
const proxy = Object.fromEntries(
  ["/api", "/health", "/openapi"].map((path) => [path, { target: apiTarget }]),
);

export default defineConfig({
  server: {
    cors: false,
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy,
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../examples", import.meta.url)),
      ],
    },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
  build: { target: "es2022" },
});
