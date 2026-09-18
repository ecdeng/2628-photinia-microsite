import assert from "node:assert/strict";
import test from "node:test";
import { afterInquiryStored, POST } from "../app/api/inquiry/route";
import { handleInquiryRequest, InquiryConflictError, type CapturedInquiry, type StoredInquiry } from "../lib/inquiry-delivery";

const validInquiry = {
  propertyId: "2628-photinia",
  name: "QA Test",
  email: "qa@example.com",
  phone: "",
  message: "This is an authorized delivery test.",
  consent: true,
  submissionId: "b0c7c99c-7718-4e0a-9daf-0c04567cb408",
};

function request(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/inquiry", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-requested-with": "fetch" },
    body: JSON.stringify(body),
  });
}

function delivery(store: (inquiry: CapturedInquiry) => Promise<void | StoredInquiry>) {
  return {
    propertyId: validInquiry.propertyId,
    createReceiptId: (submissionId: string) => `receipt-${submissionId}`,
    store: async (inquiry: CapturedInquiry): Promise<StoredInquiry> => (await store(inquiry)) ?? { disposition: "created", inquiry },
  };
}

test("rejects invalid inquiries", async () => {
  const response = await handleInquiryRequest(request({ name: "A" }), delivery(async () => undefined));
  assert.equal(response.status, 400);
});

test("rejects cross-origin submissions", async () => {
  const response = await handleInquiryRequest(request(validInquiry, "https://example.com"), delivery(async () => undefined));
  assert.equal(response.status, 403);
});

test("fails visibly when durable delivery is not configured", async () => {
  const previous = process.env.INQUIRY_RECEIPT_SECRET;
  delete process.env.INQUIRY_RECEIPT_SECRET;
  try {
    const response = await POST(request(validInquiry));
    assert.equal(response.status, 503);
  } finally {
    if (previous) process.env.INQUIRY_RECEIPT_SECRET = previous;
    else delete process.env.INQUIRY_RECEIPT_SECRET;
  }
});

test("stores a validated inquiry before post-storage work", async () => {
  const events: string[] = [];
  let captured: CapturedInquiry | undefined;
  const response = await handleInquiryRequest(request(validInquiry), {
    ...delivery(async (inquiry) => {
      captured = inquiry;
      events.push("stored");
    }),
    afterStored: async () => {
      events.push("after_stored");
    },
  });
  const payload: unknown = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(events, ["stored", "after_stored"]);
  assert.equal(captured?.propertyId, "2628-photinia");
  assert.equal(captured?.receiptId, `receipt-${validInquiry.submissionId}`);
  assert.equal(typeof payload === "object" && payload !== null && "receiptId" in payload, true);
});

test("does not lose a captured inquiry when post-storage work fails", async () => {
  let stored = false;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const response = await handleInquiryRequest(request(validInquiry), {
      ...delivery(async (inquiry) => { stored = true; return { disposition: "created", inquiry }; }),
      afterStored: async () => { throw new Error("mail unavailable"); },
    });
    assert.equal(response.status, 201);
    assert.equal(stored, true);
  } finally {
    console.error = originalError;
  }
});

test("silently discards honeypot submissions", async () => {
  let stored = false;
  const response = await handleInquiryRequest(request({ ...validInquiry, website: "spam.example" }), {
    ...delivery(async () => { stored = true; }),
  });
  assert.equal(response.status, 201);
  assert.equal(stored, false);
});

test("rejects a property identifier that is not the server-configured listing", async () => {
  let stored = false;
  const response = await handleInquiryRequest(request({ ...validInquiry, propertyId: "another-listing" }), {
    ...delivery(async () => { stored = true; }),
  });
  assert.equal(response.status, 400);
  assert.equal(stored, false);
});

test("duplicate retries run post-storage work with the canonical record", async () => {
  let postStoreCalls = 0;
  const response = await handleInquiryRequest(request(validInquiry), {
    ...delivery(async (inquiry) => ({ disposition: "existing", inquiry: { ...inquiry, capturedAt: "2026-09-18T00:00:00.000Z" } })),
    afterStored: async (stored) => {
      postStoreCalls++;
      assert.equal(stored.disposition, "existing");
      assert.equal(stored.inquiry.capturedAt, "2026-09-18T00:00:00.000Z");
    },
  });
  assert.equal(response.status, 201);
  assert.equal(postStoreCalls, 1);
});

test("post-storage composition syncs duplicate leads without sending duplicate email", async () => {
  let sheetCalls = 0;
  let emailCalls = 0;
  const existingInquiry: CapturedInquiry = {
    propertyId: "2628-photinia",
    name: "QA Test",
    email: "qa@example.com",
    phone: "",
    message: "This is an authorized delivery test.",
    consent: true,
    receiptId: "receipt",
    capturedAt: "2026-09-18T00:00:00.000Z",
  };
  const stored: StoredInquiry = {
    disposition: "existing",
    inquiry: existingInquiry,
  };
  await afterInquiryStored(stored, {
    sync: async () => { sheetCalls++; },
    notify: async () => { emailCalls++; },
  });
  assert.equal(sheetCalls, 1);
  assert.equal(emailCalls, 0);
});

test("post-storage composition syncs and notifies a new lead", async () => {
  let sheetCalls = 0;
  let emailCalls = 0;
  const inquiry: CapturedInquiry = {
    propertyId: "2628-photinia",
    name: "QA Test",
    email: "qa@example.com",
    phone: "",
    message: "This is an authorized delivery test.",
    consent: true,
    receiptId: "receipt",
    capturedAt: "2026-09-18T00:00:00.000Z",
  };
  await afterInquiryStored({ disposition: "created", inquiry }, {
    sync: async () => { sheetCalls++; },
    notify: async () => { emailCalls++; },
  });
  assert.equal(sheetCalls, 1);
  assert.equal(emailCalls, 1);
});

test("storage failure never reports success and conflicting retries return 409", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await handleInquiryRequest(request(validInquiry), delivery(async () => { throw new Error("offline"); }))).status, 503);
    assert.equal((await handleInquiryRequest(request(validInquiry), delivery(async () => { throw new InquiryConflictError(); }))).status, 409);
  } finally { console.error = originalError; }
});
