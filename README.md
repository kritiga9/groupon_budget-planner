# Q2 Budget Planner — Keboola JS Data App

Interactive Q2 marketing budget planning tool. Reads Q1 channel performance from
`out.c-marketing-analytics.weekly_channel_summary`, lets analysts propose Q2 allocations,
and writes submissions back to `in.c-marketing-raw.budget_plan`.

## Stack
- **Backend:** Node.js + Express (port 3000)
- **Frontend:** Vanilla JS/HTML/CSS (single file, no build step)
- **Nginx:** Keboola proxy on port 8888 → app on 3000
- **Streaming:** SSE on `/api/chat` for KAI token streaming

## Pages
| Page | Description |
|---|---|
| 📊 Overview | Q1 KPI cards, ROAS bar chart, channel breakdown table, insight callouts |
| 💰 Budget Planner | Per-channel Q2 inputs, real-time projected revenue, submit → Keboola writeback |
| 🤖 Ask KAI | Streaming chat grounded in Q1 channel data |
| 💬 Feedback | Google Chat webhook modal (top-right button) |

## Deploying to Keboola

### 1. Push this repo to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-org/q2-budget-planner.git
git push -u origin main
```

### 2. Create a new Data App in Keboola
- Go to **Data Apps** → **+ New Data App** → **Custom App (Git)**
- Set Repository URL to your GitHub repo
- Set Branch to `main`
- Set App Type to **Custom**

### 3. Add secrets
In the Data App → **Advanced Settings** → **Secrets**, add:
| Key | Value |
|---|---|
| `#KBC_TOKEN` | Your Keboola Storage API token (Full Access) |
| `#KBC_URL` | `https://connection.europe-west3.gcp.keboola.com` |
| `#FEEDBACK_WEBHOOK_URL` | Your Google Chat webhook URL (optional) |

### 4. Deploy
Click **Deploy**. First deploy takes ~60–90s while npm installs.

## Local development
```bash
export KBC_URL=https://connection.europe-west3.gcp.keboola.com
export KBC_TOKEN=your-token-here
npm install
npm run dev
# Open http://localhost:3000
```

## Adding your Google Chat webhook
In `index.html`, replace the empty `window.FEEDBACK_WEBHOOK_URL = ''` with your webhook URL,
or inject it server-side in `server.js` by replacing the placeholder in the HTML response.
