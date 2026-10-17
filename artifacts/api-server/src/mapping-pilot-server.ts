import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mountMappingPilotUi } from "./mapping-pilot-ui.js";

// Dedicated pilot entry point. Never runs the legacy/demo seed or quiz worker.
const databaseUrl = process.env.DATABASE_URL;
const expectedHost = process.env.MAPPING_PILOT_EXPECTED_DB_HOST;
if (process.env.MAPPING_PILOT !== "1" || !databaseUrl || !expectedHost
  || new URL(databaseUrl).hostname !== expectedHost) {
  throw new Error("Mapping pilot requires its explicitly pinned, isolated database");
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)
  throw new Error("Mapping pilot requires an independent session secret");
const port = Number(process.env.PORT ?? 10000);
if (!Number.isSafeInteger(port) || port <= 0) throw new Error("Invalid pilot port");
const missing = ["AI_INTEGRATIONS_OPENROUTER_API_KEY", "AI_INTEGRATIONS_OPENROUTER_BASE_URL"]
  .filter(key => !process.env[key]);
if (missing.length) {
  // Configuration is observable without exposing secrets or enabling a
  // pretend-successful mapping API before the provider is connected.
  createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ status: "configuration_required", missing }));
  }).listen(port, "0.0.0.0");
} else {
  const { default: app } = await import("./app.js");
  mountMappingPilotUi(app, fileURLToPath(new URL("../../myaiteacher/dist/public/", import.meta.url)));
  app.listen(port, "0.0.0.0", () => console.info("Isolated mapping pilot listening"));
}
