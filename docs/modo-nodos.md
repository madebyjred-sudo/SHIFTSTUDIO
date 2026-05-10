# Modo nodos — Shifty Studio

Documento de referencia para el "modo nodos": canvas alterno dentro del
workspace que reemplaza a las hojas TipTap por un grafo dirigido tipo
ReactFlow (contexto → especialistas → exporte). Cubre arquitectura,
flujo de usuario, contratos de wire, variables de entorno,
troubleshooting y la migración V1 → V2 cerrada el 2026-05-10.

Si solo necesitás el contrato del SSE de ejecución del grafo, saltá
directo a [Backend de ejecución](#backend-de-ejecución-cerebro--v1graphexecute).
Para variables, [Variables de entorno](#variables-de-entorno).

---

## Overview

Cada `studio_workspace` tiene dos canvases vivos al mismo tiempo:

1. **Hojas (default)** — TipTap renderizado en posiciones libres (x, y)
   sobre un canvas infinito. Una fila por hoja en `studio_workspace_nodes`.
   Es el flujo principal de escritura colaborativa con el chat de
   workspace. Sin cambios en este documento.
2. **Nodos** — grafo `@xyflow/react` (ReactFlow) que vive *dentro del
   mismo workspace*. Pensado para pipelines reutilizables tipo "leer
   contexto → varios especialistas en paralelo → exportar todo a PPTX".

El usuario alterna entre los dos modos con la pestaña Hojas | Nodos
flotante en el top-center del canvas (ver
`src/pages/WorkspaceCanvasPage.tsx` líneas 1102-1183). La elección se
persiste en `localStorage` por workspace, así que recargar te deja
donde estabas.

**Cuándo usar nodos vs hojas:**

- Hojas → contenido editorial libre, drafting, una idea por hoja,
  copilot llamado por la sidebar de chat.
- Nodos → pipelines repetibles (ej. tres especialistas que generan
  secciones distintas y consolidan en una sola presentación), con
  trazabilidad nodo-a-sección en el deck final.

---

## Arquitectura

```
┌────────────────────────────────────────────────────────────────────┐
│  WorkspaceCanvasPage  (src/pages/WorkspaceCanvasPage.tsx)          │
│  ├── PageModeTabs   (hojas | nodos)                                │
│  └── NodosLayout                                                    │
│      ├── ChatPanel  (no-op para architect/edit en modo nodos)      │
│      └── ShiftyNodeCanvas                                           │
│          ├── store: useActiveGraphStore  (= useGraphStoreV2)        │
│          ├── nodes: ContextNode / SpecialistNode / ExportNode       │
│          ├── autosave: PUT /api/workspace/:id/graph  (debounce 2s)  │
│          ├── ejecución: SSE Cerebro /v1/graph/execute               │
│          └── export: POST /api/workspace/:id/export  (sections[])   │
└────────────────────────────────────────────────────────────────────┘
```

Cuatro piezas que se hablan entre sí, cada una documentada abajo.

### 1. Store: `useGraphStoreV2` (zustand)

- Archivo: `src/store/useGraphStoreV2.ts`
- Entry point público: `src/store/index.ts` exporta
  `useActiveGraphStore` y los tipos `AppNode`, `Snapshot`.

Hasta el 2026-05-10 había dos stores en paralelo (V1 + V2) detrás del
flag `VITE_USE_GRAPH_V2`. La consolidación se hizo en el commit
[`427793e`](https://github.com/madebyjred-sudo/SHIFTSTUDIO/commit/427793e):
V1 fue eliminado, V2 quedó como único store y el flag pasó a ser un
no-op con warning de deprecación.

Estado relevante del store (ver tipos completos en
`useGraphStoreV2.ts:46-110`):

| Campo | Para qué sirve |
|---|---|
| `nodes`, `edges` | xyflow state — opaco para el resto del código |
| `workspaceId` | Set por `WorkspaceCanvasPage` en mount; null fuera del workspace |
| `isExecuting`, `currentExecutionId` | Para el botón Cancelar |
| `runExportNode(nodeId)` | Pipeline cliente: construye sections desde predecesores y llama al endpoint de export |
| `executeGraph()` / `cancelExecution()` | Wrappers del SSE de Cerebro |
| `updateNodeStatus`, `appendNodeOutput` | Mutadores que el cliente SSE llama mientras llegan eventos |
| `hitlState`, `resumeHitl()` | Branch HITL (revisión humana entre nodos) |

### 2. Persistencia: tabla + endpoints

**Tabla** — `studio_workspace_graphs` (migración
`infra/supabase/migrations/0010_studio_workspace_graphs.sql`).

```sql
create table studio_workspace_graphs (
  workspace_id uuid primary key
               references studio_workspaces(id) on delete cascade,
  nodes        jsonb not null default '[]'::jsonb,
  edges        jsonb not null default '[]'::jsonb,
  viewport     jsonb,                            -- nullable
  updated_at   timestamptz not null default now()
);
```

Una fila por workspace, blobs JSONB para `nodes`, `edges` y `viewport`.
Se eligió denormalizado porque el grafo se lee/escribe como unidad,
nunca se consulta por shape interno, y el tamaño típico (≤100 nodos) es
trivial. RLS owner-only via subquery contra el workspace padre.

**Endpoints** — `src/routes/workspace.ts`:

| Verbo | Path | Líneas | Body / Response |
|---|---|---|---|
| `GET` | `/api/workspace/:id/graph` | 797-841 | `{ ok, nodes, edges, viewport, updated_at }` |
| `PUT` | `/api/workspace/:id/graph` | 843-911 | Body `{ nodes, edges, viewport }`; responde la fila persistida |

Cliente: `src/services/workspaceApi.ts:410-478`
(`getGraph` / `saveGraph`). El GET pasa por
`retryIdempotent`; el PUT no se reintenta automáticamente (riesgo de
doble aplicación) — el caller (`ShiftyNodeCanvas`) implementa su propio
backoff exponencial `[1s, 2s, 5s, 10s]`.

**Auto-save** — `src/components/ShiftyNodeCanvas.tsx`, debounce
`AUTOSAVE_DEBOUNCE_MS = 2000`. El badge tiene cinco estados:

```
idle      → sin cambios pendientes (estado inicial o post-recarga limpia)
unsaved   → editaste, debounce en curso
saving    → PUT en vuelo
saved     → "guardado · hace N s" (se refresca cada 15 s)
error     → "no guardó"; retry con backoff exponencial
```

Si una edición entra mientras hay un PUT en vuelo, se setea un
`pendingSaveRef` que dispara otro save inmediatamente al volver del
servidor — sin perder cambios.

### 3. Backend de ejecución (Cerebro · `/v1/graph/execute`)

Archivo cliente: `src/services/graphExecutionApi.ts`.

El runtime de los nodos especialistas vive fuera de Studio, en el
Cerebro Python (gateway). Tres endpoints + un stream SSE:

| Verbo | Path | Para qué |
|---|---|---|
| `POST` | `/v1/graph/execute` | Arranca ejecución; devuelve `{execution_id, status, sse_url}` |
| `GET` | `/v1/graph/execute/:id/events` | Stream SSE — node lifecycle |
| `POST` | `/v1/graph/execute/:id/cancel` | Aborta; idempotente; 404 si ya terminó |

Eventos del SSE (`event:` field literal):

```
node:start     { node_id, started_at }
node:token     { node_id, delta }                     (opcional)
node:complete  { node_id, output, tokens, cost_usd }
node:error     { node_id, error }
graph:done     { sections[], total_cost_usd, total_tokens }
```

`graph:done` es el evento terminal — cuando llega, el cliente cierra el
EventSource y la store dispara automáticamente el `runExportNode` del
nodo `export` que tenga downstream (si existe).

**Auth** — JWT de Supabase en `Authorization: Bearer` para el POST, y
como `?token=` query param en el GET SSE (EventSource del browser no
permite headers custom). `x-tenant-id` viaja en todas las llamadas con
default `shift`, override vía `VITE_CEREBRO_TENANT`.

### 4. Pipeline de export (sections-driven)

Archivo backend: `src/routes/workspace.ts` líneas 2227-…
(`POST /api/workspace/:id/export`).

Cuando el body incluye `sections[]`, el endpoint salta la fetch a
`studio_workspace_nodes` (las hojas) y usa las secciones directamente.
Es así como el grafo "consolida → exporta" sin materializar hojas
temporales.

Cinco formatos válidos para modo nodos:

| Formato | Render | Notas |
|---|---|---|
| `pptx` | Gamma API → presentation/pptx | Async, 2-stage (kick-off + polling `pptx-status`) |
| `pdf` | Gamma API → presentation/pdf | Async, mismo flow de polling |
| `carousel` | Gamma API → social/pdf | Async. **Nota:** Gamma social no exporta `pptx`, se entrega como PDF de tarjetas; el `id` se llama "carousel" para alinear UI/marca pero el archivo es PDF |
| `docx` | `docx` package in-process | Síncrono, blob directo |
| `xlsx` | xlsx in-process | Síncrono. `section.data?.{headers, rows}` se promueve a hoja propia |
| `md`  | Markdown in-process | Síncrono. Heredado del modo hojas, también acepta sections |

Ver `src/types/export.ts` para el contrato `BranchSection`:

```ts
interface BranchSection {
  title: string;
  content: string;
  sourceNodeId?: string;     // trazabilidad nodo-a-sección
  data?: TableData;          // opcional, solo xlsx lo lee
}
```

Wire validation del servidor (líneas 2257-2351): rechaza con códigos
precisos (`sections_must_be_array`, `sections_empty`,
`invalid_section_title`, `invalid_section_table_shape`, etc.) en lugar
de un genérico 400.

---

## Flujo del usuario

```
┌─ Workspaces list  ──────────────────────────────────────────────────┐
│   1. Crear workspace                                                 │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─ Workspace canvas (modo hojas, default) ───────────────────────────┐
│   2. Click pestaña [Nodos]  (top-center)                            │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─ Workspace canvas (modo nodos) ────────────────────────────────────┐
│   3. Right-click pane  → "Agregar nodo"                             │
│   4. context → specialist → export                                  │
│   5. Drag entre handles  (validación visual, ver reglas abajo)     │
│   6. Auto-save cada 2 s   (badge "guardado · hace N s")            │
│   7. Click [Run]   →  SSE muestra progreso por nodo                │
│   8. graph:done   →  runExportNode dispara                          │
│   9. Si format=pptx/pdf/carousel  → polling Gamma                   │
│  10. Descarga: blob (docx/xlsx/md) o URL (pptx/pdf/carousel)        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tipos de nodos y reglas de conexión

Fuente única de verdad: `src/lib/graph-rules.ts`. Validación se ejecuta
en dos lugares: ReactFlow `isValidConnection` (bloquea el drop) y la
capa visual de feedback (tooltip + handle highlight + shake del nodo
destino).

**Tipos visuales** (xyflow): `context`, `specialist`, `export`.
**Aliases backend** (architect): `contexto`, `agente`, `entrega`,
`revision`.

| Origen | Destinos válidos | Comentario |
|---|---|---|
| `context` | `specialist`, `agente` | Inicio del pipeline |
| `specialist` | `specialist`, `export`, `revision`, `entrega`, `agente` | Encadenable + puede llegar a terminal |
| `revision` | `specialist`, `export`, `entrega`, `agente` | Branch HITL |
| `export` | — | Terminal, no acepta salidas |

Reglas inversas (lo que **no** se puede):

- `context → export`  ❌  El export espera output de especialista.
- `* → context`        ❌  Context es source-only.
- `export → *`         ❌  Export es terminal.

Cuando una conexión falla, `validateConnection()` devuelve un `reason`
en español (ver `graph-rules.ts:64-103`) que la capa de feedback
muestra como tooltip. Ej: "Contexto es nodo de origen: no acepta
conexiones entrantes."

---

## Formatos de export

Tabla viva en `src/types/export.ts` (`EXPORT_FORMAT_META`):

| `id` | Label UI | Hint | Backend |
|---|---|---|---|
| `pptx` | Presentación (PPTX) | Slide deck editable | Gamma `presentation/pptx` (async) |
| `carousel` | Carrusel (Social) | Tarjetas tipo Gamma | Gamma `social/pdf` (async) — entrega PDF, no PPTX |
| `docx` | Word (DOCX) | Documento editable | `docx` package in-process (sync) |
| `pdf` | PDF | Documento final | Gamma `presentation/pdf` (async) |
| `xlsx` | Excel (XLSX) | Hoja de cálculo | xlsx in-process (sync) |

Detalle de la disociación pptx/pdf/carousel (async) vs docx/xlsx/md (sync):

- **Async** — el endpoint devuelve `{ status: 'pending', generationId,
  pollingUrl }`. El cliente debe hacer polling contra
  `/api/workspace/:id/export/pptx-status?generation_id=…&format=…`
  hasta `status: 'complete'`. Existe un cache de 1h por workspace+format
  (excepto cuando se mandan `sections`).
- **Sync** — el endpoint setea `Content-Type` + `Content-Disposition`
  y manda el blob directo. No hay polling.

`runExportNode` en el store maneja ambos caminos transparentemente y
publica el resultado en `node.data.exportUrl` (async) o gatilla la
descarga (sync).

---

## Variables de entorno

Sincronizadas con `.env.example`. Las marcadas **(Vite)** se embeben en
el bundle del cliente en build time.

| Var | Default | Uso |
|---|---|---|
| `VITE_GATEWAY_URL` **(Vite)** | `` (vacío → proxy de Vite en dev) | Base URL del Cerebro Python (gateway). En prod: `https://gateway.shiftpn.com` (o equivalente) |
| `VITE_CEREBRO_TENANT` **(Vite)** | `shift` | Viaja como `x-tenant-id` en todas las llamadas de graph-execution. Override solo si el deploy está white-labeled |
| `VITE_MOCK_GRAPH_EXEC` **(Vite)** | `false` | Cuando `"true"`, el cliente NO abre EventSource ni golpea `/v1/graph/execute`. Simula los eventos en proceso con `setTimeout`. Útil mientras Cerebro implementa los endpoints y para QA/E2E sin backend. **Nunca `"true"` en producción** |
| `SWARM_API_URL` | `https://shift-cerebro-production.up.railway.app` | Base del Cerebro Railway. Usado por `peajeClient`, `puntoMedioClient` y el proxy `/api/chat`. **No** es lo mismo que `VITE_GATEWAY_URL` — Railway es la Cerebro v3 multi-app, el gateway Python es el runtime del grafo |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | — | Server-only. La BFF de `/graph` y `/export` los usa via `supabaseAdmin`. Sin ellos, los endpoints responden 503 |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` **(Vite)** | — | Cliente para auth y RLS. El JWT que viaja al gateway sale de acá |
| `GAMMA_API_KEY` | — | Necesario para `pptx`, `pdf`, `carousel`. Sin la key, esos formatos devuelven 502 estructurado; `docx`/`xlsx`/`md` siguen funcionando |
| `CEREBRO_TENANT` | `shift` | Server-side companion de `VITE_CEREBRO_TENANT` para llamadas BFF → Cerebro |
| `CEREBRO_APP_ID` | `studio` | Multi-app v3 routing. **No tocar** |

Modo dev recomendado:

```bash
# .env.local
VITE_MOCK_GRAPH_EXEC="true"   # mientras Cerebro arma los endpoints
VITE_CEREBRO_TENANT="shift"
VITE_GATEWAY_URL=""           # proxy Vite local
```

Modo prod:

```bash
VITE_MOCK_GRAPH_EXEC="false"
VITE_GATEWAY_URL="https://gateway.shiftpn.com"
VITE_CEREBRO_TENANT="shift"
```

---

## Troubleshooting

### Auto-save quedó en "no guardó" y no se recupera

1. Verificar que el workspace todavía exista
   (eliminado → 404 → estado `error` permanente). Refrescar la página
   debería redirigir a la lista de workspaces.
2. Mirar consola del browser para el log
   `[ShiftyNodeCanvas] saveGraph failed: <mensaje>`. Los mensajes más
   comunes:
   - `HTTP 401` → sesión Supabase expiró. Recargar fuerza re-auth.
   - `HTTP 413` → payload >5MB (límite del Express BFF). Indica grafo
     anormalmente grande; bajar la cantidad de nodos o reportar.
   - `HTTP 503` → BFF perdió la conexión a Supabase. Esperar y editar
     algo nuevo dispara un retry.
3. El backoff retry máximo es 10 s. Después de eso, el siguiente save
   solo se dispara al editar. Tocar un nodo cualquiera fuerza un retry
   manual.

### Export devuelve 503

- Formato `pptx`/`pdf`/`carousel`: probablemente
  `GAMMA_API_KEY not set in environment` (ver
  `src/services/gammaApi.ts:205`). Verificar la var en Vercel
  → Settings → Environment Variables y redeploy.
- Cualquier formato: verificar `SUPABASE_URL` y
  `SUPABASE_SERVICE_ROLE_KEY` en el server scope. Sin ellos, todo el
  router de workspace responde 503.

### Export devuelve `invalid_section_*`

El validator del servidor (líneas 2257-2351 de `workspace.ts`) es
estricto. Códigos comunes:

| Código | Causa | Fix cliente |
|---|---|---|
| `sections_empty` | Array vacío | `runExportNode` no debería llamar si no hay predecesores; verificar que el export tenga al menos un specialist upstream |
| `invalid_section_title` | Título vacío o no-string | Verificar que cada specialist termine con un nombre/label antes de `graph:done` |
| `invalid_section_content` | Content no-string | El backend exige string aunque sea `""` |
| `invalid_section_table_shape` | `rows[i].length !== headers.length` | Solo aplica si pasaste `data` opcional; corregir alineación |

### SSE se desconecta a mitad de ejecución

EventSource browser-side autorrecupera de blips transitorios; nuestro
handler solo trata como fatal cuando `readyState === CLOSED` (ver
`graphExecutionApi.ts:310-320`). Si ves un `onConnectionError` real:

1. Verificar `VITE_GATEWAY_URL` apuntando al gateway correcto.
2. Si estás en local sin gateway, setear `VITE_MOCK_GRAPH_EXEC="true"`.
3. Si Cerebro está caído, el flag `PEAJE_ENABLED="false"` no ayuda — ese
   es para el ingest. El runtime del grafo no tiene kill-switch
   equivalente; cancelExecution localmente sí limpia el estado.

### Cambié de modo Hojas ↔ Nodos y se perdió el viewport del grafo

El viewport se hidrata en el `useEffect` de
`ShiftyNodeCanvas.tsx:155-213` desde `getGraph(workspaceId)`. Si el
servidor devolvió `viewport: null` (canvas nuevo, nunca pan/zoom),
ReactFlow usa su default. Para forzar `fitView` después de hidratar,
usar la barra inferior derecha del canvas (control nativo de xyflow).

### "Tipo de nodo desconocido"

`validateConnection()` rechaza tipos fuera de su map. Si ves este error
en consola, probablemente persististe un grafo viejo con un tipo
deprecado. Workarounds:

1. Editar el JSON crudo en Supabase Studio →
   `studio_workspace_graphs` → fila del workspace → setear `nodes` a
   `[]` y `edges` a `[]`. Forzar un refresh.
2. O eliminar la fila — el grafo vuelve a estado vacío.

---

## Migration history — V1 → V2

Cronología comprimida (ver `git log --oneline | grep "modo nodos"` para
el detalle):

| Commit | Fecha | Qué pasó |
|---|---|---|
| `2f6dac2` | 2026-05-10 | A1: tabla `studio_workspace_graphs` + endpoints `GET/PUT /:id/graph` |
| `8782209` | 2026-05-10 | A2: ExportNode UI con 5 formatos |
| `ebee9fd` | 2026-05-10 | B1: `/export` acepta `sections[]` + 5 formatos backend |
| `92732c5` | 2026-05-10 | C1: wirear ExportNode V2 al endpoint sections-driven |
| **`427793e`** | **2026-05-10** | **D1: consolidación V1→V2 + auto-save (493 LOC borrados)** |
| `2b79629` | 2026-05-10 | D2: eliminar `/api/export` legacy proxy |
| `aacd3c0` | 2026-05-10 | F1: toggle Hojas/Nodos dentro del workspace |
| `c11f850` | 2026-05-10 | E2: SSE client + mock toggleable |
| `16e4a84` | 2026-05-10 | F2: feedback visual de validación de conexiones |

### Qué cambió en D1 (consolidación)

Antes de `427793e`:

- Dos stores zustand paralelos: `useGraphStore.ts` (V1) y
  `useGraphStoreV2.ts` (V2).
- Flag `VITE_USE_GRAPH_V2` decidía cuál exportaba `useActiveGraphStore`.
- V1 hacía ejecución local-ish (sin SSE), usaba `/api/export` legacy
  con un path distinto al workspace.
- V2 ya estaba wireada al `/api/workspace/:id/export` + Cerebro SSE
  pero atrás del flag.

Después de `427793e`:

- `useGraphStore.ts` eliminado (~493 LOC).
- `useGraphStoreV2.ts` queda como única implementación.
- `src/store/index.ts` exporta `useActiveGraphStore = useGraphStoreV2`
  sin condiciones.
- El flag `VITE_USE_GRAPH_V2` se lee solo para emitir un warning si
  está en `"false"` ("ignored — V1 was removed").
- `/api/export` legacy borrado por D2 (`2b79629`).

### Breaking changes

Para consumidores externos del store (todos internos en este monorepo,
pero documentado por si alguien duplicó la lógica):

```ts
// ANTES (pre-D1)
import { useGraphStore } from 'src/store/useGraphStore';     // V1
import { useGraphStoreV2 } from 'src/store/useGraphStoreV2'; // V2
import { useActiveGraphStore } from 'src/store';             // según flag

// DESPUÉS (post-D1)
import { useActiveGraphStore } from 'src/store';             // siempre V2
// equivalente: import { useGraphStoreV2 } from 'src/store/useGraphStoreV2';
```

El nombre `useGraphStoreV2` se mantiene por arqueología git. No se
renombra a `useGraphStore` para evitar churn en el árbol de imports —
nuevos imports deben usar `useActiveGraphStore`.

### Migración de datos (no-op)

V1 nunca persistió grafos (era in-memory only — un refresh perdía
todo). La tabla `studio_workspace_graphs` se introduce en V2 con la
migración 0010. Por lo tanto:

- **Producción al momento del cutover (2026-05-10)**: cero filas en
  `studio_workspace_graphs`. Cada workspace empieza con grafo vacío
  la primera vez que el usuario entra a modo nodos. No hay migración
  de datos que hacer.
- **Workspaces que el usuario abrió en V1 antes de D1**: el grafo
  estaba en memoria del navegador; un refresh ya lo perdía. No hay
  nada que recuperar.

Si en un futuro V2 cambia el shape de `nodes[]` o `edges[]`, agregar
una migración numerada en `infra/supabase/migrations/` y un
adapter de lectura en `getGraph` antes de devolver al cliente.

---

## Referencias rápidas

| Tema | Archivo / línea |
|---|---|
| Store V2 (estado + acciones) | `src/store/useGraphStoreV2.ts` |
| Entry point store + alias | `src/store/index.ts` |
| Reglas de conexión + validador | `src/lib/graph-rules.ts` |
| Tipos compartidos (ExportFormat, BranchSection) | `src/types/export.ts` |
| Cliente HTTP `/graph` + `/export` | `src/services/workspaceApi.ts` (líneas 380-478 para `/graph`) |
| Cliente SSE Cerebro | `src/services/graphExecutionApi.ts` |
| Canvas ReactFlow + autosave | `src/components/ShiftyNodeCanvas.tsx` |
| Nodos visuales | `src/components/nodes/{ContextNode,SpecialistNode,ExportNode}.tsx` |
| Tabs Hojas/Nodos + NodosLayout | `src/pages/WorkspaceCanvasPage.tsx` (líneas 1102-1269) |
| Endpoints BFF `/graph` | `src/routes/workspace.ts:797-911` |
| Endpoint BFF `/export` (sections) | `src/routes/workspace.ts:2227-…` |
| Migración tabla | `infra/supabase/migrations/0010_studio_workspace_graphs.sql` |
