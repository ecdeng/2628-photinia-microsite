import assert from "node:assert/strict";
import test from "node:test";
import { receiptIdFor, inquiryPath, storeInquiry } from "../lib/inquiry-storage";
import { InquiryConflictError, type CapturedInquiry } from "../lib/inquiry-delivery";

const lead: CapturedInquiry = { propertyId: "2628-photinia", name: "QA Test", email: "qa@example.com", message: "Test inquiry", consent: true, receiptId: "0123456789abcdef0123456789abcdef", capturedAt: "2026-09-18T00:00:00.000Z" };
test("receipt signatures are stable and independent of Blob credentials", () => {
  const secret = "test-only-32-characters-or-longer-secret";
  assert.equal(receiptIdFor("property", "submission", secret), receiptIdFor("property", "submission", secret));
  assert.notEqual(receiptIdFor("property", "submission", secret), receiptIdFor("other", "submission", secret));
  assert.throws(() => receiptIdFor("property", "submission", "short"));
});
test("retries across midnight do not create a new path or overwrite", async () => {
  const nextDay = { ...lead, capturedAt: "2026-09-19T00:00:00.000Z" };
  assert.equal(inquiryPath(lead), inquiryPath(nextDay));
  const storage = { write: async () => { throw new Error("exists"); }, read: async () => lead };
  assert.deepEqual(await storeInquiry(nextDay, storage), { disposition: "existing", inquiry: lead });
  await assert.rejects(storeInquiry({ ...nextDay, message: "changed" }, storage), InquiryConflictError);
});
test("a new write returns the record that durable storage accepted", async () => {
  const stored = await storeInquiry(lead, {
    write: async () => undefined,
    read: async () => null,
  });
  assert.deepEqual(stored, { disposition: "created", inquiry: lead });
});
test("failed writes without a record remain failures", async () => {
  await assert.rejects(storeInquiry(lead, { write: async () => { throw new Error("offline"); }, read: async () => null }), /offline/);
});
