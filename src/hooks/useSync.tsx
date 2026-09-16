import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { trpc } from "@/providers/trpc";
import * as db from "@/lib/offline-db";
import type { OutboxOp } from "@/lib/offline-db";

/**
 * Cross-device sync orchestration.
 *
 * The server is already the single source of truth — phone and desktop signed
 * into the same account see the same data. What this layer adds is resilience
 * around that: writes that fail (no signal, subway, flaky hotel wifi) are
 * queued locally and replayed automatically, and a snapshot is cached so the
 * app still renders offline instead of showing an empty state.
 */

const LAST_SYNC_KEY = "lastSyncAt";
const POLL_INTERVAL_MS = 60_000;
const MIN_MANUAL_GAP_MS = 3_000;

export type SyncPhase = "idle" | "syncing" | "offline" | "error";

interface SyncContextValue {
  online: boolean;
  syncing: boolean;
  /** Operations waiting to reach the server. 0 means fully in sync. */
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /**
   * Queue a failed write for replay. Returns the op id when it was stored
   * (so the caller can show it optimistically), or null when local storage
   * is unavailable.
   */
  enqueue: (op: Omit<OutboxOp, "opId" | "queuedAt">) => Promise<string | null>;
  /** Force a sync cycle (flush outbox, then pull). Safe to call anytime. */
  syncNow: () => Promise<void>;
  /** Cached entries for a date — for offline / first-paint rendering. */
  readCached: (date: string) => Promise<db.CachedEntry[]>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

function newOpId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const pushOps = trpc.sync.push.useMutation();
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const runningRef = useRef(false);
  const lastRunRef = useRef(0);

  const refreshPending = useCallback(async () => {
    const ops = await db.outboxAll();
    setPending(ops.length);
    return ops;
  }, []);

  const syncNow = useCallback(async () => {
    if (runningRef.current) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setOnline(false);
      return;
    }

    runningRef.current = true;
    lastRunRef.current = Date.now();
    setSyncing(true);

    try {
      // 1) Flush anything written while offline.
      const ops = await db.outboxAll();
      if (ops.length > 0) {
        const result = await pushOps.mutateAsync({
          ops: ops.map(({ opId, kind, entryId, contentText, moodLabel, entryDate, clientSavedAt }) => ({
            opId,
            kind,
            entryId,
            contentText,
            moodLabel,
            entryDate,
            clientSavedAt,
          })),
        });
        if (result.applied.length > 0) {
          await db.outboxRemove(result.applied);
        }
        // Failed ops stay queued for the next attempt.
        if (result.failed.length > 0) {
          setLastError(`${result.failed.length} 条待同步内容未成功`);
        }
      }

      // 2) Pull changes made by other devices.
      const since = (await db.metaGet(LAST_SYNC_KEY)) ?? undefined;
      const snapshot = await utils.sync.pull.fetch(
        since ? { since } : {},
      );
      await db.cachePutMany(
        snapshot.entries.map((e) => ({
          id: e.id,
          contentText: e.contentText,
          moodLabel: e.moodLabel ?? null,
          entryDate: e.entryDate,
          createdAt:
            e.createdAt instanceof Date
              ? e.createdAt.toISOString()
              : String(e.createdAt),
          updatedAt:
            e.updatedAt instanceof Date
              ? e.updatedAt.toISOString()
              : String(e.updatedAt),
          deletedAt: e.deletedAt
            ? e.deletedAt instanceof Date
              ? e.deletedAt.toISOString()
              : String(e.deletedAt)
            : null,
          hasImages: e.hasImages,
          includedInDiary: e.includedInDiary,
          attachments: e.attachments ?? [],
        })),
      );
      await db.metaSet(LAST_SYNC_KEY, snapshot.serverTime);
      setLastSyncAt(snapshot.serverTime);

      // 3) Let on-screen queries pick up whatever just landed.
      await utils.entries.list.invalidate();
      setLastError(null);
      setOnline(true);
    } catch (err) {
      setLastError(
        err instanceof Error ? err.message : "同步失败，稍后会重试",
      );
    } finally {
      await refreshPending();
      setSyncing(false);
      runningRef.current = false;
    }
  }, [pushOps, refreshPending, utils]);

  const enqueue = useCallback(
    async (op: Omit<OutboxOp, "opId" | "queuedAt">) => {
      const full: OutboxOp = {
        ...op,
        opId: newOpId(),
        queuedAt: new Date().toISOString(),
      };
      try {
        await db.outboxAdd(full);
      } catch {
        return null;
      }
      await refreshPending();
      return full.opId;
    },
    [refreshPending],
  );

  const readCached = useCallback(async (date: string) => {
    return db.cacheByDate(date);
  }, []);

  // Initial state: pending count + last sync stamp.
  useEffect(() => {
    refreshPending();
    db.metaGet(LAST_SYNC_KEY).then(setLastSyncAt);
  }, [refreshPending]);

  // Network state + recovery triggers.
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const goOffline = () => setOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    // Regaining focus is often the real signal that connectivity is back —
    // phones frequently report "online" before requests actually succeed.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRunRef.current < MIN_MANUAL_GAP_MS) return;
      void syncNow();
    };
    document.addEventListener("visibilitychange", onVisible);

    const timer = window.setInterval(() => {
      void syncNow();
    }, POLL_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [syncNow]);

  return (
    <SyncContext.Provider
      value={{
        online,
        syncing,
        pending,
        lastSyncAt,
        lastError,
        enqueue,
        syncNow,
        readCached,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    throw new Error("useSync must be used inside <SyncProvider>");
  }
  return ctx;
}
