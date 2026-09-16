/**
 * Local username/password authentication handlers.
 *
 * Two endpoints:
 *   POST /api/auth/register  — create a new local account
 *   POST /api/auth/login     — authenticate and issue a session cookie
 *
 * Both share the same session signing logic used by the Kimi OAuth flow
 * (`signSessionToken` → HS256 JWT → httpOnly cookie, 30-day TTL).
 *
 * Relaxed constraints (self-hosted / personal instance):
 *   - Username: 1–64 chars after trimming, any printable characters allowed
 *     (spaces, dots, "@", CJK — e.g. an English name works as-is)
 *   - Username lookup is case-insensitive ("Alan" and "alan" are the same)
 *   - Password: any length ≥ 1 (bcrypt's 72-byte cap handled by pre-hashing)
 *   - Passwords are hashed with bcrypt, cost factor 12
 *   - Timing-safe comparison via bcrypt.compare (always runs even on
 *     unknown username to prevent username enumeration via timing)
 */

import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { getSessionCookieOptions } from "../lib/cookies";
import { Session } from "@contracts/constants";
import { signSessionToken } from "./session";
import {
  findUserByUsername,
  createLocalUser,
} from "../queries/users";

const BCRYPT_ROUNDS = 12;

// Sentinel hash used to prevent username-enumeration via timing
const DUMMY_HASH =
  "$2a$12$dummyhashfortimingnormalizationi.NRPb2P0Nqx0M6cJXyMJpYEiuV3K";

/** Validates username/password shape before touching the DB. */
function validateInput(
  username: unknown,
  password: unknown,
): string | null {
  const name = normalizeUsername(username);
  if (typeof password !== "string" || name.length < 1) {
    return "username and password are required";
  }
  if (name.length > 64) {
    return "username must be 64 characters or fewer";
  }
  if (typeof password === "string" && password.length < 1) {
    return "password is required";
  }
  return null;
}

/** Trims + collapses inner whitespace, so a stray trailing space never blocks login. */
function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
}

/**
 * bcrypt truncates input at 72 bytes. Pre-hash anything longer so long
 * passphrases work too, without changing how existing short passwords verify.
 */
function bcryptInput(password: string): string {
  return Buffer.byteLength(password, "utf8") > 72
    ? createHash("sha256").update(password, "utf8").digest("hex")
    : password;
}

export function createRegisterHandler() {
  return async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { username, password, name } = body as Record<string, unknown>;
    const validationError = validateInput(username, password);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const cleanUsername = normalizeUsername(username);

    // Check if username is already taken (case-insensitive)
    const existing = await findUserByUsername(cleanUsername);
    if (existing) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const passwordHash = await bcrypt.hash(
      bcryptInput(password as string),
      BCRYPT_ROUNDS,
    );
    const user = await createLocalUser({
      username: cleanUsername,
      passwordHash,
      name: typeof name === "string" && name.trim() ? name.trim() : undefined,
    });

    if (!user) {
      return c.json({ error: "Failed to create user" }, 500);
    }

    const token = await signSessionToken({
      unionId: user.unionId,
      clientId: "local",
    });

    const cookieOpts = getSessionCookieOptions(c.req.raw.headers);
    setCookie(c, Session.cookieName, token, {
      ...cookieOpts,
      maxAge: Session.maxAgeMs / 1000,
    });

    return c.json({ ok: true }, 201);
  };
}

export function createLoginHandler() {
  return async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { username, password } = body as Record<string, unknown>;
    const validationError = validateInput(username, password);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const cleanUsername = normalizeUsername(username);
    const user = await findUserByUsername(cleanUsername);

    // Always run bcrypt.compare to prevent timing-based username enumeration
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    const match = await bcrypt.compare(
      bcryptInput(password as string),
      hashToCompare,
    );

    if (!user || !match) {
      return c.json({ error: "Invalid username or password" }, 401);
    }

    const token = await signSessionToken({
      unionId: user.unionId,
      clientId: "local",
    });

    const cookieOpts = getSessionCookieOptions(c.req.raw.headers);
    setCookie(c, Session.cookieName, token, {
      ...cookieOpts,
      maxAge: Session.maxAgeMs / 1000,
    });

    return c.json({ ok: true });
  };
}
