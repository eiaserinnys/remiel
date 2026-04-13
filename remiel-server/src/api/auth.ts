import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import crypto from "node:crypto";

const JWT_EXPIRY = "7d";
export const JWT_COOKIE = "remiel_auth";
const STATE_COOKIE = "remiel_oauth_state";

function getSecret(): Uint8Array {
  const secret = process.env["JWT_SECRET"];
  if (!secret) throw new Error("JWT_SECRET is required");
  return new TextEncoder().encode(secret);
}

export interface AuthUser {
  userId: string;
  userName: string;
  userEmail: string;
  teamId: string;
}

export function isSlackConfigured(): boolean {
  return !!(
    process.env["SLACK_CLIENT_ID"] &&
    process.env["SLACK_CLIENT_SECRET"] &&
    process.env["SLACK_CALLBACK_URL"]
  );
}

export async function verifyJwt(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as AuthUser;
  } catch {
    return null;
  }
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const clientId = process.env["SLACK_CLIENT_ID"];
  const clientSecret = process.env["SLACK_CLIENT_SECRET"];
  const callbackUrl = process.env["SLACK_CALLBACK_URL"];
  const allowedTeamId = process.env["SLACK_ALLOWED_TEAM_ID"];
  const slackConfigured = isSlackConfigured();

  // GET /api/auth/slack — redirect to Slack OAuth
  app.get("/api/auth/slack", async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!slackConfigured) {
      return reply.code(503).send({ error: "Slack OAuth not configured" });
    }
    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: clientId!,
      scope: "identity.basic,identity.email,identity.avatar,identity.team",
      redirect_uri: callbackUrl!,
      state,
    });
    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    return reply.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
  });

  // GET /api/auth/slack/callback — exchange code for token
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/slack/callback",
    async (
      req: FastifyRequest<{ Querystring: { code?: string; state?: string; error?: string } }>,
      reply: FastifyReply
    ) => {
      if (!slackConfigured) {
        return reply.code(503).send({ error: "Slack OAuth not configured" });
      }

      const { code, state, error } = req.query;

      if (error) {
        return reply.redirect("/?auth_error=access_denied");
      }

      // Validate state
      const savedState = (req.cookies as Record<string, string>)[STATE_COOKIE];
      if (!state || state !== savedState) {
        return reply.redirect("/?auth_error=invalid_state");
      }
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      // Exchange code for token
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret!,
          code: code!,
          redirect_uri: callbackUrl!,
        }).toString(),
      });
      const tokenData = (await tokenRes.json()) as {
        ok: boolean;
        authed_user?: { access_token?: string };
        error?: string;
      };

      if (!tokenData.ok || !tokenData.authed_user?.access_token) {
        return reply.redirect("/?auth_error=token_exchange_failed");
      }

      // Get user identity
      const identityRes = await fetch("https://slack.com/api/users.identity", {
        headers: { Authorization: `Bearer ${tokenData.authed_user.access_token}` },
      });
      const identityData = (await identityRes.json()) as {
        ok: boolean;
        user?: { id: string; name: string; email: string };
        team?: { id: string };
        error?: string;
      };

      if (!identityData.ok || !identityData.user || !identityData.team) {
        return reply.redirect("/?auth_error=identity_failed");
      }

      // Team restriction check
      if (allowedTeamId && identityData.team.id !== allowedTeamId) {
        return reply.redirect("/?auth_error=forbidden_team");
      }

      // Issue JWT
      const payload: AuthUser = {
        userId: identityData.user.id,
        userName: identityData.user.name,
        userEmail: identityData.user.email,
        teamId: identityData.team.id,
      };

      const token = await new SignJWT({ ...payload })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(JWT_EXPIRY)
        .sign(getSecret());

      reply.setCookie(JWT_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7,
        path: "/",
      });

      return reply.redirect("/");
    }
  );

  // GET /api/auth/logout
  app.get("/api/auth/logout", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.clearCookie(JWT_COOKIE, { path: "/" });
    return reply.redirect("/login");
  });

  // GET /api/auth/me — returns current user info
  app.get("/api/auth/me", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = (req.cookies as Record<string, string>)[JWT_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const user = await verifyJwt(token);
    if (!user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    return reply.send(user);
  });
}
