import { list } from "@vercel/blob";
import { z } from "zod";
import { inquirySheetSyncEnabled } from "./inquiry-config";
import type { CapturedInquiry } from "./inquiry-delivery";
import { readPrivateJson, storedInquirySchema } from "./inquiry-storage";

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 8_000;

type Environment = Readonly<Record<string, string | undefined>>;

type BlobPage = Readonly<{
  blobs: ReadonlyArray<Readonly<{ pathname: string }>>;
  hasMore: boolean;
  cursor?: string;
}>;

type SheetSyncDependencies = Readonly<{
  env?: Environment;
  fetch?: typeof fetch;
  list?: (options: Readonly<{ prefix: string; cursor?: string }>) => Promise<BlobPage>;
  read?: (pathname: string) => Promise<unknown | null>;
  timeoutMs?: number;
}>;

export type InquirySheetSyncCommand =
  | Readonly<{ kind: "one"; inquiry: CapturedInquiry }>
  | Readonly<{ kind: "all"; propertyId: string }>;

export type InquirySheetSyncResult = Readonly<{
  kind: InquirySheetSyncCommand["kind"];
  status: "synced" | "skipped" | "failed";
  candidates: number;
  inserted: number;
  updated: number;
  invalid: number;
  failures: number;
}>;

type SyncChanges = Partial<Pick<InquirySheetSyncResult, "candidates" | "inserted" | "updated" | "invalid">>;

type SheetOutcome = Readonly<{
  receiptId: string;
  outcome: "inserted" | "updated";
}>;

const responseSchema = z.object({
  version: z.literal(1),
  outcomes: z.array(z.object({ receiptId: z.string().min(1), outcome: z.enum(["inserted", "updated"]) }).strict()),
}).strict();

function initialResult(kind: InquirySheetSyncCommand["kind"]): InquirySheetSyncResult {
  return { kind, status: "synced", candidates: 0, inserted: 0, updated: 0, invalid: 0, failures: 0 };
}

function failed(result: InquirySheetSyncResult, changes: SyncChanges = {}): InquirySheetSyncResult {
  return { ...result, ...changes, status: "failed", failures: result.failures + 1 };
}

function merge(result: InquirySheetSyncResult, changes: SyncChanges): InquirySheetSyncResult {
  return { ...result, ...changes };
}

function configuredSheet(env: Environment) {
  if (!inquirySheetSyncEnabled(env)) return null;
  const url = env.GOOGLE_SHEETS_WEBHOOK_URL?.trim();
  const secret = env.GOOGLE_SHEETS_WEBHOOK_SECRET?.trim();
  if (!url || !secret) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { url, secret };
}

function acknowledgementsFor(leads: ReadonlyArray<CapturedInquiry>, value: unknown): ReadonlyArray<SheetOutcome> | null {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success || parsed.data.outcomes.length !== leads.length) return null;
  const expected = new Set(leads.map((lead) => lead.receiptId));
  if (expected.size !== leads.length) return null;
  const acknowledged = new Set<string>();
  for (const outcome of parsed.data.outcomes) {
    if (!expected.has(outcome.receiptId) || acknowledged.has(outcome.receiptId)) return null;
    acknowledged.add(outcome.receiptId);
  }
  return acknowledged.size === expected.size ? parsed.data.outcomes : null;
}

async function postLeads(
  leads: ReadonlyArray<CapturedInquiry>,
  config: Readonly<{ url: string; secret: string }>,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<ReadonlyArray<SheetOutcome> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(config.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, secret: config.secret, leads }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return acknowledgementsFor(leads, await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function recordOutcomes(result: InquirySheetSyncResult, outcomes: ReadonlyArray<SheetOutcome> | null): InquirySheetSyncResult {
  if (!outcomes) return failed(result);
  return merge(result, {
    inserted: result.inserted + outcomes.filter((outcome) => outcome.outcome === "inserted").length,
    updated: result.updated + outcomes.filter((outcome) => outcome.outcome === "updated").length,
  });
}

async function syncBatch(
  result: InquirySheetSyncResult,
  leads: ReadonlyArray<CapturedInquiry>,
  config: Readonly<{ url: string; secret: string }>,
  fetcher: typeof fetch,
  timeoutMs: number,
) {
  return recordOutcomes(result, await postLeads(leads, config, fetcher, timeoutMs));
}

export async function syncInquirySheet(
  command: InquirySheetSyncCommand,
  dependencies: SheetSyncDependencies = {},
): Promise<InquirySheetSyncResult> {
  const env = dependencies.env ?? process.env;
  const config = configuredSheet(env);
  if (!config) return { ...initialResult(command.kind), status: "skipped" };
  const fetcher = dependencies.fetch ?? fetch;
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;

  if (command.kind === "one") {
    const parsed = storedInquirySchema.safeParse(command.inquiry);
    if (!parsed.success) return failed(initialResult(command.kind), { invalid: 1 });
    const result = merge(initialResult(command.kind), { candidates: 1 });
    return syncBatch(result, [parsed.data], config, fetcher, timeoutMs);
  }

  const read = dependencies.read ?? readPrivateJson;
  const listBlobs = dependencies.list ?? list;
  const prefix = `leads/${command.propertyId}/`;
  const seenReceipts = new Set<string>();
  let batch: CapturedInquiry[] = [];
  let result = initialResult(command.kind);
  let cursor: string | undefined;

  for (;;) {
    let page: BlobPage;
    try {
      page = await listBlobs(cursor ? { prefix, cursor } : { prefix });
    } catch {
      return failed(result);
    }

    for (const blob of page.blobs) {
      let raw: unknown | null;
      try {
        raw = await read(blob.pathname);
      } catch {
        result = failed(result);
        continue;
      }
      const parsed = storedInquirySchema.safeParse(raw);
      if (!parsed.success || parsed.data.propertyId !== command.propertyId || seenReceipts.has(parsed.data.receiptId)) {
        result = failed(merge(result, { invalid: result.invalid + 1 }));
        continue;
      }
      seenReceipts.add(parsed.data.receiptId);
      batch.push(parsed.data);
      if (batch.length === BATCH_SIZE) {
        result = merge(result, { candidates: result.candidates + batch.length });
        result = await syncBatch(result, batch, config, fetcher, timeoutMs);
        batch = [];
      }
    }

    if (!page.hasMore) break;
    if (!page.cursor) return failed(result);
    cursor = page.cursor;
  }

  if (batch.length > 0) {
    result = merge(result, { candidates: result.candidates + batch.length });
    result = await syncBatch(result, batch, config, fetcher, timeoutMs);
  }
  return result.failures > 0 ? { ...result, status: "failed" } : result;
}
