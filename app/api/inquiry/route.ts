import { checkBotId } from "botid/server";
import { after } from "next/server";
import { handleInquiryRequest, type CapturedInquiry, type StoredInquiry } from "@/lib/inquiry-delivery";
import { inquiryCaptureEnabled } from "@/lib/inquiry-config";
import { receiptIdFor, storeInquiry, writePrivateJson } from "@/lib/inquiry-storage";
import { sendInquiryNotification } from "@/lib/inquiry-notifications";
import { syncInquirySheet } from "@/lib/inquiry-sheet-sync";
import listingJson from "@/content/listing.json";
import { generatedListingSchema } from "@/lib/site-content";

export const runtime = "nodejs";
export const maxDuration = 60;
const listing = generatedListingSchema.parse(listingJson);

type PostStoreDependencies = Readonly<{
  sync: (inquiry: CapturedInquiry) => Promise<void>;
  notify: (inquiry: CapturedInquiry) => Promise<void>;
}>;

async function notifyListingTeam(inquiry: CapturedInquiry) {
  const result = await sendInquiryNotification(inquiry, listing.identity.street);
  await writePrivateJson(`notifications/${inquiry.propertyId}/${inquiry.receiptId}.json`, {
    receiptId: inquiry.receiptId, recordedAt: new Date().toISOString(), ...result,
  });
  if (result.status !== "sent") console.error("inquiry_notification_needs_attention", { receiptId: inquiry.receiptId });
}

export async function afterInquiryStored(
  stored: StoredInquiry,
  dependencies: PostStoreDependencies = {
    sync: async (inquiry) => {
      const result = await syncInquirySheet({ kind: "one", inquiry });
      if (result.status === "failed") throw new Error("Sheet synchronization failed");
    },
    notify: notifyListingTeam,
  },
) {
  const receiptId = stored.inquiry.receiptId;
  const channels: Array<Promise<void>> = [
    dependencies.sync(stored.inquiry).catch(() => console.error("inquiry_sheet_sync_failed", { receiptId })),
  ];
  if (stored.disposition === "created") {
    channels.push(dependencies.notify(stored.inquiry).catch(() => console.error("inquiry_notification_unresolved", { receiptId })));
  }
  await Promise.all(channels);
}

export async function POST(request: Request) {
  if (!inquiryCaptureEnabled()) return Response.json({ error: "Inquiry delivery is not configured" }, { status: 503 });
  const verification = await checkBotId({ advancedOptions: { checkLevel: "basic" } });
  if (verification.isBot) return Response.json({ error: "Unable to verify this submission" }, { status: 403 });
  return handleInquiryRequest(request, {
    propertyId: listing.id,
    createReceiptId: (id) => receiptIdFor(listing.id, id, process.env.INQUIRY_RECEIPT_SECRET!),
    store: storeInquiry,
    afterStored: afterInquiryStored,
    defer: (task) => after(task),
  });
}
