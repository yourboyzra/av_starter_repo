import { Hono } from "hono";
import QRCode from "qrcode";
import { airtable, type AirtableRecord, type Fields } from "../lib/airtable.js";
import { r2Configured, uploadToR2 } from "../lib/r2.js";

const MATERIALS_PAGE = "https://airtable.com/app3PUPEUSBE0rF7X/pagk01v2lRJvStKhO";

export const form = new Hono();

// ---------------------------------------------------------------------------
// GET /form/:orderId
// ---------------------------------------------------------------------------
form.get("/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  let order: AirtableRecord;
  try {
    order = await airtable.find("Orders", orderId);
  } catch {
    return c.html(renderError("Order not found. Please check the link in your email."), 404);
  }

  const lineItemIds = order.fields["Line Items"] as string[] | undefined;
  const lineItems = lineItemIds?.length
    ? await airtable.findByIds("Line Items", lineItemIds)
    : [];

  // Fetch existing materials linked to these line items
  const allMaterialIds = lineItems.flatMap(
    (li) => (li.fields["Materials"] as string[] | undefined) ?? []
  );
  const existingMaterials = allMaterialIds.length
    ? await airtable.findByIds("Materials", allMaterialIds)
    : [];
  const materialsById = Object.fromEntries(existingMaterials.map((m) => [m.id, m]));

  const qrCodes: Record<string, string> = {};
  for (const li of lineItems) {
    qrCodes[li.id] = await QRCode.toDataURL(`${MATERIALS_PAGE}/${li.id}`, {
      width: 300,
      margin: 2,
    });
  }

  return c.html(renderForm(order, lineItems, qrCodes, materialsById));
});

// GET /form/:orderId/done — success page after Submit All
form.get("/:orderId/done", (c) => c.html(renderSuccess()));

// ---------------------------------------------------------------------------
// PATCH /form/:orderId/material/:materialId — update an existing material
// ---------------------------------------------------------------------------
form.patch("/:orderId/material/:materialId", async (c) => {
  const materialId = c.req.param("materialId");
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 400);
  }
  const matName = String(body["materialName"] ?? "").trim();
  const vendorName = String(body["vendorName"] ?? "").trim();
  const tracking = String(body["trackingNumber"] ?? "").trim();
  const notes = String(body["notes"] ?? "").trim();
  const shippingSource = String(body["shippingSource"] ?? "").trim();
  const shipFromValue =
    shippingSource === "Shipping From Me" ? "Ship From Customer" :
    shippingSource === "Shipping From Vendor" ? "Ship From Vendor" :
    null;
  const fields: Fields = {};
  if (matName) fields["Material Name"] = matName;
  if (vendorName) fields["Vendor Name"] = vendorName;
  if (tracking) fields["Material Tracking Number"] = tracking;
  if (notes) fields["Notes"] = notes;
  if (shipFromValue) fields["fldXevE3Nxq2aH1RN"] = shipFromValue;
  try {
    await airtable.update("Materials", [{ id: materialId, fields }]);
  } catch (err) {
    console.error("[form] material update failed:", err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
  const photo = body["photo"];
  if (photo instanceof File && photo.size > 0 && r2Configured()) {
    try {
      const buf = await photo.arrayBuffer();
      const ext = photo.name.split(".").pop() || "jpg";
      const key = `materials/${materialId}/${Date.now()}.${ext}`;
      const url = await uploadToR2(key, buf, photo.type || "image/jpeg");
      await airtable.update("Materials", [{
        id: materialId,
        fields: { "Material Image": [{ url, filename: photo.name || `photo.${ext}` }] },
      }]);
    } catch (uploadErr) {
      console.error("[form] photo upload failed (non-fatal):", uploadErr);
    }
  }
  return c.json({ ok: true, name: matName || null });
});

