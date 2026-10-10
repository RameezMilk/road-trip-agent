import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The server owns /api; in production it also serves this build from the same origin.
    proxy: { "/api": "http://localhost:8787" },
  },
});
