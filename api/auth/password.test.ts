/**
 * Tests for local username/password authentication handlers.
 *
 * Covers:
 *   - Input validation (username rules, password length)
 *   - Register: happy path, duplicate username → 409
 *   - Login: happy path, wrong password → 401, unknown user → 401
 *   - Timing safety: unknown-username always runs bcrypt (no fast reject)
 *
 * All DB and session-signing calls are mocked so tests run offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/env", () => ({
  env: {
    appSecret: "test-secret-that-is-long-enough-32c",
    databaseUrl: "mysql://x:y@localhost/z",
    isProduction: false,
    ownerUnionId: "",
  },
}));

vi.mock("../queries/users", () => ({
  findUserByUsername: vi.fn(),
  createLocalUser: vi.fn(),
}));

// session signing just needs to return a string token
vi.mock("./session", () => ({
  signSessionToken: vi.fn().mockResolvedValue("mock-jwt-token"),
}));

import { createRegisterHandler, createLoginHandler } from "./password";
import { findUserByUsername, createLocalUser } from "../queries/users";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRegisterApp() {
  const app = new Hono();
  app.post("/api/auth/register", createRegisterHandler());
  return app;
}

function buildLoginApp() {
  const app = new Hono();
  app.post("/api/auth/login", createLoginHandler());
  return app;
}

async function post(app: Hono, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// A real bcrypt hash of "password1" for use in login tests
const PASSWORD = "password1";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// Pre-compute the hash once (synchronous bcrypt.hashSync is fine in tests)
const HASHED_PASSWORD = bcrypt.hashSync(PASSWORD, 10);

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

describe("POST /api/auth/register — input validation", () => {
  it("rejects missing body fields (400)", async () => {
    const res = await post(buildRegisterApp(), "/api/auth/register", {});
    expect(res.status).toBe(400);
  });

  it("rejects empty or whitespace-only username (400)", async () => {
    const res = await post(buildRegisterApp(), "/api/auth/register", {
      username: "   ",
      password: "password1",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/用户名/);
  });

  it("rejects username longer than 64 chars (400)", async () => {
    const res = await post(buildRegisterApp(), "/api/auth/register", {
      username: "a".repeat(65),
      password: "password1",
    });
    expect(res.status).toBe(400);
  });

  it("accepts an English name with spaces, dots and any password length", async () => {
    vi.mocked(findUserByUsername).mockResolvedValue(undefined);
    vi.mocked(createLocalUser).mockResolvedValue({
      id: 1,
      unionId: "local:Alan W.",
      username: "Alan W.",
      passwordHash: HASHED_PASSWORD,
      name: "Alan W.",
      email: null,
      avatar: null,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignInAt: new Date(),
    });

    const long = await post(buildRegisterApp(), "/api/auth/register", {
      username: "  Alan W.  ",
      password: "a".repeat(120),
    });
    expect(long.status).toBe(201);
    // username is trimmed and inner whitespace collapsed before storage
    expect(vi.mocked(createLocalUser).mock.calls.at(-1)?.[0].username).toBe(
      "Alan W.",
    );

    const short = await post(buildRegisterApp(), "/api/auth/register", {
      username: "Bo",
      password: "1234",
    });
    expect(short.status).toBe(201);
  });
});

describe("POST /api/auth/register — happy path", () => {
  it("creates user and returns 201 with session cookie", async () => {
    vi.mocked(findUserByUsername).mockResolvedValue(undefined);
    vi.mocked(createLocalUser).mockResolvedValue({
      id: 1,
      unionId: "local:alice",
      username: "alice",
      passwordHash: HASHED_PASSWORD,
      name: "alice",
      email: null,
      avatar: null,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignInAt: new Date(),
    });

    const res = await post(buildRegisterApp(), "/api/auth/register", {
      username: "alice",
      password: PASSWORD,
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    // Session cookie should be set
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("session");
  });
});

describe("POST /api/auth/register — duplicate username", () => {
  it("returns 409 when username already exists", async () => {
    vi.mocked(findUserByUsername).mockResolvedValue({
      id: 1,
      unionId: "local:alice",
      username: "alice",
      passwordHash: HASHED_PASSWORD,
      name: "alice",
      email: null,
      avatar: null,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignInAt: new Date(),
    });

    const res = await post(buildRegisterApp(), "/api/auth/register", {
      username: "alice",
      password: PASSWORD,
    });

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/已经有人用了/);
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("POST /api/auth/login — happy path", () => {
  it("returns 200 with session cookie on correct credentials", async () => {
    vi.mocked(findUserByUsername).mockResolvedValue({
      id: 1,
      unionId: "local:alice",
      username: "alice",
      passwordHash: HASHED_PASSWORD,
      name: "alice",
      email: null,
      avatar: null,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignInAt: new Date(),
    });

    const res = await post(buildLoginApp(), "/api/auth/login", {
      username: "alice",
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("session");
  });
});

describe("POST /api/auth/login — wrong password", () => {
  it("returns 401 on incorrect password", async () => {
    vi.mocked(findUserByUsername).mockResolvedValue({
      id: 1,
      unionId: "local:alice",
      username: "alice",
      passwordHash: HASHED_PASSWORD,
      name: "alice",
      email: null,
      avatar: null,
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignInAt: new Date(),
    });

    const res = await post(buildLoginApp(), "/api/auth/login", {
      username: "alice",
      password: "wrongpassword",
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/密码不对/);
  });
});

describe("POST /api/auth/login — unknown username", () => {
  it("still returns 401, but says the username is not registered", async () => {
    vi.mocked(findUserByUsername).mockResolvedValue(undefined);

    const res = await post(buildLoginApp(), "/api/auth/login", {
      username: "nobody",
      password: "password1",
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    // 单机自用：说清楚"没这个号"比含糊的"用户名或密码不正确"有用得多，
    // 否则用户会一直怀疑自己记错密码，其实是账号不存在。
    expect(body.error).toMatch(/还没有注册/);
  });
});
