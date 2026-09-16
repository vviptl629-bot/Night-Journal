#!/usr/bin/env node
/**
 * 生产启动脚本。
 *
 * 不直接在 npm script 里写 `NODE_ENV=production node dist/boot.js`，原因有二：
 *
 *  1. `VAR=value cmd` 是 POSIX 语法，Windows 上不可用；
 *  2. Node 22.5 ~ 23.x 的内置 SQLite 需要 --experimental-sqlite 才能 require，
 *     而更早的 Node 不认识这个 flag，会以非 0 状态直接退出。
 *     所以这里先探测 flag 是否被支持，再决定怎么起。
 *
 * 探测失败时会回退到不带 flag 启动，此时由 better-sqlite3 驱动接管
 * （见 api/lib/sqlite.ts 的双驱动逻辑）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "boot.js");
const env = { ...process.env, NODE_ENV: "production" };

const probe = spawnSync(process.execPath, ["--experimental-sqlite", "-e", ""], {
  stdio: "ignore",
});

let args;
if (probe.status === 0) {
  args = ["--experimental-sqlite", entry];
} else {
  console.log(
    "[start] 当前 Node 不支持 --experimental-sqlite，回退到 better-sqlite3 驱动",
  );
  args = [entry];
}

const child = spawnSync(process.execPath, args, {
  stdio: "inherit",
  env,
  cwd: root,
});

process.exit(child.status ?? 1);
