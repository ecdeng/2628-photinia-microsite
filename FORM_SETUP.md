# Inquiry form setup and operations

The branded `/` route can accept buyer inquiries. The `/mls` route never receives the inquiry or agent-contact model and does not render a form.

## Delivery model

Every valid inquiry follows this order:

1. `/api/inquiry` validates the fields, origin, property ID, consent, and request size.
2. Vercel Basic BotID and a hidden honeypot reduce automated submissions.
3. The server writes the complete inquiry to a **private Vercel Blob store**.
4. After durable storage succeeds, the form resets without displaying confirmation text. The API still returns a receipt ID for internal tracing.
5. If Resend is configured, the server then sends an email notification with the buyer as the reply-to address.
6. If the Google Sheets mirror is configured in Production, the server posts the record to the Sheet receiver. A daily reconciliation retries every authoritative Blob record.

Blob is the system of record. Resend is only a notification channel. Google Sheets is a rebuildable view. If either channel is unavailable, the lead remains stored.

## Google Sheets mirror

The mirror runs only in Production. Do not configure it for Preview or Development because preview traffic must never write to the production Sheet. Use [`docs/inquiry-sheet-sync.md`](./docs/inquiry-sheet-sync.md) to install the Apps Script receiver, add the production variables, backfill existing Blob records, and verify the full path.

## 1. Connect private lead storage

In the Vercel project:

1. Open **Storage** and create or connect a Blob store.
2. Choose **Private** access.
3. Connect it to the Production environment. Add Preview and Development only if test submissions should use the same store.
4. Confirm that Vercel created `BLOB_STORE_ID`. The SDK uses Vercel's short-lived OIDC identity; no static Blob token is required. A legacy `BLOB_READ_WRITE_TOKEN` also remains supported for local/legacy setups.
5. Add a random, server-only `INQUIRY_RECEIPT_SECRET` of at least 32 characters. Keep it stable across deployments; rotating it changes retry IDs. Do not use the store ID, webhook public key, or an OIDC token as this secret.
6. Redeploy the project after changing environment variables.

The branded page and endpoint share one configuration check: a Blob store ID or legacy token plus the dedicated receipt secret. Missing configuration keeps the direct phone/email fallback. Store access is verified by the actual write, not merely by the presence of a variable. The SDK already supports OIDC in the locked dependency version.

Preview capture is disabled by default even if the production store is connected there. Only set `INQUIRY_PREVIEW_ENABLED=true` after connecting a separate private test store. Do not attach production email recipients to preview testing.

Lead records are stored under:

```text
leads/2628-photinia/<receipt-id>.json
```

They are private and must not be exposed through a public Blob URL.

Existing records under dated directories remain untouched. New keys omit the date so a retry across midnight cannot create a second lead. Creates use `allowOverwrite: false`; identical retries acknowledge the original without changing its timestamp or sending another notification. A changed payload with the same submission ID is rejected. The browser generates a new ID when the visitor edits a failed submission.

## 2. Add optional email alerts with Resend

Use a direct Resend account; a paid Vercel Marketplace integration is not required.

1. Add and verify a sending domain in Resend. Complete the DNS records Resend provides.
2. Create a sending API key for this site.
3. Add these Production environment variables in Vercel:

```text
RESEND_API_KEY=re_...
LEAD_NOTIFICATION_TO=andre.wang@compass.com
LEAD_NOTIFICATION_FROM=2628 Photinia <inquiries@verified-domain.example>
LEAD_NOTIFICATION_SUBJECT=New inquiry for 2628 Photinia Court
```

`LEAD_NOTIFICATION_TO` accepts one or more comma-separated addresses. `LEAD_NOTIFICATION_FROM` must use the domain verified in Resend. Keep all secrets in Vercel; never commit them or paste them into a pull request.

Andre is the sole approved recipient for now. Configure a verified sender and API key before relying on email alerts. Incomplete configuration still allows durable capture but records `not_configured`; it does not silently claim to send email.

Network errors, HTTP 429, and 5xx responses receive up to three attempts with the same provider idempotency key. Permanent errors stop immediately. A successful API response means provider acceptance, not proof of inbox delivery. The result is stored separately at `notifications/2628-photinia/<receipt-id>.json` with status, attempts, timestamp, and a non-sensitive reason code. Lead contents are never logged.

After a hard function interruption, an outcome may be absent even though the lead was saved or email was accepted. Do not blindly resend: check Resend delivery records first. Duplicate browser retries do not re-run notifications. This is bounded retry, not a durable background queue.

Run `node scripts/check-inquiry-notifications.mjs` in an authorized environment to list unresolved, failed, or unconfigured receipt IDs (exit code 2 means attention required). It does not read buyer JSON or send email. Someone must run this reconciliation regularly, particularly while email is unconfigured. No automatic monitor or email queue has been provisioned.

## 3. Production acceptance test

After every storage, notification, domain, or recipient change:

1. Open the production branded route, not `/mls`.
2. Submit a lead named `QA TEST — DELETE` using an inbox the tester controls.
3. Save the receipt ID from the `/api/inquiry` response in browser developer tools (Network tab). Successful submission resets the form without showing confirmation text.
4. In the Vercel Blob browser, locate the JSON record whose filename matches that receipt ID.
5. Confirm the stored name, email, phone, message, property ID, consent, and timestamp.
6. When Resend is enabled, confirm the notification reached every intended recipient and that Reply uses the test buyer address.
7. Delete only the clearly marked test record. Never delete a real inquiry during QA.
8. Recheck `/mls`: it must contain no form, phone number, email address, brokerage mark, or agent profile.

A browser success message alone is not proof that the listing team received an alert. Verify both the Blob record and, when enabled, the email notification.

## 4. Local testing

Link the checkout to the correct Vercel project and pull development variables:

```sh
vercel link
vercel env pull .env.local
npm ci
npm run dev
```

`.env.local` is ignored by Git and must remain uncommitted. For automated verification:

```sh
npm run check
npx playwright install chromium webkit
npm run e2e
```

The automated inquiry tests mock external delivery. Production acceptance testing is still required.

## 5. Ownership before launch

Assign and document:

- the person responsible for checking the Blob store when an email alert fails;
- the approved notification recipients and the owner of the verified sending domain;
- who can access stored lead data;
- the retention period for real inquiries;
- the process for locating and deleting a lead by receipt ID; and
- who monitors Vercel function logs and Resend delivery failures.

Automatic deletion remains disabled at the owner's explicit request. Private Blob preserves the lead. The Google Sheets mirror can rebuild from Blob records, while operator reconciliation handles email notifications that remain unresolved after bounded retries. Restrict store access to those responsible for inquiries, and do not expose the store or an unauthenticated lead-reading endpoint.
