-- ════════════════════════════════════════════════════════════════════
-- 0011_studio_templates.sql
-- ════════════════════════════════════════════════════════════════════
-- APPLY MANUALLY — paste into Supabase Studio → SQL Editor for project
-- `lqrrtyqhlpupmjzydbck`, OR run via psql against $SUPABASE_DB_URL (see
-- infra/supabase/migrations/README.md → Option B).
--
-- studio_templates — curated starting points for "modo nodos".
--
-- Wave-E rationale: the empty canvas is the hardest UX moment in modo
-- nodos. A user landing on the graph builder without a vocabulary for
-- agents, prompts, or edges stalls. Templates solve this by giving 5-7
-- pre-armed DAGs ("Brief creativo", "Plan de campaña", "Análisis
-- performance", "Reporte financiero", "Pitch ejecutivo") that the user
-- loads with one click; Shifty then offers to personalize it.
--
-- Shape choice: ONE row per template. The whole DAG (nodes + edges) is
-- stored as opaque JSONB on `dag_json`. We never query inner shape — the
-- frontend hydrates `useGraphStoreV2` directly from the blob. If we
-- later want per-agent template search we can index `dag_json -> nodes`
-- at that time; for now keep schema permissive.
--
-- Tenant scoping: `tenant_id text` so each tenant can curate its own
-- set ("shift" today, "cl2" / future enterprise later). Templates are
-- shared across all users within a tenant (no per-user privacy). We
-- enforce uniqueness on `(tenant_id, slug)` so callers can reference a
-- template by stable identifier across deploys.

create table if not exists studio_templates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text not null default 'shift',
  slug          text not null,
  name          text not null,
  description   text,
  thumbnail_url text,
  dag_json      jsonb not null,
  category      text,
  sort_order    integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, slug)
);

-- ─── RLS ─────────────────────────────────────────────────────────────
-- Templates are read-public-per-tenant. Any authenticated user (or anon
-- if we ever expose the gallery on the marketing site) can SELECT active
-- rows; writes are service_role only (no insert/update/delete policy is
-- created, so they fall through to RLS-deny for non-service callers).

alter table studio_templates enable row level security;

drop policy if exists "studio_templates_read" on studio_templates;
create policy "studio_templates_read" on studio_templates
  for select
  using (active = true);

-- ─── Indexes ─────────────────────────────────────────────────────────
create index if not exists studio_templates_tenant_idx
  on studio_templates (tenant_id, active, sort_order);

-- ─── updated_at trigger ──────────────────────────────────────────────
-- Reuses the generic `studio_touch_updated_at()` function created in
-- 0001_studio_workspace.sql.
drop trigger if exists studio_templates_touch on studio_templates;
create trigger studio_templates_touch before update on studio_templates
  for each row execute function studio_touch_updated_at();

-- ─── Seed data ────────────────────────────────────────────────────────
-- Five curated templates per the PO spec. Each DAG uses the same shape
-- the executor consumes (studio_graph.models.GraphNode / GraphEdge):
--
--   nodes[*]: { id, type: 'context' | 'specialist' | 'export',
--               position: {x,y}, data: { ... } }
--   edges[*]: { id, source, target }
--
-- The `position` field is honored by ReactFlow on hydration; we use a
-- vertical layout (y increases downstream) so the auto-layout button is
-- optional. The frontend may pass these through getLayoutedElements()
-- before rendering, but the seed positions are reasonable defaults.
--
-- All inserts are idempotent on `(tenant_id, slug)` so re-running the
-- migration is safe.

