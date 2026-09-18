import assert from "node:assert/strict";
import test from "node:test";
import { handleReconcileInquirySheetRequest } from "../app/api/internal/reconcile-inquiry-sheet/route";

function request(token?: string) {
  return new Request("https://2628photinia.com/api/internal/reconcile-inquiry-sheet", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test("reconciliation rejects missing and incorrect bearer tokens", async () => {
  for (const token of [undefined, "wrong"]) {
    const response = await handleReconcileInquirySheetRequest(request(token), { secret: "correct" });
    assert.equal(response.status, 401);
  }
});

test("reconciliation reports an unresolved projection as a server failure", async () => {
  const response = await handleReconcileInquirySheetRequest(request("correct"), {
    secret: "correct",
    reconcile: async () => ({ kind: "all", status: "failed", candidates: 2, inserted: 1, updated: 0, invalid: 0, failures: 1 }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    status: "failed",
    candidates: 2,
    inserted: 1,
    updated: 0,
    invalid: 0,
    failures: 1,
  });
});
