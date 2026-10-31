#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const manifestPath = path.join(root, "docs/migration/capabilities.json");
const outputPath = path.join(root, "apps/api/internal/capability/capability_catalog.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const capabilities = manifest.capabilities.map((capability) => ({
  id: capability.id,
  title: (capability.title || capability.id).replace(/[\u2012\u2013\u2014\u2015]/g, "-"),
  intent: (capability.intent || "").replace(/[\u2012\u2013\u2014\u2015]/g, "-"),
  module: capability.module || "",
  risk: capability.risk || "",
  schema: capability.inputSchema || { type: "object", properties: {}, additionalProperties: false },
}));
fs.writeFileSync(outputPath, `${JSON.stringify({ capabilities })}\n`);
process.stdout.write(`wrote ${capabilities.length} capabilities to ${path.relative(root, outputPath)}\n`);
