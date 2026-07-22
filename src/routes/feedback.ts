import { Hono } from "hono";
import { airtable, type AirtableRecord } from "../lib/airtable.js";

export const feedback = new Hono();

// ---------------------------------------------------------------------------
// GET /feedback/:orderId
// ---------------------------------------------------------------------------
feedback.get("/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  let order: AirtableRecord;
  try {
    order = await airtable.find("Orders", orderId);
  } catch {
    return c.html(renderError("Order not found. Please check the link in your email."), 404);
  }

  if (order.fields["Feedback Submitted"] === true) {
    return c.html(renderAlreadySubmitted());
  }

  const lineItemIds = order.fields["Line Items"] as string[] | undefined;
  const lineItems = lineItemIds?.length
    ? await airtable.findByIds("Line Items", lineItemIds)
    : [];

  return c.html(renderForm(order, lineItems));
});

// GET /feedback/:orderId/done
feedback.get("/:orderId/done", (c) => c.html(renderSuccess()));

// ---------------------------------------------------------------------------
// POST /feedback/:orderId
// ---------------------------------------------------------------------------
feedback.post("/:orderId", async (c) => {
  const orderId = c.req.param("orderId");

  let order: AirtableRecord;
  try {
    order = await airtable.find("Orders", orderId);
  } catch {
    return c.html(renderError("Order not found."), 404);
  }

  if (order.fields["Feedback Submitted"] === true) {
    return c.redirect(`/feedback/${orderId}/done`);
  }

  let body: Record<string, string>;
  try {
    body = (await c.req.parseBody()) as Record<string, string>;
  } catch {
    return c.html(renderError("Invalid submission. Please try again."), 400);
  }

  const overallSatisfaction = parseInt(body["overall_satisfaction"] ?? "0", 10);
  const productQuality = parseInt(body["product_quality"] ?? "0", 10);
  const wouldOrderAgain = body["would_order_again"] === "yes";
  const comments = String(body["comments"] ?? "").trim();
  const orderNumber = String(order.fields["Order Number"] ?? orderId);

  try {
    await airtable.create("Feedback", [
      {
        fields: {
          Feedback: `Feedback — Order ${orderNumber}`,
          Order: [orderId],
          ...(overallSatisfaction > 0 ? { "Overall Satisfaction": overallSatisfaction } : {}),
          ...(productQuality > 0 ? { "Product Quality": productQuality } : {}),
          "Would Order Again": wouldOrderAgain,
          ...(comments ? { Comments: comments } : {}),
          "Submitted At": new Date().toISOString(),
        },
      },
    ]);

    await airtable.update("Orders", [{ id: orderId, fields: { "Feedback Submitted": true } }]);
  } catch (err) {
    console.error("[feedback] submission failed:", err);
    return c.html(renderError("Something went wrong. Please try again."), 500);
  }

  return c.redirect(`/feedback/${orderId}/done`);
});

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

