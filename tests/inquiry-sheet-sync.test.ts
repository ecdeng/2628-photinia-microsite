import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CapturedInquiry } from "../lib/inquiry-delivery";
import { syncInquirySheet } from "../lib/inquiry-sheet-sync";

const env = {
  VERCEL_ENV: "production",
  GOOGLE_SHEETS_WEBHOOK_URL: "https://script.google.com/macros/s/test/exec",
  GOOGLE_SHEETS_WEBHOOK_SECRET: "test-only-google-sheets-webhook-secret",
};

function lead(receiptId: string): CapturedInquiry {
  return {
    propertyId: "2628-photinia",
    name: "QA Test",
    email: "qa@example.com",
    phone: "",
    message: "This is an authorized delivery test.",
    consent: true,
    receiptId: createHash("sha256").update(receiptId).digest("hex").slice(0, 32),
    capturedAt: "2026-09-18T00:00:00.000Z",
  };
}

function fetchWith(outcomes: ReadonlyArray<Readonly<{ receiptId: string; outcome: "inserted" | "updated" }>>, status = 200): typeof fetch {
  return async (_input, init) => {
    assert.equal(init?.method, "POST");
    return Response.json({ version: 1, outcomes }, { status });
  };
}

test("skips direct sync when production-only configuration is absent", async () => {
  const result = await syncInquirySheet({ kind: "one", inquiry: lead("one") }, { env: {} });
  assert.deepEqual(result, { kind: "one", status: "skipped", candidates: 0, inserted: 0, updated: 0, invalid: 0, failures: 0 });
});

test("never sends a preview lead to the production Sheet", async () => {
  let calls = 0;
  const result = await syncInquirySheet({ kind: "one", inquiry: lead("preview") }, {
    env: { ...env, VERCEL_ENV: "preview" },
    fetch: async () => {
      calls++;
      return Response.json({ version: 1, outcomes: [] });
    },
  });
  assert.equal(result.status, "skipped");
  assert.equal(calls, 0);
});

test("syncs one immutable inquiry through the versioned webhook", async () => {
  const inquiry = lead("one");
  const result = await syncInquirySheet({ kind: "one", inquiry: lead("one") }, {
    env,
    fetch: fetchWith([{ receiptId: inquiry.receiptId, outcome: "inserted" }]),
  });
  assert.deepEqual(result, { kind: "one", status: "synced", candidates: 1, inserted: 1, updated: 0, invalid: 0, failures: 0 });
});

test("treats network, non-success, and malformed webhook responses as failures", async () => {
  const network = await syncInquirySheet({ kind: "one", inquiry: lead("network") }, {
    env,
    fetch: async () => { throw new Error("offline"); },
  });
  const nonSuccess = await syncInquirySheet({ kind: "one", inquiry: lead("non-success") }, {
    env,
    fetch: fetchWith([], 503),
  });
  const malformed = await syncInquirySheet({ kind: "one", inquiry: lead("malformed") }, {
    env,
    fetch: async () => Response.json({ version: 1, outcomes: "nope" }),
  });
  assert.equal(network.status, "failed");
  assert.equal(nonSuccess.status, "failed");
  assert.equal(malformed.status, "failed");
  assert.equal(network.failures, 1);
  assert.equal(nonSuccess.failures, 1);
  assert.equal(malformed.failures, 1);
});

test("times out a stalled webhook request", async () => {
  const result = await syncInquirySheet({ kind: "one", inquiry: lead("timeout") }, {
    env,
    timeoutMs: 1,
    fetch: async (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failures, 1);
});

test("requires an exact one-to-one acknowledgement set", async () => {
  const inquiry = lead("one");
  const cases: ReadonlyArray<ReadonlyArray<Readonly<{ receiptId: string; outcome: "inserted" | "updated" }>>> = [
    [],
    [{ receiptId: "unexpected", outcome: "inserted" }],
    [{ receiptId: inquiry.receiptId, outcome: "inserted" }, { receiptId: inquiry.receiptId, outcome: "updated" }],
  ];
  for (const outcomes of cases) {
    const result = await syncInquirySheet({ kind: "one", inquiry }, { env, fetch: fetchWith(outcomes) });
    assert.equal(result.status, "failed");
  }
});

test("reconciles paginated flat and dated paths in batches of fifty", async () => {
  const records = Array.from({ length: 51 }, (_, index) => lead(`receipt-${index}`));
  const calls: Array<ReadonlyArray<string>> = [];
  const result = await syncInquirySheet({ kind: "all", propertyId: "2628-photinia" }, {
    env,
    list: async ({ cursor }) => cursor
      ? { blobs: records.slice(50).map((record) => ({ pathname: `leads/2628-photinia/${record.receiptId}.json` })), hasMore: false }
      : { blobs: records.slice(0, 50).map((record, index) => ({ pathname: index === 0 ? `leads/2628-photinia/2026-09-18/${record.receiptId}.json` : `leads/2628-photinia/${record.receiptId}.json` })), hasMore: true, cursor: "next" },
    read: async (pathname) => records.find((record) => pathname.endsWith(`${record.receiptId}.json`)) ?? null,
    fetch: async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      const parsed: unknown = JSON.parse(init.body);
      if (typeof parsed !== "object" || parsed === null || !("leads" in parsed) || !Array.isArray(parsed.leads)) throw new Error("Expected leads");
      const receiptIds = parsed.leads.map((item) => {
        if (typeof item !== "object" || item === null || !("receiptId" in item) || typeof item.receiptId !== "string") throw new Error("Expected receipt ID");
        return item.receiptId;
      });
      calls.push(receiptIds);
      return Response.json({ version: 1, outcomes: receiptIds.map((receiptId) => ({ receiptId, outcome: "updated" })) });
    },
  });
  assert.equal(result.status, "synced");
  assert.equal(result.candidates, 51);
  assert.equal(result.updated, 51);
  assert.deepEqual(calls.map((call) => call.length), [50, 1]);
});

test("isolates unreadable and invalid Blob records during reconciliation", async () => {
  const good = lead("good");
  const result = await syncInquirySheet({ kind: "all", propertyId: "2628-photinia" }, {
    env,
    list: async () => ({
      blobs: [
        { pathname: "leads/2628-photinia/good.json" },
        { pathname: "leads/2628-photinia/bad.json" },
        { pathname: "leads/2628-photinia/unreadable.json" },
      ],
      hasMore: false,
    }),
    read: async (pathname) => {
      if (pathname.endsWith("good.json")) return good;
      if (pathname.endsWith("bad.json")) return { receiptId: "bad" };
      throw new Error("unavailable");
    },
    fetch: fetchWith([{ receiptId: good.receiptId, outcome: "inserted" }]),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.inserted, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.failures, 2);
});
