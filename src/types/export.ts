/**
 * Export format identifiers used by the node-graph `export` node.
 *
 * The values are sent verbatim to `/api/export` (see `useGraphStore.ts`),
 * so wave B (backend) must accept these exact strings:
 *   - `pptx`     → Presentación
 *   - `carousel` → Carrusel social (Gamma cards)
 *   - `docx`     → Word
 *   - `pdf`      → PDF
 *   - `xlsx`     → Excel
 */
export type ExportFormat = 'pptx' | 'carousel' | 'docx' | 'pdf' | 'xlsx';

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  'pptx',
  'carousel',
  'docx',
  'pdf',
  'xlsx',
] as const;

export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'pptx';

export interface ExportFormatMeta {
  id: ExportFormat;
  /** Spanish label shown in the picker. */
  label: string;
  /** Short hint used as helper text or aria-description. */
  hint: string;
  /** CSS variable from `index.css` used for the format swatch / accent. */
  cssVar: `--chart-${1 | 2 | 3 | 4 | 5}`;
}

/**
 * Tabular data attached to a section. When present, the xlsx exporter
 * surfaces it as its own sheet (richer than the default {title, content}
 * row); other formats currently ignore it (Gamma decks render markdown
 * tables fine on their own, so PDF/PPTX/carousel can keep them inline
 * inside `content`).
 *
 * `headers.length` should equal `rows[i].length` for every row — the
 * server rejects mismatched shapes with `invalid_section_table`.
 */
export interface TableData {
  headers: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

/**
 * One unit of consolidated specialist output, produced by the modo nodos
 * graph runner and consumed by `/api/workspace/:id/export`.
 *
 * When `sections[]` is sent, the export endpoint skips the workspace-hojas
 * fetch entirely and uses these directly. This is the wire format that
 * lets the ReactFlow grafo "consolidate → export" without persisting
 * temporary hojas.
 *
 * `sourceNodeId` is informational only — it lets the xlsx exporter
 * surface the producer specialist next to each row, and lets future
 * audit views trace a deck slide back to its source. `data` is optional
 * tabular content that the xlsx exporter promotes to its own sheet.
 */
export interface BranchSection {
  title: string;
  content: string;
  sourceNodeId?: string;
  data?: TableData;
}

export const EXPORT_FORMAT_META: Record<ExportFormat, ExportFormatMeta> = {
  pptx: {
    id: 'pptx',
    label: 'Presentación (PPTX)',
    hint: 'Slide deck editable',
    cssVar: '--chart-1',
  },
  carousel: {
    id: 'carousel',
    label: 'Carrusel (Social)',
    hint: 'Tarjetas tipo Gamma',
    cssVar: '--chart-5',
  },
  docx: {
    id: 'docx',
    label: 'Word (DOCX)',
    hint: 'Documento editable',
    cssVar: '--chart-3',
  },
  pdf: {
    id: 'pdf',
    label: 'PDF',
    hint: 'Documento final',
    cssVar: '--chart-4',
  },
  xlsx: {
    id: 'xlsx',
    label: 'Excel (XLSX)',
    hint: 'Hoja de cálculo',
    cssVar: '--chart-2',
  },
};
