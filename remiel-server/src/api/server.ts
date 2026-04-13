import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

  // Dashboard static files (production only — dist/ exists after vite build)
  // __dirname = dist/api/ → ../../dashboard/dist
  const dashboardPath = path.join(__dirname, "../../dashboard/dist");
  if (fs.existsSync(dashboardPath)) {
    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: "/",
      wildcard: false,
    });
    // SPA fallback: non-API, non-file routes → index.html
    app.setNotFoundHandler(async (req, reply) => {
      if (!req.url.startsWith("/api/") && !req.url.startsWith("/events")) {
        return reply.sendFile("index.html");
      }
      reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}
