import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../google-apps-script/Code.gs", import.meta.url), "utf8");
const headers = ["Captured At", "Property", "Name", "Email", "Phone", "Message", "Consent", "Receipt ID"];
const secret = "test-only-google-sheets-webhook-secret";

type Cell = string | number | boolean | Date;
type Lead = Readonly<{
  propertyId: string;
  name: string;
  email: string;
  phone?: string;
  message: string;
  consent: true;
  receiptId: string;
  capturedAt: string;
}>;

type TextOutput = Readonly<{ text: string; setMimeType: () => TextOutput }>;

function receiver() {
  const rows: Cell[][] = [headers.slice()];
  const events: string[] = [];
  let locked = false;
  let failNextFlush = false;

  const sheet = {
    getLastRow() {
      for (let index = rows.length - 1; index >= 0; index--) {
        if (rows[index]?.some((value) => value !== "")) return index + 1;
      }
      return 0;
    },
    getRange(startRow: number, startColumn: number, rowCount: number, columnCount: number) {
      const values = () => Array.from({ length: rowCount }, (_, rowOffset) =>
        Array.from({ length: columnCount }, (_, columnOffset) => rows[startRow - 1 + rowOffset]?.[startColumn - 1 + columnOffset] ?? ""));
      return {
        getDisplayValues: () => values().map((row) => row.map(String)),
        getValues: values,
        setValues(next: Cell[][]) {
          events.push("write");
          next.forEach((row, rowOffset) => {
            const target = rows[startRow - 1 + rowOffset] ?? [];
            row.forEach((value, columnOffset) => { target[startColumn - 1 + columnOffset] = value; });
            rows[startRow - 1 + rowOffset] = target;
          });
          return this;
        },
      };
    },
    setFrozenRows() {
      events.push("freeze");
    },
    getSheetId: () => 0,
  };

  const context = vm.createContext({
    LockService: {
      getScriptLock: () => ({
        waitLock: () => { locked = true; events.push("lock"); },
        hasLock: () => locked,
        releaseLock: () => { events.push("release"); locked = false; },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key: string) => ({
          LEADS_SPREADSHEET_ID: "spreadsheet",
          LEADS_SHEET_ID: "0",
          LEADS_PROPERTY_ID: "2628-photinia",
          LEADS_WEBHOOK_SECRET: secret,
        })[key],
      }),
    },
    SpreadsheetApp: {
      openById: () => ({ getSheets: () => [sheet] }),
      flush: () => {
        events.push("flush");
        if (failNextFlush) {
          failNextFlush = false;
          throw new Error("flush failed");
        }
      },
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text: string): TextOutput => {
        const output: TextOutput = { text, setMimeType: () => output };
        return output;
      },
    },
  });
  vm.runInContext(source, context);
  const doPost = context["doPost"];
  if (typeof doPost !== "function") throw new Error("Apps Script receiver is missing doPost");

  return {
    rows,
    events,
    failFlushOnce: () => { failNextFlush = true; },
    post(leads: ReadonlyArray<Lead>, requestSecret = secret) {
      const output = doPost({ postData: { contents: JSON.stringify({ version: 1, secret: requestSecret, leads }) } }) as TextOutput;
      return JSON.parse(output.text) as unknown;
    },
  };
}

function lead(): Lead {
  return {
    propertyId: "2628-photinia",
    name: "=QA Test",
    email: "+qa@example.com",
    phone: "-123",
    message: " @literal message",
    consent: true,
    receiptId: "0123456789abcdef0123456789abcdef",
    capturedAt: "2026-09-18T09:47:50.148Z",
  };
}

test("receiver upserts by receipt, preserves team columns, and writes formula-like text literally", () => {
  const target = receiver();
  assert.deepEqual(target.post([lead()]), {
    version: 1,
    outcomes: [{ receiptId: lead().receiptId, outcome: "inserted" }],
  });
  assert.deepEqual(target.rows[1]?.slice(0, 8), [
    lead().capturedAt,
    lead().propertyId,
    "'=QA Test",
    "'+qa@example.com",
    "'-123",
    "' @literal message",
    true,
    lead().receiptId,
  ]);
  if (!target.rows[1]) throw new Error("Expected inserted row");
  target.rows[1][8] = "Owner note";

  assert.deepEqual(target.post([lead()]), {
    version: 1,
    outcomes: [{ receiptId: lead().receiptId, outcome: "updated" }],
  });
  assert.equal(target.rows.length, 2);
  assert.equal(target.rows[1]?.[8], "Owner note");
  assert.equal(target.events.lastIndexOf("flush") < target.events.lastIndexOf("release"), true);
});

test("receiver rejects a wrong secret before acquiring the sheet lock", () => {
  const target = receiver();
  assert.deepEqual(target.post([lead()], "wrong-secret"), { version: 1, outcomes: [] });
  assert.equal(target.events.includes("lock"), false);
  assert.equal(target.rows.length, 1);
});

test("a lost flush acknowledgement replays to one receipt row", () => {
  const target = receiver();
  target.failFlushOnce();
  assert.deepEqual(target.post([lead()]), { version: 1, outcomes: [] });
  assert.equal(target.events.at(-1), "release");
  assert.deepEqual(target.post([lead()]), {
    version: 1,
    outcomes: [{ receiptId: lead().receiptId, outcome: "updated" }],
  });
  assert.equal(target.rows.length, 2);
});
