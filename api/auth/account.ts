/**
 * Account self-service endpoint.
 *
 *   DELETE /api/auth/account  — permanently delete the signed-in account
 *
 * Deletion is irreversible, so it requires the current password again even
 * though the caller already has a valid session cookie. Everything owned by
 * the user is removed (entries, attachments, diaries, versions, preset
 * configs, AI settings, profile/memories) and the username is freed so the
 * same name can be registered again.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { Session } from "@contracts/constants";
import { authenticateRequest } from "./session";
import { deleteUserCascade } from "../queries/users";

/** bcrypt truncates at 72 bytes; mirror password.ts so hashes stay compatible. */
function bcryptInput(password: string): string {
  return Buffer.byteLength(password, "utf8") > 72
    ? createHash("sha256").update(password, "utf8").digest("hex")
    : password;
}

export function createDeleteAccountHandler() {
  return async (c: Context) => {
    let user;
    try {
      user = await authenticateRequest(c.req.raw.headers);
    } catch {
      return c.json({ error: "请先登录" }, 401);
    }

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // Body is optional: a session-only delete is allowed too.
      body = {};
    }

    const { password } = (body ?? {}) as Record<string, unknown>;

    // If the account has a password, require it. OAuth-only accounts have no
    // passwordHash and can be deleted with just the session cookie.
    if (user.passwordHash) {
      if (typeof password !== "string" || password.length === 0) {
        return c.json({ error: "请输入密码以确认删除" }, 400);
      }
      const ok = await bcrypt.compare(bcryptInput(password), user.passwordHash);
      if (!ok) {
        return c.json({ error: "密码不正确" }, 401);
      }
    }

    await deleteUserCascade(user.id);

    if (getCookie(c, Session.cookieName)) {
      deleteCookie(c, Session.cookieName, { path: "/" });
    }

    return c.json({ ok: true });
  };
}