insert into studio_templates (tenant_id, slug, name, description, category, sort_order, dag_json)
values
  (
    'shift', 'brief-creativo', 'Brief creativo',
    'Contexto del proyecto → Catalina arma el brief → Daniela aporta competencia → entrega DOCX.',
    'creativo', 10,
    $${
      "nodes": [
        {"id": "ctx-1", "type": "context", "position": {"x": 300, "y": 0},
         "data": {"content": "Describí el proyecto, el cliente, los objetivos y el público."}},
        {"id": "spec-catalina", "type": "specialist", "position": {"x": 300, "y": 180},
         "data": {"agent": "catalina", "agent_id": "catalina",
                  "label": "Brief estructurado",
                  "prompt": "Tomá el contexto del proyecto en {{input}} y armá un brief creativo en formato estándar (objetivo, público, mensaje clave, tonalidad, deliverables, plazos).",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 1200, "temperature": 0.4}},
        {"id": "spec-daniela", "type": "specialist", "position": {"x": 300, "y": 380},
         "data": {"agent": "daniela", "agent_id": "daniela",
                  "label": "Competencia y referencias",
                  "prompt": "Sobre el brief de {{input}}, sumá 3 referencias del sector y un análisis breve de qué está haciendo la competencia.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 800, "temperature": 0.5}},
        {"id": "out-1", "type": "export", "position": {"x": 300, "y": 580},
         "data": {"format": "docx", "label": "Brief creativo"}}
      ],
      "edges": [
        {"id": "e1", "source": "ctx-1", "target": "spec-catalina"},
        {"id": "e2", "source": "spec-catalina", "target": "spec-daniela"},
        {"id": "e3", "source": "spec-daniela", "target": "out-1"}
      ]
    }$$::jsonb
  ),
  (
    'shift', 'plan-campana', 'Plan de campaña',
    'Contexto + brandhub → Catalina (mensaje) + Diego (producto) en paralelo → Synth en PPTX.',
    'estrategia', 20,
    $${
      "nodes": [
        {"id": "ctx-1", "type": "context", "position": {"x": 100, "y": 0},
         "data": {"content": "Brief comercial / brandhub del cliente. Objetivo: lanzar campaña Q."}},
        {"id": "ctx-2", "type": "context", "position": {"x": 500, "y": 0},
         "data": {"content": "Tono, identidad visual, anclas de marca (pegar del brandhub)."}},
        {"id": "spec-catalina", "type": "specialist", "position": {"x": 100, "y": 200},
         "data": {"agent": "catalina", "agent_id": "catalina",
                  "label": "Mensaje y narrativa",
                  "prompt": "Sobre {{input}} definí el mensaje principal, 3 secundarios y la promesa de marca.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 1000, "temperature": 0.5}},
        {"id": "spec-diego", "type": "specialist", "position": {"x": 500, "y": 200},
         "data": {"agent": "diego", "agent_id": "diego",
                  "label": "Producto y oferta",
                  "prompt": "Sobre {{input}} listá producto/servicio, diferenciales y oferta concreta para esta campaña.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 1000, "temperature": 0.4}},
        {"id": "spec-synth", "type": "specialist", "position": {"x": 300, "y": 420},
         "data": {"agent": "shiftai", "agent_id": "shiftai",
                  "label": "Plan de campaña consolidado",
                  "prompt": "Consolidá las dos entradas de {{input}} en un plan ejecutivo con: mensaje rector, 3 piezas creativas, calendario tentativo y KPI.",
                  "model": "anthropic/claude-opus-4.7", "max_tokens": 1500, "temperature": 0.4}},
        {"id": "out-1", "type": "export", "position": {"x": 300, "y": 640},
         "data": {"format": "pptx", "label": "Plan de campaña"}}
      ],
      "edges": [
        {"id": "e1", "source": "ctx-1", "target": "spec-catalina"},
        {"id": "e2", "source": "ctx-2", "target": "spec-diego"},
        {"id": "e3", "source": "spec-catalina", "target": "spec-synth"},
        {"id": "e4", "source": "spec-diego", "target": "spec-synth"},
        {"id": "e5", "source": "spec-synth", "target": "out-1"}
      ]
    }$$::jsonb
  ),
  (
    'shift', 'analisis-performance', 'Análisis de performance',
    'Contexto + datos → Jorge analiza → revisión → Mateo arma recomendaciones → PDF.',
    'analytics', 30,
    $${
      "nodes": [
        {"id": "ctx-1", "type": "context", "position": {"x": 100, "y": 0},
         "data": {"content": "Período analizado, objetivos del cliente, canales activos."}},
        {"id": "ctx-2", "type": "context", "position": {"x": 500, "y": 0},
         "data": {"content": "Pegá métricas brutas: impresiones, clicks, CTR, CPC, conversiones por canal."}},
        {"id": "spec-jorge", "type": "specialist", "position": {"x": 300, "y": 200},
         "data": {"agent": "jorge", "agent_id": "jorge",
                  "label": "Lectura de datos",
                  "prompt": "Analizá los datos en {{input}}: identificá top 3 hallazgos, top 3 problemas y 3 anomalías. Justificá con números.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 1200, "temperature": 0.3}},
        {"id": "spec-review", "type": "specialist", "position": {"x": 300, "y": 400},
         "data": {"agent": "andres", "agent_id": "andres",
                  "label": "Revisión analítica",
                  "prompt": "Validá los hallazgos de {{input}}: ¿se sostienen estadísticamente? ¿qué falta? Devolvé un veredicto breve.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 800, "temperature": 0.2}},
        {"id": "spec-mateo", "type": "specialist", "position": {"x": 300, "y": 600},
         "data": {"agent": "mateo", "agent_id": "mateo",
                  "label": "Recomendaciones",
                  "prompt": "Sobre el análisis validado en {{input}}, escribí 5 recomendaciones accionables priorizadas por impacto.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 1000, "temperature": 0.4}},
        {"id": "out-1", "type": "export", "position": {"x": 300, "y": 820},
         "data": {"format": "pdf", "label": "Análisis de performance"}}
      ],
      "edges": [
        {"id": "e1", "source": "ctx-1", "target": "spec-jorge"},
        {"id": "e2", "source": "ctx-2", "target": "spec-jorge"},
        {"id": "e3", "source": "spec-jorge", "target": "spec-review"},
        {"id": "e4", "source": "spec-review", "target": "spec-mateo"},
        {"id": "e5", "source": "spec-mateo", "target": "out-1"}
      ]
    }$$::jsonb
  ),
  (
    'shift', 'reporte-financiero', 'Reporte financiero',
    'Contexto financiero → Mateo arma estados → Patricia revisa compliance → XLSX.',
    'finanzas', 40,
    $${
      "nodes": [
        {"id": "ctx-1", "type": "context", "position": {"x": 300, "y": 0},
         "data": {"content": "Pegá los datos financieros del período: ingresos, costos, gastos, impuestos."}},
        {"id": "spec-mateo", "type": "specialist", "position": {"x": 300, "y": 200},
         "data": {"agent": "mateo", "agent_id": "mateo",
                  "label": "Estados financieros",
                  "prompt": "Sobre {{input}} armá un resumen ejecutivo: P&L sintético, márgenes, principales desvíos vs presupuesto. Sé conservador.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 1200, "temperature": 0.2}},
        {"id": "spec-patricia", "type": "specialist", "position": {"x": 300, "y": 400},
         "data": {"agent": "patricia", "agent_id": "patricia",
                  "label": "Compliance y riesgos",
                  "prompt": "Sobre el reporte de {{input}}, marcá 3 riesgos contables/regulatorios y 2 oportunidades de optimización fiscal.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 800, "temperature": 0.3}},
        {"id": "out-1", "type": "export", "position": {"x": 300, "y": 600},
         "data": {"format": "xlsx", "label": "Reporte financiero"}}
      ],
      "edges": [
        {"id": "e1", "source": "ctx-1", "target": "spec-mateo"},
        {"id": "e2", "source": "spec-mateo", "target": "spec-patricia"},
        {"id": "e3", "source": "spec-patricia", "target": "out-1"}
      ]
    }$$::jsonb
  ),
  (
    'shift', 'pitch-ejecutivo', 'Pitch ejecutivo',
    'Contexto + brandhub → Isabella narrativa → Santiago oferta comercial → PPTX.',
    'comercial', 50,
    $${
      "nodes": [
        {"id": "ctx-1", "type": "context", "position": {"x": 100, "y": 0},
         "data": {"content": "Quién es el prospecto, qué problema queremos resolverle, qué hay sobre la mesa."}},
        {"id": "ctx-2", "type": "context", "position": {"x": 500, "y": 0},
         "data": {"content": "Brandhub Shift: anclas, propuesta de valor, diferenciales (pegar del brandhub)."}},
        {"id": "spec-isabella", "type": "specialist", "position": {"x": 100, "y": 200},
         "data": {"agent": "isabella", "agent_id": "isabella",
                  "label": "Narrativa del pitch",
                  "prompt": "Sobre {{input}} escribí la narrativa en 5 actos: problema, evidencia, solución, prueba, próximo paso. Tonalidad ejecutiva.",
                  "model": "anthropic/claude-opus-4.7", "max_tokens": 1400, "temperature": 0.5}},
        {"id": "spec-santiago", "type": "specialist", "position": {"x": 500, "y": 200},
         "data": {"agent": "santiago", "agent_id": "santiago",
                  "label": "Oferta comercial",
                  "prompt": "Sobre {{input}} armá la oferta comercial: alcance, hitos, equipo, inversión estimada, condiciones.",
                  "model": "anthropic/claude-sonnet-4.6", "max_tokens": 1000, "temperature": 0.3}},
        {"id": "out-1", "type": "export", "position": {"x": 300, "y": 440},
         "data": {"format": "pptx", "label": "Pitch ejecutivo"}}
      ],
      "edges": [
        {"id": "e1", "source": "ctx-1", "target": "spec-isabella"},
        {"id": "e2", "source": "ctx-2", "target": "spec-santiago"},
        {"id": "e3", "source": "spec-isabella", "target": "out-1"},
        {"id": "e4", "source": "spec-santiago", "target": "out-1"}
      ]
    }$$::jsonb
  )
on conflict (tenant_id, slug) do update set
  name          = excluded.name,
  description   = excluded.description,
  category      = excluded.category,
  sort_order    = excluded.sort_order,
  dag_json      = excluded.dag_json,
  active        = true,
  updated_at    = now();

-- ─── DOWN ROLLBACK ───────────────────────────────────────────────────
-- drop trigger if exists studio_templates_touch on studio_templates;
-- drop policy if exists "studio_templates_read" on studio_templates;
-- drop index  if exists studio_templates_tenant_idx;
-- drop table  if exists studio_templates;
