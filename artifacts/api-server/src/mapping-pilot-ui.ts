import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";

/** Mounted only by the isolated entry point, after the canonical API router. */
export function mountMappingPilotUi(app: Express, publicDir: string) {
  const index = path.join(publicDir, "index.html");
  if (!existsSync(index)) throw new Error("Mapping pilot teacher UI build is missing");
  // Unknown APIs must never fall through to the SPA's HTML response.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(express.static(publicDir, { index: false }));
  app.get("/{*path}", (req, res, next) => {
    if (path.extname(req.path) || !req.accepts("html")) return next();
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(index);
  });
}
