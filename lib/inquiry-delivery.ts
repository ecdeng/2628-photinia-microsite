import { z } from "zod";

const MAX_BODY_BYTES = 16_384;

export const inquirySchema = z.object({
  propertyId: z.string().min(1).max(120),
  name: z.string().trim().min(2).max(120),
  email: z.email().max(254),
  phone: z.string().trim().max(40).optional(),
  message: z.string().trim().min(5).max(3000),
  consent: z.literal(true),
  submissionId: z.uuid(),
  website: z.string().max(200).optional(),
});

export type InquiryPayload = z.infer<typeof inquirySchema>;
export type CapturedInquiry = Omit<InquiryPayload, "website" | "submissionId"> & Readonly<{
  receiptId: string;
  capturedAt: string;
}>;

export type StoredInquiry = Readonly<{
  disposition: "created" | "existing";
  inquiry: CapturedInquiry;
}>;

export type InquiryDelivery = Readonly<{
  propertyId: string;
  createReceiptId: (submissionId: string) => string;
  store: (inquiry: CapturedInquiry) => Promise<StoredInquiry>;
  afterStored?: (stored: StoredInquiry) => Promise<void>;
  defer?: (task: () => Promise<void>) => void;
}>;

export class InquiryConflictError extends Error {}

function error(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function handleInquiryRequest(request: Request, delivery: InquiryDelivery) {
  if (request.headers.get("x-requested-with") !== "fetch") {
    return error("Invalid request", 403);
  }

  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return error("Invalid request origin", 403);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return error("Inquiry is too large", 413);

  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return error("Inquiry is too large", 413);

  let json: unknown;
  try {
    json = JSON.parse(body || "null");
  } catch {
    return error("Invalid inquiry", 400);
  }

  const parsed = inquirySchema.safeParse(json);
  if (!parsed.success) return error("Invalid inquiry", 400);

  if (parsed.data.propertyId !== delivery.propertyId) {
    return error("Invalid property", 400);
  }

  const receiptId = delivery.createReceiptId(parsed.data.submissionId);

  if (parsed.data.website) {
    return Response.json({ receiptId }, { status: 201 });
  }

  const { website: _website, submissionId: _submissionId, ...inquiry } = parsed.data;
  void _website;
  void _submissionId;
  const captured: CapturedInquiry = {
    ...inquiry,
    receiptId,
    capturedAt: new Date().toISOString(),
  };

  let stored: StoredInquiry;
  try {
    stored = await delivery.store(captured);
  } catch (cause) {
    if (cause instanceof InquiryConflictError) return error("Submission ID already used for another inquiry", 409);
    console.error("inquiry_storage_failed", { receiptId });
    return error("Unable to save inquiry. Please retry or contact the listing team directly.", 503);
  }

  if (delivery.afterStored) {
    const afterStored = async () => {
      try {
        await delivery.afterStored?.(stored);
      } catch {
        console.error("inquiry_post_store_failed", { receiptId });
      }
    };
    if (delivery.defer) delivery.defer(afterStored);
    else await afterStored();
  }

  return Response.json({ receiptId: stored.inquiry.receiptId }, { status: 201 });
}
