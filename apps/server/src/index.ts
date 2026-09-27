import { delimiter } from "node:path";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DATA_DIR ? `${process.env.DATA_DIR}/gateway.db` : "data/gateway.db";
const adminPassword = process.env.ADMIN_PASSWORD ?? "";
if (!adminPassword) {
  throw new Error("ADMIN_PASSWORD is required");
}

const app = await buildApp({
  dbPath,
  adminPassword,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  workspaceRoots: (process.env.WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean),
});
await app.listen({ port, host });
