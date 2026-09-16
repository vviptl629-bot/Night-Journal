import { z } from "zod";
import { createRouter, authedQuery } from "../middleware";
import {
  findEntriesSince,
  findLatestEntryUpdate,
  createEntry,
  updateEntry,
  softDeleteEntry,
} from "../queries/entries";

// ─── Why this exists ───────────────────────────────────────────────
//
// Data already lives on the server, so two devices signed into the same
// account share one source of truth. What was missing is everything around
// that: a phone in a subway writes a fragment, the request fails, and the
// words are gone. This router adds the two endpoints that make offline
// survivable — `pull` (incremental snapshot / delta) and `push` (replay of
// operations queued while offline).
//
// Deletion tombstones ride along in `pull` (see findEntriesSince), so a
// fragment deleted on one device does not resurrect on another.

const opInput = z.object({
  /** Client-generated id. Lets the client drop the queue entry on ack. */
  opId: z.string().min(1).max(64),
  kind: z.enum(["create", "update", "delete"]),
  /** Present for update / delete. */
  entryId: z.number().int().positive().optional(),
  contentText: z.string().min(1).max(20000).optional(),
  moodLabel: z.string().max(20).optional(),
  entryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  /** When the user actually hit save offline — used for create dedupe. */
  clientSavedAt: z.string().datetime({ offset: true }).optional(),
});

type SyncOp = z.infer<typeof opInput>;

/**
 * Guard against double-apply: if a replay of the same create slips through
 * (e.g. the first attempt succeeded but the response never arrived), we'd
 * otherwise silently produce two identical fragments.
 */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

async function findRecentDuplicate(
  userId: number,
  op: SyncOp,
): Promise<number | null> {
  if (!op.contentText || !op.entryDate) return null;

  const savedAt = op.clientSavedAt ? new Date(op.clientSavedAt) : new Date();
  const from = new Date(savedAt.getTime() - DEDUPE_WINDOW_MS);

  const recent = await findEntriesSince(userId, from);
  const duplicate = recent.find(
    (e) =>
      e.contentText === op.contentText &&
      e.entryDate === op.entryDate &&
      e.deletedAt === null,
  );
  return duplicate ? duplicate.id : null;
}

export const syncRouter = createRouter({
  /**
   * Incremental snapshot. Pass `since` (ISO) to get only what changed; omit
   * it for a full snapshot the client can cache for offline reads.
   */
  pull: authedQuery
    .input(z.object({ since: z.string().datetime({ offset: true }).optional() }))
    .query(async ({ ctx, input }) => {
      const since = input.since
        ? new Date(input.since)
        : new Date(0);

      const entries = await findEntriesSince(ctx.user.id, since);

      return {
        serverTime: new Date().toISOString(),
        entries: entries.map((e) => ({
          id: e.id,
          contentText: e.contentText,
          moodLabel: e.moodLabel,
          entryDate: e.entryDate,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          deletedAt: e.deletedAt,
          hasImages: e.hasImages,
          includedInDiary: e.includedInDiary,
          attachments: (e.attachments ?? []).map((a) => ({
            fileUrl: a.fileUrl,
            visionStatus: a.visionStatus,
            visionSummary: a.visionSummary,
            visionModelUsed: a.visionModelUsed,
            createdAt: a.createdAt,
          })),
        })),
      };
    }),

  /** Replay operations the client queued while offline. Idempotent-ish. */
  push: authedQuery
    .input(z.object({ ops: z.array(opInput).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const applied: string[] = [];
      const failed: Array<{ opId: string; reason: string }> = [];

      for (const op of input.ops) {
        try {
          if (op.kind === "create") {
            if (!op.contentText || !op.entryDate) {
              failed.push({ opId: op.opId, reason: "missing content or date" });
              continue;
            }

            const existing = await findRecentDuplicate(ctx.user.id, op);
            if (existing !== null) {
              // Already applied — treat as success so the client can drop it.
              applied.push(op.opId);
              continue;
            }

            const created = await createEntry(ctx.user.id, {
              contentText: op.contentText,
              moodLabel: op.moodLabel,
              entryDate: op.entryDate,
            });
            if (!created) {
              failed.push({ opId: op.opId, reason: "create failed" });
              continue;
            }
            applied.push(op.opId);
          } else if (op.kind === "update") {
            if (!op.entryId) {
              failed.push({ opId: op.opId, reason: "missing entryId" });
              continue;
            }
            const updated = await updateEntry(ctx.user.id, op.entryId, {
              contentText: op.contentText,
              moodLabel: op.moodLabel,
            });
            if (!updated) {
              // Entry gone (deleted on another device). Nothing to replay.
              applied.push(op.opId);
              continue;
            }
            applied.push(op.opId);
          } else {
            if (!op.entryId) {
              failed.push({ opId: op.opId, reason: "missing entryId" });
              continue;
            }
            await softDeleteEntry(ctx.user.id, op.entryId);
            applied.push(op.opId);
          }
        } catch (err) {
          failed.push({
            opId: op.opId,
            reason: err instanceof Error ? err.message : "unknown error",
          });
        }
      }

      return { applied, failed, serverTime: new Date().toISOString() };
    }),

  /** Cheap heartbeat: is the server reachable, and how fresh is my data? */
  status: authedQuery.query(async ({ ctx }) => {
    const latest = await findLatestEntryUpdate(ctx.user.id);
    return {
      serverTime: new Date().toISOString(),
      lastEntryUpdate: latest ? latest.toISOString() : null,
    };
  }),
});
