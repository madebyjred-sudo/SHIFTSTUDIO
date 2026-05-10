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
