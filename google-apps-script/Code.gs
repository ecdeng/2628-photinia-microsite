var LEAD_HEADERS = ["Captured At", "Property", "Name", "Email", "Phone", "Message", "Consent", "Receipt ID"];

function setupLeadsSheet() {
  var sheet = getSheet();
  ensureHeaders(sheet);
}

function doPost(event) {
  var lock = LockService.getScriptLock();
  try {
    var payload = parsePayload(event);
    var settings = getSettings();
    if (payload.secret !== settings.secret || payload.leads.length === 0) return json({ version: 1, outcomes: [] });
    if (!payload.leads.every(function(lead) { return lead.propertyId === settings.propertyId; })) return json({ version: 1, outcomes: [] });
    lock.waitLock(20000);
    var sheet = getSheet(settings);
    ensureHeaders(sheet);
    var index = receiptIndex(sheet);
    var outcomes = payload.leads.map(function(lead) {
      var row = leadRow(lead);
      var existing = index[lead.receiptId];
      if (existing) {
        sheet.getRange(existing, 1, 1, LEAD_HEADERS.length).setValues([row]);
        return { receiptId: lead.receiptId, outcome: "updated" };
      }
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, LEAD_HEADERS.length).setValues([row]);
      return { receiptId: lead.receiptId, outcome: "inserted" };
    });
    SpreadsheetApp.flush();
    return json({ version: 1, outcomes: outcomes });
  } catch (error) {
    return json({ version: 1, outcomes: [] });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function getSettings() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty("LEADS_SPREADSHEET_ID");
  var sheetId = properties.getProperty("LEADS_SHEET_ID");
  var propertyId = properties.getProperty("LEADS_PROPERTY_ID");
  var secret = properties.getProperty("LEADS_WEBHOOK_SECRET");
  if (!spreadsheetId || !sheetId || !propertyId || !secret) throw new Error("Missing lead configuration");
  return { spreadsheetId: spreadsheetId, sheetId: Number(sheetId), propertyId: propertyId, secret: secret };
}

function getSheet(settings) {
  var activeSettings = settings || getSettings();
  var sheet = SpreadsheetApp.openById(activeSettings.spreadsheetId).getSheets().filter(function(candidate) {
    return candidate.getSheetId() === activeSettings.sheetId;
  })[0];
  if (!sheet) throw new Error("Lead sheet not found");
  return sheet;
}

function parsePayload(event) {
  if (!event || !event.postData || typeof event.postData.contents !== "string") throw new Error("Missing payload");
  var payload = JSON.parse(event.postData.contents);
  if (!payload || payload.version !== 1 || typeof payload.secret !== "string" || !Array.isArray(payload.leads)) throw new Error("Invalid payload");
  var receipts = {};
  payload.leads.forEach(function(lead) {
    if (!validLead(lead) || receipts[lead.receiptId]) throw new Error("Invalid lead");
    receipts[lead.receiptId] = true;
  });
  return payload;
}

function validLead(lead) {
  return lead && validString(lead.propertyId, 1, 120) && validString(lead.name, 2, 120) &&
    validString(lead.email, 3, 254) && /^[^\s@]+@[^\s@]+$/.test(lead.email) &&
    (typeof lead.phone === "undefined" || validString(lead.phone, 0, 40)) && validString(lead.message, 5, 3000) &&
    lead.consent === true && typeof lead.receiptId === "string" && /^[a-f0-9]{32}$/.test(lead.receiptId) &&
    typeof lead.capturedAt === "string" && !isNaN(new Date(lead.capturedAt).getTime());
}

function validString(value, minimum, maximum) {
  return typeof value === "string" && value.trim().length >= minimum && value.length <= maximum;
}

function ensureHeaders(sheet) {
  var range = sheet.getRange(1, 1, 1, LEAD_HEADERS.length);
  var current = range.getDisplayValues()[0];
  if (!current.every(function(value, index) { return value === "" || value === LEAD_HEADERS[index]; })) throw new Error("Unexpected lead headers");
  range.setValues([LEAD_HEADERS]);
  sheet.setFrozenRows(1);
}

function receiptIndex(sheet) {
  var lastRow = sheet.getLastRow();
  var index = {};
  if (lastRow < 2) return index;
  sheet.getRange(2, 8, lastRow - 1, 1).getValues().forEach(function(row, offset) {
    var receiptId = row[0];
    if (typeof receiptId !== "string" || !receiptId) return;
    if (index[receiptId]) throw new Error("Duplicate receipt ID");
    index[receiptId] = offset + 2;
  });
  return index;
}

function leadRow(lead) {
  return [
    safeCell(lead.capturedAt),
    safeCell(lead.propertyId),
    safeCell(lead.name),
    safeCell(lead.email),
    safeCell(lead.phone || ""),
    safeCell(lead.message),
    lead.consent,
    safeCell(lead.receiptId),
  ];
}

function safeCell(value) {
  return typeof value === "string" && /^[\s]*[=+\-@]/.test(value) ? "'" + value : value;
}

function json(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
