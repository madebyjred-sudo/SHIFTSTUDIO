# Shift Studio

Studio frontend + Express BFF.

Conectado a Cerebro Railway (multi-app v3) — chats generan training_pairs con
`app_id="studio"` y el widget `<cerebro-feedback>` (servido por Cerebro) captura
likes/dislikes per-message.

## Stack

- React 19 + Vite 6 + Tailwind v4
- Express BFF (`server.ts`) — proxy al SWARM_API_URL (Cerebro)
- Vercel functions paralelas (`api/chat.ts`, `api/debate.ts`) para deploy serverless

## Run local

```bash
npm install
cp .env.example .env.local
# editar SWARM_API_URL + OPENROUTER_API_KEY si aplica
npm run dev
```

## Deploy

### Vercel (recomendado)

1. `vercel link` (si no estaba)
2. `vercel --prod`

`vercel.json` ya tiene rewrites: `/api/*` → serverless functions, todo lo demás
→ `index.html` (SPA).

### Env vars en Vercel

| Var | Valor |
|---|---|
| `SWARM_API_URL` | `https://web-production-143119.up.railway.app` |
| `OPENROUTER_API_KEY` | (tu key) |
| `NODE_ENV` | `production` |

## Widget Cerebro

`index.html` carga el widget desde Cerebro Railway:
```html
<script type="module"
        src="https://web-production-143119.up.railway.app/widget/cerebro-feedback.js">
</script>
```

Bajo cada respuesta del agente, `<cerebro-feedback>` aparece con 👍/👎. Click 👎
abre 6 chips taxonomizados + textbox opcional. Cada evento POST a
`/v1/feedback` del Cerebro → `cerebro_feedback_events` row.

## Datos que escribe a Cerebro

Cada chat:
1. `peaje_insights` (insight extraído por Kimi K2.6, scrubbed PII, taxonomía validada)
2. `cerebro_training_pairs` (system + user + response + skill_version FK + legal_status flag)
3. `peaje_router_decisions` (insight-router agent decide bucket + global promotion)

Cada like/dislike:
1. `cerebro_feedback_events` (raw signal append-only)
2. cache update en `cerebro_training_pairs` (like_count, dislike_count, quality_label)
