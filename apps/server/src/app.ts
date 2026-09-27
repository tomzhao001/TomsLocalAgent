import Fastify, { type FastifyInstance } from "fastify";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}
