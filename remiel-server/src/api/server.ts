import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { registerAuthRoutes, isSlackConfigured, verifyJwt, JWT_COOKIE } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function createServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] });

  // Register cookie plugin before hooks so req.cookies is available in onRequest
  await app.register(fastifyCookie);

  // Auth routes (public — must be registered before the auth hook)
  await registerAuthRoutes(app);

  app.addHook("onRequest", async (req, reply) => {
    const { url, method } = req;

    // Public: health + auth routes
    if (url === "/api/health") return;
    if (url.startsWith("/api/auth/")) return;

    // Bot → server write API: x-api-key auth
    if (method !== "GET" && url.startsWith("/api/")) {
      const key = req.headers["x-api-key"];
      if (!key || key !== process.env["API_KEY"]) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      return;
    }

    // Dashboard (GET /api/*) + SSE (/events): JWT cookie auth
    // Slack OAuth 미설정 시 인증 비활성화 (개발 모드용 의도적 우회)
    if (!isSlackConfigured()) return;

    if ((method === "GET" && url.startsWith("/api/")) || url.startsWith("/events")) {
      const token = (req.cookies as Record<string, string>)[JWT_COOKIE];
      if (!token) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      const user = await verifyJwt(token);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
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
