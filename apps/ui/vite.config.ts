import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vite` talks to the Prism mock of the contract (pnpm mock); `vite --mode backend` to a local control plane.
export default defineConfig(({ mode }) => {
  const backend = mode === "backend";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api/v1": backend
          ? { target: process.env.API_URL ?? "http://127.0.0.1:3000" }
          : // Prism serves the contract paths without the /api/v1 server prefix.
            { target: process.env.MOCK_URL ?? "http://127.0.0.1:4010", rewrite: (path) => path.replace(/^\/api\/v1/, "") },
        // The mock serves only v1: without a backend the v2 calls are answered by the tests' own routes.
        ...(backend ? { "/api/v2": { target: process.env.API_URL ?? "http://127.0.0.1:3000" } } : {}),
      },
    },
  };
});
