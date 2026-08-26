import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/src/lib → ../../../public/logo.png
const LOGO_PATH = resolve(__dirname, "../../../public/logo.png");

// Colours matched to reference QB PO PDF
const BLUE       = "#1e73be"; // "PURCHASE ORDER" heading
const GRAY_BAND  = "#f5f6f8"; // vendor / PO-details background bands
const RULE       = "#d0d0d0"; // table row separators
const DOTTED_CLR = "#b8b8b8"; // dotted rule before table
const BLACK      = "#1a1a1a";
const TEXT       = "#333333";

// Page geometry (US Letter)
const PAGE_W = 612;
const PAGE_H = 792;
const ML = 36; // left margin
const MT = 36; // top margin
const MB = 48; // bottom margin
const CW = 540; // content width (PAGE_W - 2*ML)

// Table column widths — must sum to CW = 540
const C_NUM  = 24;
const C_PS   = 115;
const C_DESC = 229;
const C_QTY  = 42;
const C_RATE = 65;
const C_AMT  = 65;
// 24+115+229+42+65+65 = 540 ✓

const CX = {
  num:  ML,
  ps:   ML + C_NUM,
  desc: ML + C_NUM + C_PS,
  qty:  ML + C_NUM + C_PS + C_DESC,
  rate: ML + C_NUM + C_PS + C_DESC + C_QTY,
  amt:  ML + C_NUM + C_PS + C_DESC + C_QTY + C_RATE,
};

export interface POLineItem {
  productService: string;
  description: string;
  qty: number;
  rate: number;
  amount: number;
}

export interface POPdfOptions {
  docNumber: string;
  txnDate: string; // YYYY-MM-DD
  vendor: {
    name: string;
    addr?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      zip?: string;
    };
  };
  shipTo?: {
    line1?: string;
    line2?: string;
    line3?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
  customerName?: string;
  lineItems: POLineItem[];
  totalAmt: number;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Doc = InstanceType<typeof PDFDocument>;

function hRule(doc: Doc, x: number, y: number, w: number, color = RULE, lw = 0.5) {
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(lw).strokeColor(color).stroke();
}

export function generatePoPdf(opts: POPdfOptions): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ size: "LETTER", margin: 0, autoFirstPage: true });
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => done(Buffer.concat(chunks)));
    doc.on("error", fail);
    draw(doc, opts);
    doc.end();
  });
}

