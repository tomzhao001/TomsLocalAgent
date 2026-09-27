import Fastify, { type FastifyInstance } from "fastify";
import { openDatabase } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerWorkspaces } from "./workspaces.js";

export type AppOptions = {
  dbPath: string;
  adminPassword: string;
  cookieSecure?: boolean;
  workspaceRoots?: string[];
};

export async function buildApp(options?: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ ok: true }));

  if (options) {
    const db = openDatabase(options.dbPath);
    app.addHook("onClose", async () => {
      db.close();
    });
    await registerAuth(app, db, {
      adminPassword: options.adminPassword,
      cookieSecure: options.cookieSecure !== false,
    });
    await registerWorkspaces(app, db, options.workspaceRoots ?? []);
  }

  return app;
}
