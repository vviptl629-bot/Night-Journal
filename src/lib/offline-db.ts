/**
 * Local persistence for cross-device sync.
 *
 * Two things live here:
 *   - `outbox`  — writes made while offline, replayed when the network returns
 *   - `cache`   — a snapshot of server entries so the app still renders
 *                 (read-only) with no connection
 *
 * IndexedDB is unavailable in some contexts (private mode, blocked storage).
 * Every helper degrades to a no-op / empty result instead of throwing, so the
 * app keeps working online-only rather than crashing on startup.
 */

const DB_NAME = "night-journal";
const DB_VERSION = 1;

export interface OutboxOp {
  opId: string;
  kind: "create" | "update" | "delete";
  entryId?: number;
  contentText?: string;
  moodLabel?: string;
  entryDate?: string;
  clientSavedAt?: string;
  queuedAt: string;
}

export interface CachedEntry {
  id: number;
  contentText: string;
  moodLabel: string | null;
  entryDate: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hasImages: boolean;
  includedInDiary: boolean;
  attachments: Array<{
    fileUrl: string;
    visionStatus: string;
    visionSummary?: string | null;
    visionModelUsed?: string | null;
    createdAt?: string;
  }>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "opId" });
      }
      if (!db.objectStoreNames.contains("cache")) {
        db.createObjectStore("cache", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function tx<T>(
  store: "outbox" | "cache" | "meta",
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const t = db.transaction(store, mode);
          const req = run(t.objectStore(store));
          t.oncomplete = () => resolve(req ? req.result : null);
          t.onerror = () => resolve(null);
          t.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

// ─── Outbox ────────────────────────────────────────────────────────

export async function outboxAll(): Promise<OutboxOp[]> {
  const rows = await tx<OutboxOp[]>("outbox", "readonly", (s) => s.getAll());
  return rows ?? [];
}

export async function outboxAdd(op: OutboxOp): Promise<void> {
  await tx("outbox", "readwrite", (s) => s.put(op));
}

export async function outboxRemove(opIds: string[]): Promise<void> {
  if (opIds.length === 0) return;
  await tx("outbox", "readwrite", (s) => {
    for (const id of opIds) s.delete(id);
  });
}

// ─── Entry cache ───────────────────────────────────────────────────

export async function cachePutMany(entries: CachedEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await tx("cache", "readwrite", (s) => {
    for (const e of entries) s.put(e);
  });
}

/**
 * Live entries for one day, newest first.
 *
 * Used as a placeholder while the network request is in flight (or fails), so
 * a phone with no signal still shows what it wrote yesterday.
 */
export async function cacheByDate(date: string): Promise<CachedEntry[]> {
  const rows = await tx<CachedEntry[]>("cache", "readonly", (s) => s.getAll());
  if (!rows) return [];
  return rows
    .filter((e) => e.entryDate === date && !e.deletedAt)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
}

export async function cacheCount(): Promise<number> {
  const count = await tx<number>("cache", "readonly", (s) => s.count());
  return count ?? 0;
}

// ─── Meta ──────────────────────────────────────────────────────────

export async function metaGet(key: string): Promise<string | null> {
  const row = await tx<{ key: string; value: string }>(
    "meta",
    "readonly",
    (s) => s.get(key),
  );
  return row?.value ?? null;
}

export async function metaSet(key: string, value: string): Promise<void> {
  await tx("meta", "readwrite", (s) => s.put({ key, value }));
}