function draw(doc: Doc, opts: POPdfOptions) {
  const { docNumber, txnDate, vendor, shipTo, customerName, lineItems, totalAmt } = opts;
  let y = MT;

  // ── HEADER ──────────────────────────────────────────────────────────────────
  // "PURCHASE ORDER" — blue, bold, large
  doc.font("Helvetica-Bold").fontSize(15).fillColor(BLUE).text("PURCHASE ORDER", ML, y);
  y += 17;

  // Company name + address (left block)
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(BLACK).text("Lux Lampshades", ML, y);
  y += 12;
  doc.font("Helvetica").fontSize(9).fillColor(TEXT);
  doc.text("1003 B Louise Avenue", ML, y); y += 11;
  doc.text("Charlotte, NC 28205", ML, y);

  // Contact info (middle block) — starts at same y as "Lux Lampshades"
  const midX = ML + 205;
  const cY = MT + 17; // y of "Lux Lampshades"
  doc.font("Helvetica").fontSize(9).fillColor(TEXT);
  doc.text("Robert@luxlampshades.com", midX, cY);
  doc.text("+17043766213",            midX, cY + 11);
  doc.text("www.luxlampshades.com",   midX, cY + 22);

  // Logo (top right) — constrained to fit above the header rule at y = MT + 65
  try {
    const img = readFileSync(LOGO_PATH);
    doc.image(img, ML + CW - 90, MT - 4, { fit: [90, 62] });
  } catch { /* logo missing — skip */ }

  y = MT + 65; // enough clearance for header + logo

  // Thin rule
  hRule(doc, ML, y, CW, RULE, 0.5);
  y += 14;

  // ── VENDOR / SHIP TO BAND ───────────────────────────────────────────────────
  const HALF = Math.floor(CW / 2);
  const shipX = ML + HALF;

  // Build line arrays for height calculation
  const vendLines: string[] = [vendor.name];
  if (vendor.addr?.line1) vendLines.push(vendor.addr.line1);
  if (vendor.addr?.line2) vendLines.push(vendor.addr.line2);
  const vendCity = [
    vendor.addr?.city,
    [vendor.addr?.state, vendor.addr?.zip].filter(Boolean).join("  "),
  ].filter(Boolean).join(", ");
  if (vendCity) vendLines.push(vendCity);

  const stLines: string[] = [];
  if (shipTo?.line1) stLines.push(shipTo.line1);
  if (shipTo?.line2) stLines.push(shipTo.line2);
  if (shipTo?.line3) stLines.push(shipTo.line3);
  const stCity = [
    shipTo?.city,
    [shipTo?.state, shipTo?.zip].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  if (stCity) stLines.push(stCity);
  if (shipTo?.country && shipTo.country !== "US") stLines.push(shipTo.country);

  const LH = 12; // line height
  const bandH = (Math.max(vendLines.length, stLines.length) + 1) * LH + 20;

  doc.rect(ML, y, CW, bandH).fill(GRAY_BAND);

  const bY = y + 10;
  // Vendor label + lines
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK).text("Vendor", ML + 6, bY);
  let vY = bY + 13;
  for (let i = 0; i < vendLines.length; i++) {
    doc.font(i === 0 ? "Helvetica" : "Helvetica").fontSize(9).fillColor(TEXT);
    doc.text(vendLines[i]!, ML + 6, vY, { width: HALF - 12 });
    vY += LH;
  }

  // Ship to label + lines
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK).text("Ship to", shipX + 6, bY);
  let sY = bY + 13;
  for (const line of stLines) {
    doc.font("Helvetica").fontSize(9).fillColor(TEXT);
    doc.text(line, shipX + 6, sY, { width: HALF - 12 });
    sY += LH;
  }

  y += bandH + 14;

  // ── PURCHASE ORDER DETAILS BAND ─────────────────────────────────────────────
  const detailLinesL = [
    `Purchase Order no.: ${docNumber}`,
    `Purchase Order date: ${fmtDate(txnDate)}`,
  ];
  const detailLinesR: string[] = [];
  if (customerName) detailLinesR.push(`Customer: ${customerName}`);

  const detailH = (Math.max(detailLinesL.length, detailLinesR.length) + 1) * 13 + 18;
  doc.rect(ML, y, CW, detailH).fill(GRAY_BAND);

  const dY = y + 10;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK).text("Purchase Order details", ML + 6, dY);
  let dlY = dY + 14;
  for (const l of detailLinesL) {
    doc.font("Helvetica").fontSize(9).fillColor(TEXT).text(l, ML + 6, dlY);
    dlY += 13;
  }
  if (detailLinesR.length) {
    const drX = ML + Math.floor(CW / 2);
    let drY = dY;
    for (const l of detailLinesR) {
      doc.font("Helvetica").fontSize(9).fillColor(TEXT).text(l, drX, drY);
      drY += 13;
    }
  }

  y += detailH + 18;

  // Dotted separator before table
  doc.moveTo(ML, y).lineTo(ML + CW, y)
    .lineWidth(0.5).dash(3, { space: 3 }).strokeColor(DOTTED_CLR).stroke();
  doc.undash();
  y += 14;

  // ── LINE ITEMS TABLE ─────────────────────────────────────────────────────────
  // Table header row — plain text, no background fill
  doc.font("Helvetica").fontSize(8.5).fillColor(TEXT);
  doc.text("#",                 CX.num,  y, { width: C_NUM });
  doc.text("Product or service", CX.ps,  y, { width: C_PS });
  doc.text("Description",       CX.desc, y, { width: C_DESC });
  doc.text("Qty",    CX.qty,  y, { width: C_QTY,  align: "right" });
  doc.text("Rate",   CX.rate, y, { width: C_RATE, align: "right" });
  doc.text("Amount", CX.amt,  y, { width: C_AMT,  align: "right" });
  y += 12;
  hRule(doc, ML, y, CW, RULE, 0.5);
  y += 8;

  // Data rows
  for (let idx = 0; idx < lineItems.length; idx++) {
    const li = lineItems[idx]!;

    doc.font("Helvetica").fontSize(9);
    const descH = li.description
      ? doc.heightOfString(li.description, { width: C_DESC - 4 })
      : 12;
    const rowH = Math.max(22, descH + 10);

    // Page break
    if (y + rowH > PAGE_H - MB - 70) {
      doc.addPage({ size: "LETTER", margin: 0 });
      y = MT;
    }

    // Row number (e.g. "1.")
    doc.font("Helvetica").fontSize(9).fillColor(TEXT)
      .text(`${idx + 1}.`, CX.num, y + 2, { width: C_NUM });

    // Product or service — bold
    doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK)
      .text(li.productService, CX.ps, y + 2, { width: C_PS - 4 });

    // Description — regular
    if (li.description) {
      doc.font("Helvetica").fontSize(9).fillColor(TEXT)
        .text(li.description, CX.desc, y + 2, { width: C_DESC - 4 });
    }

    // Qty / Rate / Amount — right-aligned
    doc.font("Helvetica").fontSize(9).fillColor(TEXT);
    doc.text(String(li.qty),         CX.qty,  y + 2, { width: C_QTY,  align: "right" });
    doc.text(fmtMoney(li.rate),      CX.rate, y + 2, { width: C_RATE, align: "right" });
    doc.text(fmtMoney(li.amount),    CX.amt,  y + 2, { width: C_AMT,  align: "right" });

    y += rowH;
    hRule(doc, ML, y, CW, RULE, 0.3);
    y += 8;
  }

  y += 14;

  // ── FOOTER: NOTE TO VENDOR (left) + TOTAL / SIGNATURES (right) ──────────────
  if (y + 90 > PAGE_H - MB) {
    doc.addPage({ size: "LETTER", margin: 0 });
    y = MT;
  }

  const NOTE_W  = Math.floor(CW * 0.47);
  const TOTAL_X = ML + Math.floor(CW * 0.55);
  const TOTAL_W = CW - Math.floor(CW * 0.55);

  // Note to vendor (left)
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK).text("Note to vendor", ML, y);
  doc.font("Helvetica").fontSize(8.5).fillColor(TEXT)
    .text(
      "Thank you. Please confirm receipt of this purchase order and contact us with any questions or changes.",
      ML, y + 13, { width: NOTE_W }
    );

  // Total (right)
  doc.font("Helvetica").fontSize(9).fillColor(TEXT).text("Total", TOTAL_X, y);
  doc.font("Helvetica-Bold").fontSize(14).fillColor(BLACK)
    .text(fmtMoney(totalAmt), TOTAL_X, y, { width: TOTAL_W, align: "right" });
  hRule(doc, TOTAL_X, y + 19, TOTAL_W, RULE, 0.5);

  // Approved By / Date — bold labels with lines to the right
  const sigY = y + 28;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK).text("Approved By", TOTAL_X, sigY);
  hRule(doc, TOTAL_X + 72, sigY + 11, TOTAL_W - 72, RULE, 0.5);

  doc.font("Helvetica-Bold").fontSize(9).fillColor(BLACK).text("Date", TOTAL_X, sigY + 24);
  hRule(doc, TOTAL_X + 32, sigY + 35, TOTAL_W - 32, RULE, 0.5);
}
