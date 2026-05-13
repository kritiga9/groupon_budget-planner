import express from 'express';
import fetch from 'node-fetch';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const KBC_URL   = (process.env.KBC_URL   || 'https://connection.europe-west3.gcp.keboola.com').replace(/\/$/, '');
const KBC_TOKEN = process.env.KBC_TOKEN  || '';

const PERFORMANCE_TABLE = 'out.c-marketing-analytics.weekly_channel_summary';
const BUDGET_PLAN_TABLE = 'in.c-marketing-raw.budget_plan';

app.use(express.json({ limit: '2mb' }));

// ── Health / root (Keboola POSTs to / on startup) ──────────────────────────
app.all('/', (req, res) => res.sendFile(join(__dirname, 'index.html')));
app.use(express.static(__dirname, { index: false }));

// ── GET /api/performance ───────────────────────────────────────────────────
// Returns Q1 channel-level summary aggregated from weekly_channel_summary
app.get('/api/performance', async (req, res) => {
  try {
    const url = `${KBC_URL}/v2/storage/tables/${PERFORMANCE_TABLE}/data-preview?limit=500&format=json`;
    const r   = await fetch(url, {
      headers: { 'X-StorageApi-Token': KBC_TOKEN },
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: `Keboola API error: ${txt.slice(0, 300)}` });
    }
    const raw = await r.json();
    // data-preview returns { columns: [...], rows: [[...], ...] }
    const cols = raw.columns;
    const rows = raw.rows.map(row => {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    });

    // Aggregate to channel level (sum numeric cols, keep channel_name + channel_type)
    const agg = {};
    const NUM = [
      'total_spend_gbp', 'total_revenue_gbp', 'total_platform_margin_gbp',
      'total_impressions', 'total_clicks', 'total_voucher_purchases',
    ];
    for (const row of rows) {
      const key = row.channel_id;
      if (!agg[key]) {
        agg[key] = {
          channel_id:   row.channel_id,
          channel_name: row.channel_name,
          channel_type: row.channel_type,
        };
        NUM.forEach(f => { agg[key][f] = 0; });
      }
      NUM.forEach(f => { agg[key][f] += parseFloat(row[f] || 0); });
    }

    const channels = Object.values(agg).map(c => ({
      ...c,
      total_spend_gbp:            Math.round(c.total_spend_gbp),
      total_revenue_gbp:          Math.round(c.total_revenue_gbp),
      total_platform_margin_gbp:  Math.round(c.total_platform_margin_gbp),
      total_impressions:          Math.round(c.total_impressions),
      total_clicks:               Math.round(c.total_clicks),
      total_voucher_purchases:    Math.round(c.total_voucher_purchases),
      roas: c.total_spend_gbp > 0
        ? parseFloat((c.total_revenue_gbp / c.total_spend_gbp).toFixed(2))
        : 0,
      cost_per_voucher: c.total_voucher_purchases > 0
        ? parseFloat((c.total_spend_gbp / c.total_voucher_purchases).toFixed(2))
        : 0,
      margin_on_spend: c.total_spend_gbp > 0
        ? parseFloat((c.total_platform_margin_gbp / c.total_spend_gbp).toFixed(2))
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
// Writes budget plan rows to Keboola Storage (incremental)
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

    // Use import-async endpoint
    const formData = new FormData();
    formData.append('data', new Blob([csv], { type: 'text/csv' }), 'plan.csv');
    formData.append('incremental', '1');

    const r = await fetch(
      `${KBC_URL}/v2/storage/tables/${BUDGET_PLAN_TABLE}/import-async`,
      {
        method:  'POST',
        headers: { 'X-StorageApi-Token': KBC_TOKEN },
        body:    formData,
      }
    );
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: body?.message || 'Keboola write error' });
    res.json({ ok: true, jobId: body.id });
  } catch (err) {
    console.error('POST /api/submit-plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/chat ─────────────────────────────────────────────────────────
// Lightweight AI chat — streams a response grounded in channel data
// Uses Keboola's internal AI endpoint when KBC_TOKEN is present;
// falls back to a context-aware canned response for demos.
app.post('/api/chat', async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (text) => res.write(`data: ${JSON.stringify({ text })}\n\n`);
  const done  = ()     => { res.write('data: [DONE]\n\n'); res.end(); };

  // Try Keboola AI endpoint first
  if (KBC_TOKEN) {
    try {
      const aiUrl = `${KBC_URL}/v2/ai/conversations`;
      const convR = await fetch(aiUrl, {
        method:  'POST',
        headers: { 'X-StorageApi-Token': KBC_TOKEN, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message, context }),
      });
      if (convR.ok) {
        const convData = await convR.json();
        send(convData.response || convData.message || JSON.stringify(convData));
        return done();
      }
    } catch (_) { /* fall through to context-aware fallback */ }
  }

  // Context-aware fallback (used in demo when AI endpoint isn't available)
  const lower = message.toLowerCase();
  let reply = '';

  if (lower.includes('roas') || lower.includes('return')) {
    reply = `Based on Q1 data:\n\n**ROAS by channel:**\n- Push Notifications: **291x** 🟢\n- Email Marketing: **97x** 🟢\n- Meta Ads: **10.5x** 🟡\n- Google Search: **8.4x** 🟡\n- Affiliate: **7.4x** 🟡\n- Display: **1.2x** 🔴\n- TikTok: **0.7x** 🔴\n\nOwned channels dominate on ROAS because they have near-zero media cost. For paid-only channels, Google Search and Meta are your strongest performers.`;
  } else if (lower.includes('tiktok')) {
    reply = `TikTok ended Q1 at **0.7x ROAS** — spending £38,707 against £27,063 in revenue. That's a loss at the margin level.\n\nHowever, this dataset can't tell you whether TikTok is driving branded search uplift. The data-supported position: **reduce TikTok to a test budget of £5–8K** for Q2 and monitor whether Google Search branded volume moves before making a kill decision.`;
  } else if (lower.includes('display') || lower.includes('programmatic')) {
    reply = `Display / Programmatic returned **1.22x ROAS** in Q1 on £25,150 spend — barely covering media cost. The cost per voucher was £125.75, which is economically viable only for Travel (high AOV) but very poor for Food & Drink.\n\nRecommendation: **cut or heavily reduce Display for Q2** unless you're running a specific brand awareness play with a separate measurement approach.`;
  } else if (lower.includes('email') || lower.includes('push')) {
    reply = `Email (96.7x ROAS) and Push Notifications (291x ROAS) are your most efficient channels — but they're **owned channels with no media cost**. You can't scale them by increasing budget.\n\nThe lever for owned channels is **audience size and send quality** — growing the subscriber/app-user base and improving segmentation. Budget allocation for Q2 for these channels covers content and creative, not media buying.`;
  } else if (lower.includes('budget') || lower.includes('q2') || lower.includes('allocat')) {
    reply = `For Q2 budget allocation, the data supports:\n\n1. **Protect Google Search** — best margin_on_spend ratio (2.75x) of paid channels\n2. **Maintain or grow Meta** — 10.5x ROAS, good volume driver\n3. **Affiliate as supplement** — low risk (commission-only), 7.4x ROAS\n4. **Reduce Display** — 1.22x ROAS doesn't justify continued spend at Q1 levels\n5. **Test TikTok at lower budget** — don't kill completely, reduce and monitor\n\nThe owned channels (Email, Push) should be set to reflect content/CRM investment, not media buying.`;
  } else if (lower.includes('margin')) {
    reply = `ROAS and margin tell different stories:\n\n| Channel | ROAS | Margin on Spend |\n|---|---|---|\n| Google Search | 8.4x | **2.75x** |\n| Meta Ads | 10.5x | 2.47x |\n| Affiliate | 7.4x | 2.58x |\n\nGoogle Search actually returns **more margin per £1 spent** than Meta despite lower ROAS, because it captures Travel and Beauty searches (higher margin categories). Optimising for ROAS alone can steer budget toward higher-revenue but lower-margin campaigns.`;
  } else {
    reply = `I can help you analyse the Q1 marketing performance data. Try asking me about:\n\n- **ROAS by channel** — which channels are most efficient?\n- **Q2 budget allocation** — where should the money go?\n- **TikTok or Display** — should we cut them?\n- **Email and Push** — why can't we scale them with money?\n- **Margin vs ROAS** — why are they telling different stories?`;
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
  console.log(`Q2 Budget Planner running on port ${PORT}`);
});