// ---------------------------------------------------------------------------
// DELETE /form/:orderId/material/:materialId — delete a material record
// ---------------------------------------------------------------------------
form.delete("/:orderId/material/:materialId", async (c) => {
  const materialId = c.req.param("materialId");
  try {
    await airtable.destroy("Materials", [materialId]);
  } catch (err) {
    console.error("[form] material delete failed:", err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /form/:orderId/item/:lineItemId — AJAX per-item submission
// ---------------------------------------------------------------------------
form.post("/:orderId/item/:lineItemId", async (c) => {
  const orderId = c.req.param("orderId");
  const lineItemId = c.req.param("lineItemId");

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (err) {
    console.error("[form] parseBody failed:", err);
    return c.json({ ok: false, error: `parseBody: ${String(err)}` }, 400);
  }

  const matMap = new Map<string, Record<string, unknown>>();
  for (const key of Object.keys(body)) {
    const m = key.match(/^mat_([^_]+)_(\d+)_(.+)$/);
    if (!m) continue;
    const [, liId, idx, fieldName] = m;
    if (liId !== lineItemId) continue;
    const mk = idx!;
    if (!matMap.has(mk)) matMap.set(mk, {});
    matMap.get(mk)![fieldName!] = body[key];
  }

  // Update shipped status on existing materials
  const knownMatIds = Object.keys(body)
    .filter((k) => k.startsWith("knownMat_"))
    .map((k) => k.slice("knownMat_".length));
  if (knownMatIds.length) {
    try {
      const statusUpdates = knownMatIds.flatMap((recId) => {
        const shipped = body[`update_${recId}_shipped`] === "on";
        const tracking = String(body[`update_${recId}_tracking`] ?? "").trim();
        const shipFrom = String(body[`update_${recId}_shipfrom`] ?? "").trim();
        const vendorShipping = shipFrom === "Ship From Vendor";
        const fields: Fields = {};
        if (!shipped) {
          fields["Material Status"] = "Pending";
        } else if (!vendorShipping || tracking) {
          // Ship From Customer: can mark shipped without tracking (QR code handles identification)
          // Ship From Vendor: only mark shipped if tracking provided
          fields["Material Status"] = "Shipped";
          if (tracking) fields["Material Tracking Number"] = tracking;
        }
        return Object.keys(fields).length ? [{ id: recId, fields }] : [];
      });
      if (statusUpdates.length) await airtable.update("Materials", statusUpdates);
    } catch (err) {
      console.error("[form] material status update failed:", err);
      return c.json({ ok: false, error: String(err) }, 500);
    }
  }

  // Create new materials
  let count = 0;
  for (const [, fields] of matMap) {
    try {
      await createMaterial(orderId, lineItemId, fields);
      count++;
    } catch (err) {
      console.error("[form] createMaterial failed:", err);
      return c.json({ ok: false, error: String(err) }, 500);
    }
  }

  return c.json({ ok: true, count });
});

// ---------------------------------------------------------------------------
// Shared material creation logic
// ---------------------------------------------------------------------------
async function createMaterial(orderId: string, lineItemId: string, fields: Record<string, unknown>): Promise<void> {
  const matName = String(fields["materialName"] ?? "").trim();
  const vendorName = String(fields["vendorName"] ?? "").trim();
  const tracking = String(fields["trackingNumber"] ?? "").trim();
  const notes = String(fields["notes"] ?? "").trim();
  const shippingSource = String(fields["shippingSource"] ?? "").trim();
  const photo = fields["photo"];

  if (!matName && !vendorName && !tracking && !notes) return;

  const recordFields: Fields = {
    Order: [orderId],
    "Line Items": [lineItemId],
    "Material Status": "Pending",
  };
  if (matName) recordFields["Material Name"] = matName;
  if (vendorName) recordFields["Vendor Name"] = vendorName;
  if (tracking) recordFields["Material Tracking Number"] = tracking;
  if (notes) recordFields["Notes"] = notes;
  const shipFromValue =
    shippingSource === "Shipping From Me" ? "Ship From Customer" :
    shippingSource === "Shipping From Vendor" ? "Ship From Vendor" :
    null;
  if (shipFromValue) recordFields["fldXevE3Nxq2aH1RN"] = shipFromValue;

  const [created] = await airtable.create("Materials", [{ fields: recordFields }]);
  if (!created) return;

  if (photo instanceof File && photo.size > 0 && r2Configured()) {
    try {
      const buf = await photo.arrayBuffer();
      const ext = photo.name.split(".").pop() || "jpg";
      const key = `materials/${created.id}/${Date.now()}.${ext}`;
      const url = await uploadToR2(key, buf, photo.type || "image/jpeg");
      await airtable.update("Materials", [{
        id: created.id,
        fields: { "Material Image": [{ url, filename: photo.name || `photo.${ext}` }] },
      }]);
    } catch (uploadErr) {
      console.error("[form] photo upload failed (non-fatal):", uploadErr);
    }
  }
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function str(fields: Record<string, unknown>, key: string): string {
  return String(fields[key] ?? "");
}

function renderPage(title: string, body: string, inlineScript = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f4f4f4; color: #111; line-height: 1.5; }
    .container { max-width: 640px; margin: 0 auto; padding: 28px 16px 60px; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 8px; }
    .intro { color: #555; font-size: 0.875rem; margin-bottom: 28px; }
    .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); transition: box-shadow 0.2s; }
    .card.card-done { box-shadow: 0 0 0 2px #22c55e; }
    .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
    .item-title { font-size: 1rem; font-weight: 600; }
    .item-meta { font-size: 0.82rem; color: #888; }
    .done-badge { display: none; font-size: 0.75rem; font-weight: 700; color: #16a34a; background: #dcfce7; border-radius: 20px; padding: 3px 10px; }
    .card-done .done-badge { display: inline-block; }
    .material-section + .material-section { border-top: 1px solid #eee; margin-top: 20px; padding-top: 20px; }
    .mat-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .mat-label { font-size: 0.75rem; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.06em; }
    .remove-btn { font-size: 0.8rem; color: #c00; background: none; border: none; cursor: pointer; }
    .field { margin-bottom: 16px; }
    .field-label { display: block; font-size: 0.8rem; font-weight: 700; color: #444; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 7px; }
    .field input[type=text], .field textarea { width: 100%; border: 1px solid #ddd; border-radius: 8px; padding: 10px 12px; font-size: 0.95rem; font-family: inherit; background: #fafafa; color: #111; }
    .field input[type=text]:focus, .field textarea:focus { outline: none; border-color: #555; background: #fff; }
    .field textarea { resize: vertical; min-height: 72px; }
    .radio-group { display: flex; flex-direction: column; gap: 8px; }
    .radio-opt { display: flex; align-items: center; gap: 11px; padding: 11px 14px; border: 1.5px solid #e0e0e0; border-radius: 9px; cursor: pointer; font-size: 0.9rem; background: #fafafa; }
    .radio-opt:has(input:checked) { border-color: #111; background: #f0f0f0; }
    .radio-opt input[type=radio] { accent-color: #111; width: 17px; height: 17px; flex-shrink: 0; }
    .conditional { display: none; margin-top: 14px; }
    .qr-block { display: flex; align-items: center; gap: 16px; background: #f8f8f8; border: 1px solid #e8e8e8; border-radius: 10px; padding: 14px; }
    .qr-block img { width: 80px; height: 80px; flex-shrink: 0; border-radius: 6px; }
    .qr-block-text { flex: 1; min-width: 0; }
    .qr-block-text p { font-size: 0.82rem; color: #555; margin-bottom: 10px; line-height: 1.4; }
    .qr-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .download-btn, .print-qr-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 7px; font-size: 0.82rem; font-weight: 600; cursor: pointer; text-decoration: none; }
    .download-btn { background: #111; color: #fff; border: none; }
    .download-btn:hover { background: #333; }
    .print-qr-btn { background: none; color: #111; border: 1.5px solid #ccc; }
    .print-qr-btn:hover { border-color: #888; }
    .download-btn svg, .print-qr-btn svg { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .upload-wrap { position: relative; }
    .upload-btn { display: flex; flex-direction: column; align-items: center; justify-content: center; border: 2px dashed #ccc; border-radius: 9px; padding: 20px 16px; cursor: pointer; color: #666; font-size: 0.875rem; text-align: center; gap: 6px; background: #fafafa; }
    .upload-btn:hover { border-color: #999; }
    .upload-btn svg { width: 26px; height: 26px; stroke: #888; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .file-name { font-size: 0.78rem; color: #666; margin-top: 4px; min-height: 14px; }
    .add-mat-btn { display: flex; align-items: center; gap: 6px; background: none; border: 1.5px dashed #bbb; border-radius: 8px; padding: 10px 14px; font-size: 0.88rem; color: #555; cursor: pointer; width: 100%; margin-top: 16px; }
    .add-mat-btn:hover { border-color: #888; color: #111; }
    .card-footer { margin-top: 20px; padding-top: 16px; border-top: 1px solid #eee; display: flex; align-items: center; gap: 12px; }
    .item-save-btn { flex: 1; padding: 11px; background: #111; color: #fff; border: none; border-radius: 9px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
    .item-save-btn:hover { background: #333; }
    .item-save-btn:disabled { background: #999; cursor: default; }
    .item-save-btn.saved { background: #16a34a; }
    .item-error { font-size: 0.8rem; color: #c00; }
    .submit-all-btn { display: block; width: 100%; padding: 14px; background: #111; color: #fff; border: none; border-radius: 10px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .submit-all-btn:hover { background: #333; }
    .submit-all-btn:disabled { background: #999; cursor: default; }
    .success { text-align: center; padding: 48px 20px; }
    .success h2 { font-size: 1.3rem; font-weight: 700; margin-bottom: 10px; }
    .success p { color: #555; font-size: 0.9rem; }
    .error-box { background: #fff3f3; border: 1px solid #f5c2c2; border-radius: 8px; padding: 16px; color: #b00; font-size: 0.9rem; }
    .existing-mats-section { margin-bottom: 20px; padding-bottom: 4px; border-bottom: 1px solid #eee; }
    .existing-mat-row { padding: 10px 0; }
    .existing-mat-row + .existing-mat-row { border-top: 1px solid #f4f4f4; }
    .existing-mat-main { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .existing-mat-name { font-size: 0.9rem; font-weight: 500; flex: 1; min-width: 0; }
    .existing-mat-controls { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .edit-mat-btn { font-size: 0.82rem; color: #555; background: none; border: 1.5px solid #ccc; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
    .edit-mat-btn:hover { border-color: #888; color: #111; }
    .shipped-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 0.85rem; color: #444; white-space: nowrap; }
    .shipped-label input[type=checkbox] { width: 17px; height: 17px; accent-color: #111; flex-shrink: 0; }
    .status-chip { font-size: 0.75rem; font-weight: 600; padding: 3px 9px; border-radius: 20px; white-space: nowrap; }
    .status-chip-received { background: #dcfce7; color: #166534; }
    .status-chip-cancelled { background: #fee2e2; color: #991b1b; }
    .edit-form { border: 1.5px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-top: 12px; background: #f9fafb; }
    .edit-form-footer { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding-top: 14px; border-top: 1px solid #eee; flex-wrap: wrap; }
    .edit-save-btn { padding: 8px 16px; background: #111; color: #fff; border: none; border-radius: 7px; font-size: 0.88rem; font-weight: 600; cursor: pointer; }
    .edit-save-btn:hover { background: #333; }
    .edit-save-btn:disabled { background: #999; cursor: default; }
    .edit-cancel-btn { padding: 8px 14px; background: none; border: 1.5px solid #ccc; border-radius: 7px; font-size: 0.88rem; color: #555; cursor: pointer; }
    .edit-cancel-btn:hover { border-color: #888; }
    .delete-mat-btn { margin-left: auto; padding: 8px 14px; background: none; border: 1.5px solid #fca5a5; border-radius: 7px; font-size: 0.88rem; color: #c00; cursor: pointer; }
    .delete-mat-btn:hover { background: #fff5f5; }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
  ${inlineScript ? `<script>${inlineScript}</script>` : ""}
  <script>
    function printQR(btn) {
      var block = btn.closest('.qr-block');
      var img = block && block.querySelector('img');
      var name = (block && block.dataset.qrName) || '';
      var src = img ? img.src : '';
      var pw = 640, ph = 720;
      var pl = Math.round((screen.width - pw) / 2);
      var pt = Math.round((screen.height - ph) / 2);
      var w = window.open('', '_blank', 'width=' + pw + ',height=' + ph + ',left=' + pl + ',top=' + pt);
      if (!w) return;
      // No inline <script> in the popup — parent calls w.print() after a short
      // delay so the page has time to render the image before the dialog opens.
      w.document.write(
        '<!doctype html><html><head><title>QR - ' + name + '</title>' +
        '<style>body{margin:0;display:flex;flex-direction:column;align-items:center;' +
        'font-family:sans-serif;text-align:center;padding:48px 24px;}' +
        'img{width:260px;height:260px;display:block;margin:0 auto 18px;}' +
        'h2{font-size:15px;font-weight:700;margin-bottom:6px;}p{font-size:13px;color:#555;}</style>' +
        '</head><body><img src="' + src + '"><h2>' + name + '</h2>' +
        '<p>Include this in the box with your material.</p></body></html>'
      );
      w.document.close();
      w.focus();
      setTimeout(function() {
        w.onafterprint = function() { w.close(); };
        w.print();
      }, 250);
    }
    function toggleShipping(radio) {
      var section = radio.closest('.material-section');
      if (!section) return;
      var uid = section.dataset.uid;
      var me = document.getElementById('fm-' + uid);
      var vendor = document.getElementById('fv-' + uid);
      if (me) me.style.display = radio.value === 'Shipping From Me' ? 'block' : 'none';
      if (vendor) {
        vendor.style.display = radio.value === 'Shipping From Vendor' ? 'block' : 'none';
        var trackInput = vendor.querySelector('input[type=text]');
        if (trackInput) trackInput.style.borderColor = '';
      }
    }
    function setupFileInput(input) {
      input.addEventListener('change', function() {
        var wrap = input.closest('.upload-wrap');
        var label = wrap && wrap.nextElementSibling;
        if (label && label.classList.contains('file-name')) {
          label.textContent = input.files && input.files[0] ? input.files[0].name : '';
        }
      });
    }
    function addMaterial(liId) {
      var tpl = document.getElementById('mat-tpl-' + liId);
      var container = document.getElementById('mats-' + liId);
      var idx = container.querySelectorAll('.material-section').length;
      var html = tpl.innerHTML.replace(/__IDX__/g, String(idx));
      var div = document.createElement('div');
      div.innerHTML = html;
      var section = div.firstElementChild;
      container.appendChild(section);
      section.querySelectorAll('input[type=file]').forEach(setupFileInput);
      var first = section.querySelector('input[type=text]');
      if (first) first.focus();
    }
    function removeMaterialSection(btn, liId) {
      var section = btn.closest('.material-section');
      var mats = document.getElementById('mats-' + liId);
      var remaining = mats ? mats.querySelectorAll('.material-section').length : 0;
      if (remaining <= 1) {
        // Last section — if this was opened via "Add a material", collapse the container
        var newMats = document.getElementById('new-mats-' + liId);
        var showBtn = document.getElementById('show-new-mat-btn-' + liId);
        if (newMats && showBtn) {
          newMats.style.display = 'none';
          showBtn.style.display = '';
          return;
        }
      }
      section.remove();
    }
    function showNewMatForm(liId) {
      var div = document.getElementById('new-mats-' + liId);
      if (div) div.style.display = 'block';
      var btn = document.getElementById('show-new-mat-btn-' + liId);
      if (btn) btn.style.display = 'none';
    }
    function toggleShippedTracking(cb, matId) {
      var wrap = document.getElementById('shipped-tracking-' + matId);
      if (!wrap) return;
      wrap.style.display = cb.checked ? 'block' : 'none';
      if (cb.checked) {
        var input = wrap.querySelector('input');
        if (input) setTimeout(function() { input.focus(); }, 50);
      }
    }
    function toggleEditForm(matId) {
      var form = document.getElementById('edit-form-' + matId);
      if (!form) return;
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }
    function toggleEditShipping(matId, radio) {
      var fv = document.getElementById('efv-' + matId);
      if (fv) fv.style.display = radio.value === 'Shipping From Vendor' ? 'block' : 'none';
    }
    async function saveEdit(matId, btn) {
      var editForm = document.getElementById('edit-form-' + matId);
      if (!editForm) return;
      var prefix = 'edit_' + matId + '_';
      var fd = new FormData();
      editForm.querySelectorAll('[name]').forEach(function(el) {
        if (el.type === 'radio' && !el.checked) return;
        var cleanName = el.name.startsWith(prefix) ? el.name.slice(prefix.length) : el.name;
        if (el.type === 'file') { if (el.files && el.files[0]) fd.append(cleanName, el.files[0]); }
        else fd.append(cleanName, el.value);
      });
      btn.disabled = true; btn.textContent = 'Updating…';
      try {
        var res = await fetch(FORM_URL + '/material/' + matId, { method: 'PATCH', body: fd });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');
        var nameEl = document.querySelector('#existing-mat-row-' + matId + ' .existing-mat-name');
        var newName = fd.get('materialName');
        if (nameEl && newName) nameEl.textContent = newName;
        toggleEditForm(matId);
        var editBtn = document.querySelector('#existing-mat-row-' + matId + ' .edit-mat-btn');
        if (editBtn) {
          editBtn.textContent = 'Updated ✓';
          editBtn.style.color = '#16a34a';
          editBtn.style.borderColor = '#16a34a';
          setTimeout(function() {
            editBtn.textContent = 'Edit';
            editBtn.style.color = '';
            editBtn.style.borderColor = '';
          }, 1500);
        }
      } catch(e) {
        alert('Could not save changes. Please try again.');
      }
      btn.disabled = false; btn.textContent = 'Update';
    }
    async function deleteMaterial(matId, liId, btn) {
      if (!confirm('Delete this material? This cannot be undone.')) return;
      btn.disabled = true; btn.textContent = 'Deleting…';
      try {
        var res = await fetch(FORM_URL + '/material/' + matId, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        var row = document.getElementById('existing-mat-row-' + matId);
        if (row) row.remove();
        var existing = document.getElementById('existing-mats-' + liId);
        if (existing && !existing.querySelector('.existing-mat-row')) {
          existing.remove();
          var showBtn = document.getElementById('show-new-mat-btn-' + liId);
          if (showBtn) showBtn.remove();
          var newMats = document.getElementById('new-mats-' + liId);
          if (newMats) newMats.style.display = 'block';
        }
      } catch(e) {
        btn.disabled = false; btn.textContent = 'Delete';
        alert('Could not delete. Please try again.');
      }
    }
    async function saveItem(liId, btn) {
      var container = document.getElementById('mats-' + liId);
      var fd = new FormData();
      container.querySelectorAll('.material-section').forEach(function(section) {
        section.querySelectorAll('[name]').forEach(function(el) {
          if (el.type === 'radio' && !el.checked) return;
          if (el.type === 'file') {
            if (el.files && el.files[0]) fd.append(el.name, el.files[0]);
          } else {
            fd.append(el.name, el.value);
          }
        });
      });
      var existingSection = document.getElementById('existing-mats-' + liId);
      if (existingSection) {
        existingSection.querySelectorAll('[name]').forEach(function(el) {
          if (el.type === 'checkbox') {
            if (el.checked) fd.append(el.name, 'on');
          } else {
            fd.append(el.name, el.value);
          }
        });
      }
      var errEl = btn.parentElement.querySelector('.item-error');
      var origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        var res = await fetch(FORM_URL + '/item/' + liId, { method: 'POST', body: fd });
        if (!res.ok) throw new Error();
        btn.textContent = 'Saved ✓';
        btn.classList.add('saved');
        var card = document.getElementById('card-' + liId);
        if (card) card.classList.add('card-done');
        if (errEl) errEl.textContent = '';
        setTimeout(function() {
          btn.textContent = origText;
          btn.classList.remove('saved');
          btn.disabled = false;
          if (card) card.classList.remove('card-done');
        }, 1500);
        return true;
      } catch (e) {
        btn.disabled = false;
        btn.textContent = origText;
        if (errEl) errEl.textContent = 'Something went wrong, please try again.';
        return false;
      }
    }
    async function submitAll(btn) {
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      var cards = document.querySelectorAll('.card[id^="card-"]');
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        if (card.classList.contains('card-done')) continue;
        var liId = card.id.replace('card-', '');
        var itemBtn = card.querySelector('.item-save-btn');
        var ok = await saveItem(liId, itemBtn);
        if (!ok) { btn.disabled = false; btn.textContent = 'Submit All Materials'; return; }
      }
      window.location.href = FORM_URL + '/done';
    }
    document.querySelectorAll('input[type=file]').forEach(setupFileInput);
  </script>
</body>
</html>`;
}

function materialSectionHtml(
  liId: string,
  idxStr: string,
  firstSection: boolean,
  qrDataUri: string,
  liName: string,
  showRemoveOnFirst = false
): string {
  const prefix = `mat_${liId}_${idxStr}`;
  const uid = `${liId}_${idxStr}`;
  const dlName = `qr-${liName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.png`;
  const showRemove = !firstSection || showRemoveOnFirst;

  return `<div class="material-section" data-uid="${uid}">
  <div class="mat-header">
    <span class="mat-label">${firstSection ? "Material" : "Additional material"}</span>
    ${showRemove ? `<button type="button" class="remove-btn" onclick="removeMaterialSection(this, '${liId}')">Remove</button>` : ""}
  </div>

  <div class="field">
    <label class="field-label" for="mn-${uid}">Material name</label>
    <input type="text" id="mn-${uid}" name="${prefix}_materialName" placeholder="e.g. ivory silk dupioni, 3 yards">
  </div>

  <div class="field">
    <label class="field-label">Shipping method</label>
    <div class="radio-group">
      <label class="radio-opt">
        <input type="radio" name="${prefix}_shippingSource" value="Shipping From Me" onchange="toggleShipping(this)">
        I'll ship it to Lux Lampshades myself
      </label>
      <label class="radio-opt">
        <input type="radio" name="${prefix}_shippingSource" value="Shipping From Vendor" onchange="toggleShipping(this)">
        My vendor will ship it directly
      </label>
    </div>
  </div>

  <div id="fm-${uid}" class="conditional">
    <div class="qr-block" data-qr-name="${esc(liName)}">
      <img src="${qrDataUri}" alt="QR code" width="80" height="80">
      <div class="qr-block-text">
        <p>Print this QR code and include it in your shipping box so our team can identify your material on arrival.</p>
        <div class="qr-actions">
          <a href="${qrDataUri}" download="${dlName}" class="download-btn">
            <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </a>
          <button type="button" class="print-qr-btn" onclick="printQR(this)">
            <svg viewBox="0 0 24 24"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            Print
          </button>
        </div>
      </div>
    </div>
  </div>

  <div id="fv-${uid}" class="conditional">
    <div class="field">
      <label class="field-label" for="vn-${uid}">Vendor name</label>
      <input type="text" id="vn-${uid}" name="${prefix}_vendorName" placeholder="e.g. Fabric House NYC">
    </div>
    <div class="field">
      <label class="field-label" for="tr-${uid}">Tracking number</label>
      <input type="text" id="tr-${uid}" name="${prefix}_trackingNumber" placeholder="Carrier tracking number">
    </div>
  </div>

  <div class="field">
    <label class="field-label" for="nt-${uid}">Notes</label>
    <textarea id="nt-${uid}" name="${prefix}_notes" placeholder="Color details, special instructions, etc."></textarea>
  </div>

  <div class="field">
    <label class="field-label">Photo of material</label>
    <div class="upload-wrap">
      <label class="upload-btn" for="ph-${uid}">
        <svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        <span>Tap to take a photo or choose from library</span>
      </label>
      <input type="file" id="ph-${uid}" name="${prefix}_photo" accept="image/*" capture="environment">
    </div>
    <div class="file-name"></div>
  </div>
</div>`;
}

function renderExistingMatsSection(liId: string, mats: AirtableRecord[]): string {
  if (!mats.length) return "";
  const rows = mats.map((mat) => {
    const name = esc(str(mat.fields, "Material Name")) || "Unnamed material";
    const status = str(mat.fields, "Material Status");
    const locked = status === "Received" || status === "Cancelled";
    const isShipped = status === "Shipped";
    const chipClass = status === "Received" ? "status-chip-received" : "status-chip-cancelled";
    const p = `edit_${mat.id}_`; // field name prefix — keeps radio groups isolated per material

    // Pre-fill edit form from existing record values
    const existingVendor = esc(str(mat.fields, "Vendor Name"));
    const existingTracking = esc(str(mat.fields, "Material Tracking Number"));
    const existingNotes = esc(str(mat.fields, "Notes"));
    const shipFromAT = str(mat.fields, "Ship From");
    const fromVendor = shipFromAT === "Ship From Vendor";
    const fromMe = shipFromAT === "Ship From Customer";

    const editForm = locked ? "" : `<div id="edit-form-${mat.id}" class="edit-form" style="display:none">
  <div class="field">
    <label class="field-label">Material name</label>
    <input type="text" name="${p}materialName" value="${name}" placeholder="e.g. ivory silk dupioni, 3 yards">
  </div>
  <div class="field">
    <label class="field-label">Shipping method</label>
    <div class="radio-group">
      <label class="radio-opt">
        <input type="radio" name="${p}shippingSource" value="Shipping From Me"${fromMe ? " checked" : ""} onchange="toggleEditShipping('${mat.id}', this)">
        I'll ship it to Lux Lampshades myself
      </label>
      <label class="radio-opt">
        <input type="radio" name="${p}shippingSource" value="Shipping From Vendor"${fromVendor ? " checked" : ""} onchange="toggleEditShipping('${mat.id}', this)">
        My vendor will ship it directly
      </label>
    </div>
  </div>
  <div id="efv-${mat.id}" class="conditional"${fromVendor ? ' style="display:block"' : ''}>
    <div class="field">
      <label class="field-label">Vendor name</label>
      <input type="text" name="${p}vendorName" value="${existingVendor}" placeholder="e.g. Fabric House NYC">
    </div>
    <div class="field">
      <label class="field-label">Tracking number</label>
      <input type="text" name="${p}trackingNumber" value="${existingTracking}" placeholder="Carrier tracking number">
    </div>
  </div>
  <div class="field">
    <label class="field-label">Notes</label>
    <textarea name="${p}notes" placeholder="Color details, special instructions, etc.">${existingNotes}</textarea>
  </div>
  <div class="edit-form-footer">
    <button type="button" class="edit-save-btn" onclick="saveEdit('${mat.id}', this)">Update</button>
    <button type="button" class="edit-cancel-btn" onclick="toggleEditForm('${mat.id}')">Cancel</button>
    <button type="button" class="delete-mat-btn" onclick="deleteMaterial('${mat.id}', '${liId}', this)">Delete material</button>
  </div>
</div>`;

    return `<div class="existing-mat-row" id="existing-mat-row-${mat.id}">
  <input type="hidden" name="knownMat_${mat.id}" value="${mat.id}">
  <div class="existing-mat-main">
    <span class="existing-mat-name">${name}</span>
    <div class="existing-mat-controls">
      ${locked
        ? `<span class="status-chip ${chipClass}">${esc(status)}</span>`
        : `<button type="button" class="edit-mat-btn" onclick="toggleEditForm('${mat.id}')">Edit</button>
      <label class="shipped-label">
        <input type="checkbox" name="update_${mat.id}_shipped"${isShipped ? " checked" : ""} onchange="toggleShippedTracking(this,'${mat.id}')">
        I've shipped this
      </label>`}
    </div>
  </div>
  ${locked ? "" : `<input type="hidden" name="update_${mat.id}_shipfrom" value="${esc(shipFromAT)}">
  <div id="shipped-tracking-${mat.id}" style="margin-top:8px;${isShipped ? "" : "display:none"}">
    <input type="text" name="update_${mat.id}_tracking" value="${existingTracking}" placeholder="${fromVendor ? "Tracking number (required to mark shipped)" : "Tracking number (optional)"}" style="width:100%;border:1px solid #ddd;border-radius:7px;padding:8px 11px;font-size:0.875rem;font-family:inherit;background:#fafafa;color:#111">
  </div>`}
  ${editForm}
</div>`;
  }).join("\n");
  return `<div class="existing-mats-section" id="existing-mats-${liId}">
  <div class="mat-label" style="margin-bottom:12px">Previously submitted materials</div>
  ${rows}
</div>`;
}

function renderLineItemCard(li: AirtableRecord, qrDataUri: string, existingMats: AirtableRecord[] = []): string {
  const f = li.fields;
  const id = li.id;
  const title = str(f, "Line Item") || "Item";
  const variant = str(f, "Variant / Description");
  const qty = str(f, "Quantity");
  const hasExisting = existingMats.length > 0;

  return `<div class="card" id="card-${id}">
  <div class="card-header">
    <div>
      <div class="item-title">${esc(title)}</div>
      <div class="item-meta">${variant ? `${esc(variant)} &middot; ` : ""}Qty ${esc(qty) || "1"}</div>
    </div>
    <span class="done-badge">Saved</span>
  </div>

  ${renderExistingMatsSection(id, existingMats)}

  ${hasExisting ? `<button type="button" class="add-mat-btn" id="show-new-mat-btn-${id}" onclick="showNewMatForm('${id}')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    Add a material for this item
  </button>` : ""}

  <div id="new-mats-${id}"${hasExisting ? ' style="display:none"' : ''}>
    <div id="mats-${id}">
      ${materialSectionHtml(id, "0", true, qrDataUri, title, hasExisting)}
    </div>
    <button type="button" class="add-mat-btn" onclick="addMaterial('${id}')">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add another material for this item
    </button>
  </div>

  <div class="card-footer">
    <button type="button" class="item-save-btn" onclick="saveItem('${id}', this)">Save ${esc(title)}</button>
    <span class="item-error"></span>
  </div>

  <template id="mat-tpl-${id}">
    ${materialSectionHtml(id, "__IDX__", false, qrDataUri, title)}
  </template>
</div>`;
}

function renderForm(
  order: AirtableRecord,
  lineItems: AirtableRecord[],
  qrCodes: Record<string, string>,
  materialsById: Record<string, AirtableRecord> = {}
): string {
  const orderNum = esc(str(order.fields, "Order Number"));
  const customerName = esc(str(order.fields, "Customer Name"));
  const orderId = order.id;

  const itemsHtml = lineItems.length > 0
    ? lineItems.map((li) => {
        const matIds = (li.fields["Materials"] as string[] | undefined) ?? [];
        const existingMats = matIds.map((id) => materialsById[id]).filter(Boolean) as AirtableRecord[];
        return renderLineItemCard(li, qrCodes[li.id] ?? "", existingMats);
      }).join("\n")
    : '<div class="error-box">No items found for this order.</div>';

  const initScript = `var FORM_URL = '/form/${orderId}';`;

  return renderPage(
    `Material Information — Order ${orderNum}`,
    `<h1>Material Information</h1>
<p class="subtitle">Order ${orderNum}${customerName ? ` &middot; ${customerName}` : ""}</p>
<p class="intro">For each item, fill in your material details and save. You can save items individually or use Submit All at the bottom.</p>
${itemsHtml}
<button type="button" class="submit-all-btn" onclick="submitAll(this)">Submit All Materials</button>`,
    initScript
  );
}

function renderSuccess(): string {
  return renderPage(
    "Thank you!",
    `<div class="success">
  <h2>Thank you!</h2>
  <p>We've received your material information and will follow up if we have any questions.</p>
</div>`
  );
}

function renderError(message: string): string {
  return renderPage("Error", `<div class="error-box">${esc(message)}</div>`);
}
