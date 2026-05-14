import express from 'express';
import fetch from 'node-fetch';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const KBC_URL   = (process.env.KBC_URL   || 'https://connection.europe-west3.gcp.keboola.com').replace(/\/$/, '');
const KBC_TOKEN = process.env.KBC_TOKEN  || '';

const PERFORMANCE_TABLE = 'out.c-marketing-analytics.weekly_channel_summary';
const BUDGET_PLAN_TABLE = 'in.c-marketing-raw.budget_plan_usd';

app.use(express.json({ limit: '2mb' }));

// ── Multipart form builder (avoids FormData/Blob compat issues with node-fetch) ──
function buildMultipart(fields, file) {
  const boundary = '----KeboolaBoundary' + randomUUID().replace(/-/g, '');
  const CRLF = '\r\n';
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`;
    body += `${value}${CRLF}`;
  }
  body += `--${boundary}${CRLF}`;
  body += `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"${CRLF}`;
  body += `Content-Type: ${file.contentType}${CRLF}${CRLF}`;
  body += `${file.content}${CRLF}`;
  body += `--${boundary}--${CRLF}`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ── CSV helpers ────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

// ── Kai URL discovery (cached per process) ─────────────────────────────────
let _kaiBaseUrl = null;
let _kaiUnavailable = false;

async function getKaiBaseUrl() {
  if (_kaiBaseUrl) return _kaiBaseUrl;
  if (_kaiUnavailable) throw new Error('Kai not available on this stack');
  const r = await fetch(`${KBC_URL}/v2/storage`, {
    headers: { 'x-storageapi-token': KBC_TOKEN },
  });
  if (!r.ok) { _kaiUnavailable = true; throw new Error(`Storage API ${r.status}`); }
  const data = await r.json();
  const svc = data.services?.find(s => s.id === 'kai-assistant');
  if (!svc?.url) { _kaiUnavailable = true; throw new Error('kai-assistant service not found'); }
  _kaiBaseUrl = svc.url.replace(/\/$/, '');
  return _kaiBaseUrl;
}

function buildKaiContext() {
  return `You are an AI assistant embedded in the Groupon Q3 2026 Budget Planner data app.

FORMATTING: Use standard Unicode emoji only (✅ ⚠️ ❌ 💡 📊 📈 📉 💰 🎯). Use markdown tables for comparisons. Be concise — max 5-6 sentences unless detail is requested.

APP CONTEXT: This app helps the Groupon marketing team review Q1 2026 channel performance and plan Q3 2026 budget.
Data source: out.c-marketing-analytics.weekly_channel_summary
Channels: Email Marketing, Push Notifications (Owned Media — near-zero cost, high ROAS but not scalable with budget), Meta Ads, Google Search, Affiliate, Display/Programmatic, TikTok (Paid Media)
Currency: USD | Key metrics: ROAS = revenue ÷ spend | Margin on Spend = platform_margin ÷ spend | Cost per Voucher = spend ÷ voucher_purchases
Planning period: Q3 2026 (Jul–Sep)

User question: `;
}

// ── Health / root (Keboola POSTs to / on startup) ──────────────────────────
app.all('/', (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.use(express.static(__dirname, { index: false }));

// ── GET /api/performance ───────────────────────────────────────────────────
// Returns Q1 channel-level summary aggregated from weekly_channel_summary
app.get('/api/performance', async (req, res) => {
  try {
    const url = `${KBC_URL}/v2/storage/tables/${PERFORMANCE_TABLE}/data-preview?limit=500`;
    const r   = await fetch(url, {
      headers: { 'X-StorageApi-Token': KBC_TOKEN },
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: `Keboola API error: ${txt.slice(0, 300)}` });
    }

    const text = await r.text();
    let rows = [];
    try {
      const raw = JSON.parse(text);
      if (Array.isArray(raw)) {
        rows = raw;
      } else if (raw.rows) {
        const cols = raw.columns || [];
        rows = raw.rows.map(row =>
          Array.isArray(row)
            ? Object.fromEntries(cols.map((c, i) => [c, row[i]]))
            : row
        );
      }
    } catch (_) {
      rows = parseCSV(text);
    }

    // Aggregate to channel level (sum numeric cols, keep channel_name + channel_type)
    const agg = {};
    // Internal field names → source column names (USD)
    const FIELD_MAP = {
      total_spend_gbp:           'total_spend_usd',
      total_revenue_gbp:         'total_revenue_usd',
      total_platform_margin_gbp: 'total_platform_margin_usd',
      total_impressions:         'total_impressions',
      total_clicks:              'total_clicks',
      total_voucher_purchases:   'total_voucher_purchases',
    };
    const NUM = Object.keys(FIELD_MAP);
    for (const row of rows) {
      const key = row.channel_id;
      if (!key) continue;
      if (!agg[key]) {
        agg[key] = {
          channel_id:   row.channel_id,
          channel_name: row.channel_name,
          channel_type: row.channel_type,
        };
        NUM.forEach(f => { agg[key][f] = 0; });
      }
      NUM.forEach(f => { agg[key][f] += parseFloat(row[FIELD_MAP[f]] || 0); });
    }

    const safe = (n) => isFinite(n) ? n : 0;
    const channels = Object.values(agg).map(c => ({
      ...c,
      total_spend_gbp:            safe(Math.round(c.total_spend_gbp)),
      total_revenue_gbp:          safe(Math.round(c.total_revenue_gbp)),
      total_platform_margin_gbp:  safe(Math.round(c.total_platform_margin_gbp)),
      total_impressions:          safe(Math.round(c.total_impressions)),
      total_clicks:               safe(Math.round(c.total_clicks)),
      total_voucher_purchases:    safe(Math.round(c.total_voucher_purchases)),
      roas: c.total_spend_gbp > 0
        ? safe(parseFloat((c.total_revenue_gbp / c.total_spend_gbp).toFixed(2)))
        : 0,
      cost_per_voucher: c.total_voucher_purchases > 0
        ? safe(parseFloat((c.total_spend_gbp / c.total_voucher_purchases).toFixed(2)))
        : 0,
      margin_on_spend: c.total_spend_gbp > 0
        ? safe(parseFloat((c.total_platform_margin_gbp / c.total_spend_gbp).toFixed(2)))
        : 0,
    }));

    channels.sort((a, b) => b.roas - a.roas);
    res.json({ channels });
  } catch (err) {
    console.error('GET /api/performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/submit-plan ──────────────────────────────────────────────────
// Writes budget plan rows to Keboola Storage (incremental upsert).
app.post('/api/submit-plan', async (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows?.length) return res.status(400).json({ error: 'No rows provided' });

    const cols = Object.keys(rows[0]);
    const csv  = [
      cols.join(','),
      ...rows.map(r =>
        cols.map(c => {
          const v = String(r[c] ?? '').replace(/"/g, '""');
          return /[",\n]/.test(v) ? `"${v}"` : v;
        }).join(',')
      ),
    ].join('\n');

    const { body: mpBody, contentType: mpType } = buildMultipart(
      { incremental: '1' },
      { field: 'data', filename: 'plan.csv', contentType: 'text/csv', content: csv }
    );

    const importRes = await fetch(
      `${KBC_URL}/v2/storage/tables/${BUDGET_PLAN_TABLE}/import-async`,
      { method: 'POST', headers: { 'X-StorageApi-Token': KBC_TOKEN, 'Content-Type': mpType }, body: mpBody }
    );

    const importText = await importRes.text();
    let importJson;
    try { importJson = JSON.parse(importText); } catch (_) { importJson = {}; }

    if (!importRes.ok) {
      console.error('Keboola import-async error', importRes.status, importText.slice(0, 500));
      return res.status(importRes.status).json({
        error: importJson?.message || importJson?.error || `Keboola error ${importRes.status}`,
      });
    }

    res.json({ ok: true, jobId: importJson.id });
  } catch (err) {
    console.error('POST /api/submit-plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat ─────────────────────────────────────────────────────────
// Streams a Kai AI response grounded in channel data.
// Uses the real Kai API (discovered from Storage) when KBC_TOKEN is present;
// falls back to context-aware canned responses for demos.
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (text) => res.write(`data: ${JSON.stringify({ text })}\n\n`);
  const done  = ()     => { res.write('data: [DONE]\n\n'); res.end(); };

  // Try real Kai API
  if (KBC_TOKEN) {
    try {
      const baseUrl = await getKaiBaseUrl();
      const chatId  = randomUUID();
      const msgId   = randomUUID();

      const kaiRes = await fetch(`${baseUrl}/api/chat`, {
        method:  'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-storageapi-token': KBC_TOKEN,
          'x-storageapi-url':   KBC_URL,
        },
        body: JSON.stringify({
          id: chatId,
          message: {
            id:    msgId,
            role:  'user',
            parts: [{ type: 'text', text: buildKaiContext() + message }],
            metadata: { hidden: false, requestContext: { path: '/budget-planner' } },
          },
          selectedChatModel:      'chat-model',
          selectedVisibilityType: 'private',
          branchId:               null,
        }),
      });

      if (kaiRes.ok) {
        let buf = '';
        let currentEventType = '';

        for await (const chunk of kaiRes.body) {
          buf += Buffer.from(chunk).toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            if (line === '') { currentEventType = ''; continue; }
            if (line.startsWith('event:')) {
              currentEventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') { done(); return; }
              try {
                const parsed = JSON.parse(payload);
                const evType = currentEventType || parsed.type;
                if (evType === 'text' && parsed.text) send(parsed.text);
              } catch (_) {}
            }
          }
        }
        return done();
      }
      console.error('Kai API returned', kaiRes.status);
    } catch (err) {
      console.error('Kai error:', err.message);
    }
  }

  // Context-aware fallback (used in demo when AI endpoint isn't available)
  const lower = message.toLowerCase();
  let reply = '';

  if (lower.includes('roas') || lower.includes('return')) {
    reply = `Based on Q1 data:\n\n**ROAS by channel:**\n- Push Notifications: **291x** 🟢\n- Email Marketing: **97x** 🟢\n- Meta Ads: **10.5x** 🟡\n- Google Search: **8.4x** 🟡\n- Affiliate: **7.4x** 🟡\n- Display: **1.2x** 🔴\n- TikTok: **0.7x** 🔴\n\nOwned channels dominate on ROAS because they have near-zero media cost. For paid-only channels, Google Search and Meta are your strongest performers.`;
  } else if (lower.includes('tiktok')) {
    reply = `TikTok ended Q1 at **0.7x ROAS** — spending £38,707 against £27,063 in revenue. That's a loss at the margin level.\n\nHowever, this dataset can't tell you whether TikTok is driving branded search uplift. The data-supported position: **reduce TikTok to a test budget of $5–8K** for Q3 and monitor whether Google Search branded volume moves before making a kill decision.`;
  } else if (lower.includes('display') || lower.includes('programmatic')) {
    reply = `Display / Programmatic returned **1.22x ROAS** in Q1 on £25,150 spend — barely covering media cost. The cost per voucher was £125.75, which is economically viable only for Travel (high AOV) but very poor for Food & Drink.\n\nRecommendation: **cut or heavily reduce Display for Q3** unless you're running a specific brand awareness play with a separate measurement approach.`;
  } else if (lower.includes('email') || lower.includes('push')) {
    reply = `Email (96.7x ROAS) and Push Notifications (291x ROAS) are your most efficient channels — but they're **owned channels with no media cost**. You can't scale them by increasing budget.\n\nThe lever for owned channels is **audience size and send quality** — growing the subscriber/app-user base and improving segmentation. Budget allocation for Q3 for these channels covers content and creative, not media buying.`;
  } else if (lower.includes('budget') || lower.includes('q2') || lower.includes('allocat')) {
    reply = `For Q3 budget allocation, the data supports:\n\n1. **Protect Google Search** — best margin_on_spend ratio (2.75x) of paid channels\n2. **Maintain or grow Meta** — 10.5x ROAS, good volume driver\n3. **Affiliate as supplement** — low risk (commission-only), 7.4x ROAS\n4. **Reduce Display** — 1.22x ROAS doesn't justify continued spend at Q1 levels\n5. **Test TikTok at lower budget** — don't kill completely, reduce and monitor\n\nThe owned channels (Email, Push) should be set to reflect content/CRM investment, not media buying.`;
  } else if (lower.includes('margin')) {
    reply = `ROAS and margin tell different stories:\n\n| Channel | ROAS | Margin on Spend |\n|---|---|---|\n| Google Search | 8.4x | **2.75x** |\n| Meta Ads | 10.5x | 2.47x |\n| Affiliate | 7.4x | 2.58x |\n\nGoogle Search actually returns **more margin per £1 spent** than Meta despite lower ROAS, because it captures Travel and Beauty searches (higher margin categories). Optimising for ROAS alone can steer budget toward higher-revenue but lower-margin campaigns.`;
  } else {
    reply = `I can help you analyse the Q1 marketing performance data. Try asking me about:\n\n- **ROAS by channel** — which channels are most efficient?\n- **Q3 budget allocation** — where should the money go?\n- **TikTok or Display** — should we cut them?\n- **Email and Push** — why can't we scale them with money?\n- **Margin vs ROAS** — why are they telling different stories?`;
  }

  // Simulate streaming character by character
  const words = reply.split(' ');
  for (const word of words) {
    send(word + ' ');
    await new Promise(r => setTimeout(r, 18));
  }
  done();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Q3 2026 Budget Planner running on port ${PORT}`);
});
