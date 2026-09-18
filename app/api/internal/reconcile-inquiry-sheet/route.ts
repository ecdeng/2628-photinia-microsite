import listingJson from "@/content/listing.json";
import { generatedListingSchema } from "@/lib/site-content";
import { syncInquirySheet, type InquirySheetSyncResult } from "@/lib/inquiry-sheet-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

const listing = generatedListingSchema.parse(listingJson);

type ReconcileDependencies = Readonly<{
  secret?: string;
  reconcile?: () => Promise<InquirySheetSyncResult>;
}>;

function response(result: InquirySheetSyncResult, status: number) {
  return Response.json({
    status: result.status,
    candidates: result.candidates,
    inserted: result.inserted,
    updated: result.updated,
    invalid: result.invalid,
    failures: result.failures,
  }, { status });
}

export async function handleReconcileInquirySheetRequest(request: Request, dependencies: ReconcileDependencies = {}) {
  const secret = dependencies.secret ?? process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const reconcile = dependencies.reconcile ?? (() => syncInquirySheet({ kind: "all", propertyId: listing.id }));
  const result = await reconcile();
  return response(result, result.status === "synced" ? 200 : 500);
}

export async function GET(request: Request) {
  return handleReconcileInquirySheetRequest(request);
}