function renderPage(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f4f4f4; color: #111; line-height: 1.5; }
    .container { max-width: 600px; margin: 0 auto; padding: 28px 16px 60px; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 0.875rem; margin-bottom: 6px; }
    .intro { color: #555; font-size: 0.875rem; margin-bottom: 28px; }
    .order-card { background: #fff; border-radius: 12px; margin-bottom: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); overflow: hidden; }
    .order-card-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; background: none; border: none; cursor: pointer; text-align: left; }
    .order-card-toggle:hover { background: #fafafa; }
    .order-card-label { font-size: 0.72rem; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.06em; }
    .order-card-chevron { width: 16px; height: 16px; stroke: #aaa; fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; transition: transform 0.2s; flex-shrink: 0; }
    .order-card.open .order-card-chevron { transform: rotate(180deg); }
    .order-items { list-style: none; padding: 0 20px 16px; display: none; }
    .order-items li { font-size: 0.9rem; color: #333; padding: 5px 0; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    .order-items li:last-child { border-bottom: none; }
    .item-qty { font-size: 0.8rem; color: #888; flex-shrink: 0; }
    .section { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.07); }
    .section-label { font-size: 0.75rem; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
    .section-question { font-size: 0.95rem; font-weight: 600; color: #111; margin-bottom: 14px; }
    .stars { display: flex; gap: 6px; margin-bottom: 2px; }
    .star-btn { background: none; border: none; cursor: pointer; padding: 2px; font-size: 2rem; line-height: 1; color: #ddd; transition: color 0.1s, transform 0.1s; }
    .star-btn:hover, .star-btn.active { color: #f59e0b; }
    .star-btn:hover { transform: scale(1.1); }
    .star-hint { font-size: 0.78rem; color: #aaa; min-height: 18px; }
    .yn-group { display: flex; gap: 10px; }
    .yn-opt { flex: 1; }
    .yn-opt input[type=radio] { position: absolute; opacity: 0; width: 0; height: 0; }
    .yn-opt label { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; border: 1.5px solid #e0e0e0; border-radius: 9px; cursor: pointer; font-size: 0.95rem; font-weight: 500; background: #fafafa; transition: border-color 0.15s, background 0.15s; }
    .yn-opt input[type=radio]:checked + label { border-color: #111; background: #f0f0f0; font-weight: 600; }
    .yn-opt label:hover { border-color: #999; }
    textarea { width: 100%; border: 1px solid #ddd; border-radius: 8px; padding: 10px 12px; font-size: 0.95rem; font-family: inherit; background: #fafafa; color: #111; resize: vertical; min-height: 96px; }
    textarea:focus { outline: none; border-color: #555; background: #fff; }
    .submit-btn { display: block; width: 100%; padding: 14px; background: #111; color: #fff; border: none; border-radius: 10px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 8px; }
    .submit-btn:hover { background: #333; }
    .submit-btn:disabled { background: #999; cursor: default; }
    .center { text-align: center; padding: 52px 20px; }
    .center h2 { font-size: 1.3rem; font-weight: 700; margin-bottom: 10px; }
    .center p { color: #555; font-size: 0.9rem; line-height: 1.6; }
    .check-icon { font-size: 3rem; margin-bottom: 16px; }
    .redirect-block { margin-top: 28px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .countdown-ring-wrap { margin-bottom: 4px; }
    .redirect-msg { font-size: 0.88rem; color: #666; }
    .redirect-now { font-size: 0.88rem; font-weight: 600; color: #111; text-underline-offset: 3px; }
    .redirect-now:hover { color: #444; }
    .error-box { background: #fff3f3; border: 1px solid #f5c2c2; border-radius: 8px; padding: 16px; color: #b00; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
  ${script ? `<script>${script}</script>` : ""}
</body>
</html>`;
}

const STAR_LABELS = ["", "Poor", "Fair", "Good", "Very good", "Excellent"];

function starRating(name: string): string {
  return `<div class="stars" id="stars-${name}" role="group" aria-label="Rating">
  ${[1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button type="button" class="star-btn" data-name="${name}" data-value="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">&#9733;</button>`
    )
    .join("")}
</div>
<input type="hidden" name="${name}" id="input-${name}" value="0">
<div class="star-hint" id="hint-${name}">&nbsp;</div>`;
}

function renderForm(order: AirtableRecord, lineItems: AirtableRecord[]): string {
  const orderNumber = esc(str(order.fields, "Order Number"));
  const customerName = esc(str(order.fields, "Customer Name"));
  const orderId = order.id;

  const itemsHtml = lineItems.length
    ? lineItems
        .map((li) => {
          const qty = str(li.fields, "Quantity") || "1";
          const variant = str(li.fields, "Variant / Description");
          return `<li>
          <span>${esc(str(li.fields, "Line Item"))}${variant ? ` <span style="color:#888;font-weight:400">— ${esc(variant)}</span>` : ""}</span>
          <span class="item-qty">Qty ${esc(qty)}</span>
        </li>`;
        })
        .join("")
    : `<li style="color:#888">No items on record</li>`;

  const script = `
    var LABELS = ${JSON.stringify(STAR_LABELS)};
    document.querySelectorAll('.star-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var name = btn.dataset.name;
        var val = parseInt(btn.dataset.value);
        document.getElementById('input-' + name).value = val;
        document.getElementById('hint-' + name).textContent = LABELS[val] || '';
        document.querySelectorAll('.star-btn[data-name="' + name + '"]').forEach(function(s) {
          s.classList.toggle('active', parseInt(s.dataset.value) <= val);
        });
      });
      btn.addEventListener('mouseenter', function() {
        var name = btn.dataset.name;
        var val = parseInt(btn.dataset.value);
        document.getElementById('hint-' + name).textContent = LABELS[val] || '';
        document.querySelectorAll('.star-btn[data-name="' + name + '"]').forEach(function(s) {
          s.classList.toggle('active', parseInt(s.dataset.value) <= val);
        });
      });
      btn.addEventListener('mouseleave', function() {
        var name = btn.dataset.name;
        var current = parseInt(document.getElementById('input-' + name).value);
        document.getElementById('hint-' + name).textContent = current ? LABELS[current] : ' ';
        document.querySelectorAll('.star-btn[data-name="' + name + '"]').forEach(function(s) {
          s.classList.toggle('active', parseInt(s.dataset.value) <= current);
        });
      });
    });
    function toggleOrderCard() {
      var card = document.getElementById('order-card');
      var items = document.getElementById('order-items');
      var open = card.classList.toggle('open');
      items.style.display = open ? 'block' : 'none';
    }
    document.getElementById('feedback-form').addEventListener('submit', function(e) {
      var btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Submitting…';
    });
  `;

  return renderPage(
    `Share Your Feedback — Order ${orderNumber}`,
    `<h1>Feedback Form — How did we do?</h1>
<p class="subtitle">Order ${orderNumber}${customerName ? ` &middot; ${customerName}` : ""}</p>
<p class="intro">Thank you for choosing Lux Lampshade! We hope you're thrilled with your custom lampshade. Your feedback helps us continue improving our products and customer experience while helping future customers shop with confidence.</p>
<p class="intro">This short survey will only take a minute to complete. We truly appreciate you taking the time to share your experience with us.</p>

<div class="order-card" id="order-card">
  <button type="button" class="order-card-toggle" onclick="toggleOrderCard()">
    <span class="order-card-label">Your order</span>
    <svg class="order-card-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
  </button>
  <ul class="order-items" id="order-items">${itemsHtml}</ul>
</div>

<form id="feedback-form" method="POST" action="/feedback/${orderId}">
  <div class="section">
    <div class="section-label">Overall satisfaction</div>
    <div class="section-question">How satisfied are you with your order overall?</div>
    ${starRating("overall_satisfaction")}
  </div>

  <div class="section">
    <div class="section-label">Product quality</div>
    <div class="section-question">How would you rate the quality of your lampshades?</div>
    ${starRating("product_quality")}
  </div>

  <div class="section">
    <div class="section-label">Would you order again?</div>
    <div class="section-question">Would you order from Lux Lampshades again?</div>
    <div class="yn-group">
      <div class="yn-opt">
        <input type="radio" name="would_order_again" id="yn-yes" value="yes">
        <label for="yn-yes">&#128077; Yes</label>
      </div>
      <div class="yn-opt">
        <input type="radio" name="would_order_again" id="yn-no" value="no">
        <label for="yn-no">&#128078; No</label>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-label">Additional comments</div>
    <div class="section-question">Anything else you'd like to share?</div>
    <textarea name="comments" placeholder="Tell us what you loved, or how we can improve…"></textarea>
  </div>

  <button type="submit" class="submit-btn" id="submit-btn">Submit Feedback</button>
</form>`,
    script
  );
}

function renderSuccess(): string {
  const redirectUrl = "https://www.luxlampshades.com/";
  const seconds = 5;

  const script = `
    var remaining = ${seconds};
    var el = document.getElementById('countdown-num');
    var ring = document.getElementById('countdown-ring');
    var circumference = 2 * Math.PI * 20;
    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = 0;
    setTimeout(function() {
      var interval = setInterval(function() {
        remaining--;
        el.textContent = remaining;
        var inlineEl = document.getElementById('countdown-num-inline');
        if (inlineEl) inlineEl.textContent = remaining;
        ring.style.strokeDashoffset = circumference * (1 - remaining / ${seconds});
        if (remaining <= 0) {
          clearInterval(interval);
          window.location.href = '${redirectUrl}';
        }
      }, 1000);
    }, 500);
  `;

  return renderPage(
    "Thank you for your feedback!",
    `<div class="center">
  <div class="check-icon">&#10003;</div>
  <h2>Thank you for your feedback!</h2>
  <p>Your response means a lot to us. We read every submission and use it to keep improving.</p>
  <div class="redirect-block">
    <div class="countdown-ring-wrap" aria-hidden="true">
      <svg width="52" height="52" viewBox="0 0 52 52">
        <circle cx="26" cy="26" r="20" fill="none" stroke="#e5e7eb" stroke-width="3"/>
        <circle id="countdown-ring" cx="26" cy="26" r="20" fill="none" stroke="#111" stroke-width="3"
          stroke-linecap="round" transform="rotate(-90 26 26)"
          style="transition: stroke-dashoffset 0.9s linear;"/>
        <text id="countdown-num" x="26" y="31" text-anchor="middle" font-size="15" font-weight="700" fill="#111" font-family="-apple-system,sans-serif">${seconds}</text>
      </svg>
    </div>
    <p class="redirect-msg">Taking you to <strong>luxlampshades.com</strong> in <span id="countdown-num-inline">${seconds}</span> seconds&hellip;</p>
    <a href="${redirectUrl}" class="redirect-now">Take me there now</a>
  </div>
</div>`,
    script
  );
}

function renderAlreadySubmitted(): string {
  return renderPage(
    "Feedback Already Submitted",
    `<div class="center">
  <div class="check-icon">&#9733;</div>
  <h2>Already submitted</h2>
  <p>We've already received your feedback for this order. Thank you!</p>
</div>`
  );
}

function renderError(message: string): string {
  return renderPage("Error", `<div class="error-box">${esc(message)}</div>`);
}
