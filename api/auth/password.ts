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
    return "请填写用户名和密码";
  }
  if (name.length > 64) {
    return "用户名最多 64 个字符";
  }
  if (password.length < 1) {
    return "请填写密码";
  }
  return null;
}

/**
 * 用户名归一：trim + 折叠空白 + NFKC + 去掉零宽字符。
 *
 * NFKC 这一步很关键：中文输入法下打英文名容易出全角字母（Ｔｒａｄｅｒ），
 * 注册时存了全角、登录时打半角就会一直"密码错误"，其实错的是用户名。
 */
function normalizeUsername(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    // 零宽/不可见字符（输入法、复制粘贴带入）
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 密码候选：原样 + NFKC + 去首尾空格的组合。
 *
 * 手机输入法和自动填充经常在密码尾部带一个空格，或者输入法半角/全角状态
 * 不一致。逐一比对可以把这类"明明没输错却登不上"的情况兜住。
 * 个人自托管场景下这点宽松度换来的可用性是值得的。
 */
function passwordCandidates(raw: string): string[] {
  const nfkc = raw.normalize("NFKC");
  const list = [raw, raw.trim(), nfkc, nfkc.trim()];
  return [...new Set(list)].filter((p) => p.length > 0);
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
      return c.json({ error: "请求格式有误" }, 400);
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
      return c.json({ error: "这个用户名已经有人用了，换一个吧" }, 409);
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
      return c.json({ error: "账号创建失败，请稍后再试" }, 500);
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
      return c.json({ error: "请求格式有误" }, 400);
    }

    const { username, password } = body as Record<string, unknown>;
    const validationError = validateInput(username, password);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const cleanUsername = normalizeUsername(username);
    const user = await findUserByUsername(cleanUsername);

    // 用户名不存在时也要跑一次 bcrypt，避免通过响应耗时枚举用户名
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    let match = false;
    for (const candidate of passwordCandidates(password as string)) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(bcryptInput(candidate), hashToCompare)) {
        match = true;
        break;
      }
    }

    if (!user || !match) {
      // 单机自用场景，明确区分"没这个号"和"密码不对"比防枚举更有价值 ——
      // 否则用户会一直怀疑自己记错密码，其实是账号根本不存在（例如被部署冲掉了）。
      return c.json(
        {
          error: !user
            ? "这个用户名还没有注册，先去注册一个吧"
            : "密码不对，再试一次",
        },
        401,
      );
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
