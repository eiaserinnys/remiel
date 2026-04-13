import Fastify from "fastify";
import cors from "@fastify/cors";

export async function createServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/api/health") return;
    if (req.url.startsWith("/events")) return;
    if (!req.url.startsWith("/api/")) return;
    const key = req.headers["x-api-key"];
    if (!key || key !== process.env.API_KEY) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  return app;
}
