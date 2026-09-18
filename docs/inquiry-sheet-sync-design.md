# Why lead sync is Blob-first

## Problem

The inquiry endpoint must never report success before it stores a lead. Google Sheets is useful for the listing team, but it is not a durable request queue. The design keeps private Vercel Blob as the source of truth and makes the Sheet a view that the application can rebuild.

A retry creates a new request-time timestamp. The stored Blob keeps the first timestamp. Post-storage work must therefore receive the canonical stored record instead of the retry candidate.

## Caller view

The inquiry route supplies one `afterStored` callback. The callback receives a `StoredInquiry` with a `created` or `existing` disposition and the canonical `CapturedInquiry`.

New records mirror to Sheets and send email. Existing records mirror again and skip email. Both channels run after Blob storage. Neither channel changes the visitor's successful response.

The protected reconciliation route calls `syncInquirySheet` with the listing ID. The first call backfills the Sheet. Vercel calls the same route every day to repair missed writes.

## Shape

`StoredInquiry` makes the persisted record part of every successful storage result. `syncInquirySheet` accepts either one canonical inquiry or a property-wide replay command. The module hides Blob pagination, batching, the Apps Script request, the timeout, and response validation.

The Apps Script owns columns A through H. It identifies rows by receipt ID and updates only those columns. Columns I onward remain available for team notes. A script lock serializes the shared row index and write. The receiver prefixes formula-like strings before writing them.

Each lead Blob is also the durable work item. A daily replay reads all lead records and upserts them in batches of 50. Receipt-based upserts make replays safe after timeouts, duplicate requests, and interrupted functions.

## Synthesis decision

Two designs were compared. Both returned the canonical stored record and used an Apps Script receiver. The selected design replays all lead Blobs. The other design wrote a success marker for each mirrored lead.

Full replay won because it has one durable state. It repairs a deleted Sheet row or a replacement Sheet. A success marker can drift from the Sheet and suppress repair forever. The selected design also has a smaller public interface and fewer Blob operations.

The final design took four details from the marker design. The webhook protocol has a version. Direct delivery has an eight-second timeout. Script Properties own the destination IDs and shared secret. Preview deployments cannot target the production Sheet.

## Tradeoffs accepted

- A daily full replay makes more webhook calls than a marker scan. Lead volume for one property is low, and the replay removes an entire state machine.
- The Apps Script web app accepts anonymous network requests. A 32-character shared secret authenticates each payload, and the Sheet remains private.
- A failed direct mirror may take until the next daily run to repair. The visitor still receives a fast and truthful response after Blob storage.
- Deleting only a Sheet row is temporary. Remove the authoritative Blob record first when fulfilling a deletion request.

## Alternatives rejected

- A success marker adds state that can disagree with the Sheet.
- A second Blob outbox duplicates the lead and creates partial-write cases.
- A one-time push cannot recover after a process interruption.
- Apps Script polling would expose Blob credentials to Google.
- Direct Google Sheets API access would add a Google Cloud project, service account, and key management for one low-volume Sheet.

## Verification contract

Production acceptance requires the same receipt ID and timestamp in Blob and Sheets. A second reconciliation must leave one row for that receipt. Formula-like visitor text must remain literal text. A build or a `201` response does not prove the integration works.
