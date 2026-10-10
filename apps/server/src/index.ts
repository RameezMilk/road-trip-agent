import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { createHttpApp } from "./http/app";

const config = loadConfig();
const app = createHttpApp();

serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(`server listening on :${port}`);
  // The Spectrum chat loop is wired in once the probe confirms group support (npm run probe).
  console.log("chat loop not started — run `npm run probe` for the Photon capability test");
});
