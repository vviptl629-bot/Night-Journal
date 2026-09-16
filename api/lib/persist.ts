/**
 * 数据持久化 + 快照备份。
 *
 * 为什么需要它：部署通道会把整个项目目录替换一遍，落在 `<项目>/data/`
 * 里的 SQLite 文件会跟着一起消失（实测：一次重新发布后线上测试账号没了）。
 * 日记是唯一数据，丢不起，所以这里做三件事：
 *
 *   1. 快照写到**项目目录之外**的持久目录（父目录优先，逐级探测可写性）
 *   2. 启动时若主库缺失，从持久目录自动恢复，服务照样可用
 *   3. 运行期定时快照 + 进程退出前快照 + 用户在设置页手动快照
 *
 * 快照前会做一次 WAL checkpoint，保证复制出来的单文件是自洽的。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SqliteDriver } from "./sqlite";

const SNAPSHOT_PREFIX = "night-journal-";
const SNAPSHOT_EXT = ".sqlite";
const MAX_SNAPSHOTS = 12;
/** 定时快照间隔（毫秒） */
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

let cachedDir: string | null = null;

function isWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe");
    fs.writeFileSync(probe, "1");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 持久目录候选，按优先级排列：
 *   1. NJ_PERSIST_DIR 环境变量（宿主想自己指定时用）
 *   2. 项目目录的**上一级**（部署只替换项目目录本身，父目录会留下）
 *   3. 系统临时目录（兜底）
 */
function persistDirCandidates(): string[] {
  const cwd = process.cwd();
  const list: string[] = [];
  if (process.env.NJ_PERSIST_DIR?.trim()) {
    list.push(path.resolve(process.env.NJ_PERSIST_DIR.trim()));
  }
  list.push(path.resolve(cwd, "..", ".night-journal-data"));
  list.push(path.resolve(os.tmpdir(), "night-journal-data"));
  return list;
}

/** 解析（并缓存）可用的持久目录；全部不可写时返回 null。 */
export function persistDir(): string | null {
  if (cachedDir) return cachedDir;
  for (const dir of persistDirCandidates()) {
    if (isWritable(dir)) {
      cachedDir = dir;
      console.log(`[persist] 数据快照目录: ${dir}`);
      return dir;
    }
  }
  console.warn("[persist] WARNING: 找不到可写的持久目录，自动备份已停用。");
  return null;
}

function snapshotsDir(): string | null {
  const dir = persistDir();
  if (!dir) return null;
  const target = path.join(dir, "snapshots");
  try {
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch {
    return null;
  }
}

function isSnapshotFile(name: string): boolean {
  return (
    name.startsWith(SNAPSHOT_PREFIX) &&
    name.endsWith(SNAPSHOT_EXT) &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

export interface SnapshotInfo {
  id: string;
  size: number;
  mtime: number;
}

/** 列出已有快照，新的在前。 */
export function listSnapshots(): SnapshotInfo[] {
  const dir = snapshotsDir();
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter(isSnapshotFile)
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return {
          id: name,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** 只允许下载 snapshots 目录内的快照文件，杜绝路径穿越。 */
export function resolveSnapshotFile(id: string): string | null {
  if (!isSnapshotFile(id)) return null;
  const dir = snapshotsDir();
  if (!dir) return null;
  const file = path.join(dir, id);
  return fs.existsSync(file) ? file : null;
}

function prune(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter(isSnapshotFile)
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(MAX_SNAPSHOTS)) {
      fs.rmSync(path.join(dir, f.name), { force: true });
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** checkpoint + 复制，保证快照是自洽的单文件。 */
export function createSnapshot(
  dbFile: string,
  driver?: SqliteDriver,
): SnapshotInfo | null {
  const dir = snapshotsDir();
  if (!dir) return null;
  if (!fs.existsSync(dbFile)) return null;

  try {
    driver?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* 驱动不支持就算了，复制出的文件在 WAL 模式下仍能恢复 */
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const target = path.join(dir, `${SNAPSHOT_PREFIX}${stamp}${SNAPSHOT_EXT}`);

  try {
    fs.copyFileSync(dbFile, target);
    // 再留一份固定名的镜像，恢复时优先用它，速度最快
    fs.copyFileSync(dbFile, path.join(path.dirname(dir), "night-journal-latest.sqlite"));
    prune(dir);
    const stat = fs.statSync(target);
    return { id: path.basename(target), size: stat.size, mtime: Math.floor(stat.mtimeMs) };
  } catch (e) {
    console.warn(
      `[persist] WARNING: 快照失败: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * 启动时调用：主库被部署抹掉了就从持久目录恢复。
 * 返回是否发生了恢复。
 */
export function restoreDatabase(dbFile: string): boolean {
  if (fs.existsSync(dbFile)) return false;
  const dir = persistDir();
  if (!dir) return false;

  const mirror = path.join(dir, "night-journal-latest.sqlite");
  const latest = listSnapshots()[0];
  const snapshots = snapshotsDir();
  const source =
    fs.existsSync(mirror) && fs.statSync(mirror).size > 0
      ? mirror
      : latest && snapshots
        ? path.join(snapshots, latest.id)
        : null;
  if (!source) return false;

  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.copyFileSync(source, dbFile);
    console.log(`[persist] 主库缺失，已从备份恢复: ${source}`);
    return true;
  } catch (e) {
    console.warn(
      `[persist] WARNING: 恢复数据库失败: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/** 定时 + 退出前快照。返回的 stop() 用于测试。 */
export function startAutoSnapshot(
  dbFile: string,
  getDriver: () => SqliteDriver,
  intervalMs = SNAPSHOT_INTERVAL_MS,
) {
  const run = () => {
    try {
      createSnapshot(dbFile, getDriver());
    } catch {
      /* ignore */
    }
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();

  const onExit = () => run();
  process.once("exit", onExit);
  process.once("SIGINT", () => {
    run();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    run();
    process.exit(0);
  });

  // 启动后立刻来一份，保证第一次部署就有恢复点
  run();

  return { stop: () => clearInterval(timer), runNow: run };
}
