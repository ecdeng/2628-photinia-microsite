# Google Sheets lead mirror

Vercel Blob is the lead inbox. Google Sheets is a view that the application can rebuild from the private Blob records.

See [`inquiry-sheet-sync-design.md`](./inquiry-sheet-sync-design.md) for the architecture decision and rejected alternatives.

The public inquiry route saves a lead before it sends email or mirrors the lead. New leads send email and mirror to Sheets. Retries reuse the persisted lead, skip email, and mirror again. The daily Vercel cron calls the same full reconciliation route that handles the initial backfill.

## Set up the Sheet receiver

1. Open the provided Google Sheet and select **Extensions**, then **Apps Script**.
2. Replace the default script with `google-apps-script/Code.gs` from this repository.
3. In **Project Settings**, add these Script Properties.

	```text
	LEADS_SPREADSHEET_ID=1-kaDZ7j9VU4AaJSdOxXvOQNjqgBaC-oG16B0t9HskCM
	LEADS_SHEET_ID=0
	LEADS_PROPERTY_ID=2628-photinia
	LEADS_WEBHOOK_SECRET=<a new random secret with at least 32 characters>
	```

4. Run `setupLeadsSheet` once. It writes the headers in columns A through H and does not change columns I onward.
5. Deploy the script as a web app. Run it as you and allow access to anyone. The long shared secret protects the endpoint. Copy the `/exec` URL.

The script locks every request, rejects malformed payloads and duplicate receipt IDs, and writes only columns A through H. It prefixes a visitor string that begins with `=`, `+`, `-`, or `@` with an apostrophe so Sheets does not evaluate it as a formula.

Columns A through H are application-owned and daily reconciliation overwrites manual edits. Keep team notes in column I or later.

## Configure Vercel production

Set these environment variables in the Production environment only.

	```text
	GOOGLE_SHEETS_WEBHOOK_URL=<Apps Script /exec URL>
	GOOGLE_SHEETS_WEBHOOK_SECRET=<the Script Property value>
	CRON_SECRET=<a separate random secret with at least 32 characters>
	```

Do not add these variables to Preview or Development. The application sends Google Sheets traffic only when `VERCEL_ENV=production`, which prevents preview forms from writing to the production Sheet.

After deployment, Vercel calls `/api/internal/reconcile-inquiry-sheet` every day at 12:00 UTC. Vercel sends `Authorization: Bearer <CRON_SECRET>` to that route. The route returns 500 when it finds an unreadable or invalid record, or an unacknowledged batch, so Vercel shows a failed run.

## Backfill and verify

1. Deploy the application with the Production variables.
2. In the Vercel dashboard, invoke the cron route with `Authorization: Bearer <CRON_SECRET>`.
3. Confirm that the sheet has one row for each private Blob record under `leads/2628-photinia/`.
4. Submit a marked test inquiry on the production branded site.
5. Confirm the Blob JSON, the Sheet row, and the email alert when Resend is configured.

The webhook replies with one `inserted` or `updated` outcome per receipt ID. The application rejects a response with a missing, duplicate, or unknown receipt ID. A retry can safely repair a failed Sheet write because the receiver upserts by receipt ID.
