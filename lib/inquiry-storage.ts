import { get, put } from "@vercel/blob";
import { createHmac } from "node:crypto";
import { InquiryConflictError, inquirySchema, type CapturedInquiry, type StoredInquiry } from "./inquiry-delivery";
import { z } from "zod";

export const storedInquirySchema = inquirySchema.omit({ website: true, submissionId: true }).extend({
  receiptId: z.string().regex(/^[a-f0-9]{32}$/),
  capturedAt: z.iso.datetime(),
});

type InquiryStorage = Readonly<{
  write: (path: string, value: unknown) => Promise<unknown>;
  read: (path: string) => Promise<unknown | null>;
}>;

export function receiptIdFor(propertyId: string, submissionId: string, secret: string) {
  if (secret.trim().length < 32) throw new Error("Receipt signing secret is not configured");
  return createHmac("sha256", secret).update(`${propertyId}:${submissionId}`).digest("hex").slice(0, 32);
}

export function inquiryPath(inquiry: Pick<CapturedInquiry, "propertyId" | "receiptId">) {
  return `leads/${inquiry.propertyId}/${inquiry.receiptId}.json`;
}

export function sameInquiry(a: CapturedInquiry, b: CapturedInquiry) {
  return a.receiptId === b.receiptId && a.propertyId === b.propertyId &&
    a.name === b.name && a.email === b.email && (a.phone ?? "") === (b.phone ?? "") &&
    a.message === b.message && a.consent === b.consent;
}

export async function readPrivateJson(path: string): Promise<unknown | null> {
  const result = await get(path, { access: "private", useCache: false });
  if (!result) return null;
  if (result.statusCode !== 200) throw new Error("Unexpected private storage response");
  return new Response(result.stream).json();
}

export async function writePrivateJson(path: string, value: unknown) {
  return put(path, `${JSON.stringify(value, null, 2)}\n`, {
    access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json",
  });
}

export async function storeInquiry(
  inquiry: CapturedInquiry,
  storage: InquiryStorage = { write: writePrivateJson, read: readPrivateJson },
): Promise<StoredInquiry> {
  const path = inquiryPath(inquiry);
  try {
    await storage.write(path, inquiry);
    return { disposition: "created", inquiry };
  } catch (writeError) {
    const existing = await storage.read(path);
    if (!existing) throw writeError;
    const persisted = storedInquirySchema.parse(existing);
    if (!sameInquiry(persisted, inquiry)) throw new InquiryConflictError();
    return { disposition: "existing", inquiry: persisted };
  }
}
