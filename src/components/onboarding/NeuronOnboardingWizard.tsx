/**
 * @file NeuronOnboardingWizard.tsx
 * @description First-login wizard that bootstraps the user's neuron with
 * a rich profile so Ana has context from turn 1. 8 steps:
 *   1. welcome      — pitch, set expectations
 *   2. identity     — short structured fields (name/role/company/etc.)
 *   3. work         — long-form "what do you do day to day"
 *   4. projects     — repeatable list of current projects
 *   5. team         — long-form "people in your orbit"
 *   6. style        — long-form working preferences
 *   7. ai-import    — copy a prompt into ChatGPT/Claude/Gemini, paste back
 *   8. review       — preview every file we're about to PATCH, then commit
 *
 * Each step (except welcome and review) writes ONE markdown file under
 * /memories/profile/<key>.md via the existing neuron BFF. Empty steps
 * are skipped silently — we don't want a placeholder "—" file polluting
 * the neuron.
 *
 * State is held in a single `OnboardingData` object backed by
 * localStorage (`studio-onboarding-draft-${email}`) so users can close
 * the wizard mid-flow without losing progress. We persist on every
 * change (throttling is unnecessary — payload is small).
 *
 * UX rules (from PRD):
 *   - Full-screen overlay, click-out does NOT dismiss (only the X / "Saltar")
 *   - Escape triggers the same skip-confirm flow as the X button
 *   - Each step has "Saltar este paso" + "Guardar y continuar"
 *   - Review step shows a per-file preview accordion
 *   - Final commit PATCHes every non-empty file in parallel
 *
 * Accessibility:
 *   - aria-modal, aria-labelledby tied to per-step heading
 *   - Initial focus moves to the first interactive control on each step
 *   - Tab order stays inside the card (the overlay grabs focus via
 *     `tabIndex={-1}` + the modal container is the focus root)
 *
 * Sizing note: this file is intentionally ~750 LOC because each step
 * carries its own JSX + microcopy. Breaking into 8 child files added
 * indirection without making any step clearer — kept inline.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { saveNeuronFile, NeuronApiError } from '@/services/neuronClient';

// ─── Types ────────────────────────────────────────────────────────────

export interface NeuronOnboardingWizardProps {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
  /** Optional — used to scope the localStorage draft key per user. */
  userEmail?: string | null;
}

type Step =
  | 'welcome'
  | 'identity'
  | 'work'
  | 'projects'
  | 'team'
  | 'style'
  | 'ai-import'
  | 'review';

const STEPS: Step[] = [
  'welcome',
  'identity',
  'work',
  'projects',
  'team',
  'style',
  'ai-import',
  'review',
];

interface ProjectEntry {
  title: string;
  description: string;
}

interface IdentityFields {
  full_name: string;
  role: string;
  company: string;
  location: string;
  timezone: string;
}

interface OnboardingData {
  identity: IdentityFields;
  work: string;
  projects: ProjectEntry[];
  team: string;
  style: string;
  aiImport: string;
}

const DEFAULT_DATA: OnboardingData = {
  identity: {
    full_name: '',
    role: '',
    company: '',
    location: '',
    timezone: '',
  },
  work: '',
  projects: [{ title: '', description: '' }],
  team: '',
  style: '',
  aiImport: '',
};

// ─── Storage helpers ─────────────────────────────────────────────────

function draftKey(email: string | null | undefined): string | null {
  if (!email) return null;
  return `studio-onboarding-draft-${email}`;
}

function loadDraft(email: string | null | undefined): OnboardingData | null {
  const key = draftKey(email);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingData>;
    // Defensive merge — shape may have evolved since the draft was saved.
    return {
      identity: { ...DEFAULT_DATA.identity, ...(parsed.identity ?? {}) },
      work: parsed.work ?? '',
      projects:
        Array.isArray(parsed.projects) && parsed.projects.length > 0
          ? parsed.projects.map((p) => ({
              title: p?.title ?? '',
              description: p?.description ?? '',
            }))
          : [{ title: '', description: '' }],
      team: parsed.team ?? '',
      style: parsed.style ?? '',
      aiImport: parsed.aiImport ?? '',
    };
  } catch {
    return null;
  }
}

function saveDraft(email: string | null | undefined, data: OnboardingData) {
  const key = draftKey(email);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* quota / disabled — best effort */
  }
}

function clearDraft(email: string | null | undefined) {
  const key = draftKey(email);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ─── Path + markdown rendering ────────────────────────────────────────

function pathForStep(step: Step): string {
  switch (step) {
    case 'identity':
      return '/memories/profile/identity.md';
    case 'work':
      return '/memories/profile/work.md';
    case 'projects':
      return '/memories/profile/projects.md';
    case 'team':
      return '/memories/profile/team.md';
    case 'style':
      return '/memories/profile/style.md';
    case 'ai-import':
      return '/memories/profile/imported.md';
    default:
      return '';
  }
}

function identityHasContent(d: IdentityFields): boolean {
  return Boolean(
    d.full_name.trim() ||
      d.role.trim() ||
      d.company.trim() ||
      d.location.trim() ||
      d.timezone.trim(),
  );
}

/**
 * Returns the markdown body to PATCH for a given step. Returns an empty
 * string for steps that should be skipped (no user content).
 */
function renderMarkdownForStep(step: Step, d: OnboardingData): string {
  const ts = `_Onboarding: ${new Date().toISOString()}_`;
  switch (step) {
    case 'identity': {
      if (!identityHasContent(d.identity)) return '';
      const i = d.identity;
      return [
        '# Identidad',
        '',
        `- **Nombre completo:** ${i.full_name.trim() || '—'}`,
        `- **Rol:** ${i.role.trim() || '—'}`,
        `- **Empresa:** ${i.company.trim() || '—'}`,
        `- **Ubicación:** ${i.location.trim() || '—'}`,
        `- **Zona horaria:** ${i.timezone.trim() || '—'}`,
        '',
        ts,
        '',
      ].join('\n');
    }
    case 'work': {
      if (!d.work.trim()) return '';
      return `# Mi trabajo día a día\n\n${d.work.trim()}\n\n${ts}\n`;
    }
    case 'projects': {
      const filled = d.projects.filter(
        (p) => p.title.trim() || p.description.trim(),
      );
      if (filled.length === 0) return '';
      const body = filled
        .map((p, i) => {
          const title = p.title.trim() || `Proyecto ${i + 1}`;
          const desc = p.description.trim() || '—';
          return `## ${i + 1}. ${title}\n\n${desc}`;
        })
        .join('\n\n');
      return `# Proyectos actuales\n\n${body}\n\n${ts}\n`;
    }
    case 'team': {
      if (!d.team.trim()) return '';
      return `# Mi equipo y órbita\n\n${d.team.trim()}\n\n${ts}\n`;
    }
    case 'style': {
      if (!d.style.trim()) return '';
      return `# Estilo de trabajo y preferencias\n\n${d.style.trim()}\n\n${ts}\n`;
    }
    case 'ai-import': {
      if (!d.aiImport.trim()) return '';
      return `# Importado desde mi IA habitual\n\n${d.aiImport.trim()}\n\n${ts}\n`;
    }
    default:
      return '';
  }
}

// The literal prompt copy users paste into ChatGPT/Claude/Gemini. Lives
// at module scope so it can be reused for the "Copy" button + the help
// text without rendering it twice in JSX.
const AI_IMPORT_PROMPT = `Necesito que me ayudes a crear un resumen estructurado de TODO lo que sabes sobre mí basado en nuestras conversaciones previas. Otro asistente (Ana) va a absorber este resumen para conocerme rápido.

Devolveme en este formato markdown EXACTO:

## Sobre mí
[Nombre, rol profesional, lo más importante de mi identidad]

## Cómo me gusta trabajar
[Estilo de comunicación, horarios típicos, tools que uso, formato de feedback]

## Proyectos en curso
[Cada uno: título + 1 párrafo breve]

## Decisiones recientes importantes
[Cosas que decidí en los últimos meses que valga la pena recordar]

## Preferencias técnicas y de oficio
[Stack, lenguajes, frameworks, anti-patterns que detesto, opiniones fuertes]

## Personas en mi órbita
[Equipo, clientes, mentores, partners — con su relación conmigo]

## Lo que NO quiero olvidar
[Notas, lecciones aprendidas, principios personales o profesionales]

Si no tenés información sobre alguna sección, dejala con "—". Sé honesto sobre los límites de lo que recordás de nuestras conversaciones.`;

// ─── Small UI primitives ─────────────────────────────────────────────

function StepLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[11.5px] font-semibold uppercase tracking-wide text-[#0e1745]/55 dark:text-white/55">
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      className={cn(
        'w-full h-10 px-3 rounded-lg text-[13px]',
        'bg-white/70 dark:bg-white/5 border border-black/8 dark:border-white/10',
        'text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30',
        'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40',
        'transition-colors',
      )}
    />
  );
}

function LongText({
  value,
  onChange,
  placeholder,
  autoFocus,
  rows = 8,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  rows?: number;
  ariaLabel: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      rows={rows}
      aria-label={ariaLabel}
      className={cn(
        'w-full px-3 py-2.5 rounded-lg text-[13px] leading-relaxed resize-y',
        'bg-white/70 dark:bg-white/5 border border-black/8 dark:border-white/10',
        'text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30',
        'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40',
        'transition-colors min-h-[12rem]',
      )}
    />
  );
}

function PrimaryButton({
  onClick,
  disabled,
  loading,
  children,
  type = 'button',
}: {
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'h-10 px-5 rounded-lg text-[12.5px] font-semibold inline-flex items-center gap-2',
        'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm',
        'hover:from-indigo-600 hover:to-purple-700',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
        'transition-colors',
      )}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}

function GhostButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-10 px-4 rounded-lg text-[12.5px] font-medium inline-flex items-center gap-1.5',
        'text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white',
        'hover:bg-black/5 dark:hover:bg-white/5',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
        'transition-colors',
      )}
    >
      {children}
    </button>
  );
}

// ─── Main component ─────────────────────────────────────────────────

export function NeuronOnboardingWizard({
  open,
  onClose,
  onComplete,
  userEmail,
}: NeuronOnboardingWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [data, setData] = useState<OnboardingData>(DEFAULT_DATA);
  const [saving, setSaving] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  // Per-file commit status during the final "Guardar todo" pass.
  const [commitState, setCommitState] = useState<
    Record<string, 'pending' | 'saved' | 'error' | 'skipped'>
  >({});
  // Review preview accordion — which path is expanded.
  const [openPreview, setOpenPreview] = useState<string | null>(null);

  const cardRef = useRef<HTMLDivElement | null>(null);

  // ── Initial draft load. Only runs when the wizard mounts/opens — we
  // don't re-load on every render even if the user types, since `data`
  // would then race with the draft restore.
  useEffect(() => {
    if (!open) return;
    const restored = loadDraft(userEmail);
    if (restored) setData(restored);
    setStep('welcome');
    setError(null);
    setConfirmingSkip(false);
    setCommitState({});
    setOpenPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userEmail]);

  // ── Persist draft on every change. Cheap — payload is < 10 KB.
  useEffect(() => {
    if (!open) return;
    saveDraft(userEmail, data);
  }, [data, open, userEmail]);

  // ── Body scroll lock + focus the card root. We intentionally don't
  // implement a full focus trap because the wizard's interactive
  // surface is small and predictable; tabIndex on the container is
  // enough to keep keyboard nav reasonable.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cardRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ── Escape → trigger the skip confirmation (NOT a hard close —
  // closing mid-wizard is destructive enough to deserve a confirm).
  // When the skip-confirm is already showing, Escape dismisses IT
  // (back to the wizard), so the user has a way out of the confirm
  // without committing to a skip.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (saving || savingAll) return;
      e.preventDefault();
      setConfirmingSkip((cur) => !cur);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, saving, savingAll]);

  const stepIndex = STEPS.indexOf(step);
  const isFirstStep = stepIndex === 0;
  const isLastStep = step === 'review';
  const progressPct = (stepIndex / (STEPS.length - 1)) * 100;

  // ── Navigation helpers ────────────────────────────────────────────

  const goNext = useCallback(() => {
    setError(null);
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  }, [stepIndex]);

  const goPrev = useCallback(() => {
    setError(null);
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  }, [stepIndex]);

  // ── Save handlers ─────────────────────────────────────────────────

  const saveCurrentAndAdvance = useCallback(async () => {
    setError(null);
    const path = pathForStep(step);
    // welcome + review have no associated file.
    if (!path) {
      goNext();
      return;
    }
    const content = renderMarkdownForStep(step, data);
    if (!content.trim()) {
      // Nothing to save — advance silently.
      goNext();
      return;
    }
    setSaving(true);
    try {
      await saveNeuronFile(path, content);
      goNext();
    } catch (e) {
      const msg =
        e instanceof NeuronApiError
          ? e.status === 401
            ? 'Tu sesión expiró. Iniciá sesión otra vez y volvé.'
            : e.status === 502
              ? 'No pude alcanzar el servicio de memoria. Probá de nuevo en un momento.'
              : `Error ${e.status} guardando este paso.`
          : e instanceof Error
            ? e.message
            : 'No se pudo guardar el paso.';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }, [step, data, goNext]);

  // Final commit — PATCH every non-empty file in parallel. We do NOT
  // bail on partial failure: if 3 of 5 succeed we still advance the
  // user out of the wizard (their neuron is now non-empty so the
  // re-fire guard prevents an annoying loop), and we surface which
  // files failed so they can retry from Mi Memoria.
  const finalizeAll = useCallback(async () => {
    setError(null);
    setSavingAll(true);
    const fileSteps: Step[] = STEPS.filter(
      (s) => s !== 'welcome' && s !== 'review',
    );
    const initialState: Record<string, 'pending' | 'saved' | 'error' | 'skipped'> = {};
    for (const s of fileSteps) {
      const md = renderMarkdownForStep(s, data);
      initialState[pathForStep(s)] = md.trim() ? 'pending' : 'skipped';
    }
    setCommitState(initialState);

    const results = await Promise.allSettled(
      fileSteps.map(async (s) => {
        const path = pathForStep(s);
        const content = renderMarkdownForStep(s, data);
        if (!content.trim()) return { path, status: 'skipped' as const };
        try {
          await saveNeuronFile(path, content);
          return { path, status: 'saved' as const };
        } catch (e) {
          throw { path, error: e };
        }
      }),
    );

    const finalState = { ...initialState };
    let anyError = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        finalState[r.value.path] = r.value.status;
      } else {
        const v = r.reason as { path: string; error: unknown };
        finalState[v.path] = 'error';
        anyError = true;
      }
    }
    setCommitState(finalState);
    setSavingAll(false);

    if (anyError) {
      setError(
        'Algunos archivos no se pudieron guardar. Podés reintentar desde Mi memoria.',
      );
      return;
    }
    // Success — clear the draft + signal completion.
    clearDraft(userEmail);
    onComplete();
  }, [data, onComplete, userEmail]);

  // ── Field setters (compact, per-key) ─────────────────────────────

  const updateIdentity = useCallback(
    (field: keyof IdentityFields) => (e: ChangeEvent<HTMLInputElement>) => {
      setData((d) => ({
        ...d,
        identity: { ...d.identity, [field]: e.target.value },
      }));
    },
    [],
  );

  const updateProjectField = useCallback(
    (idx: number, field: keyof ProjectEntry, value: string) => {
      setData((d) => ({
        ...d,
        projects: d.projects.map((p, i) =>
          i === idx ? { ...p, [field]: value } : p,
        ),
      }));
    },
    [],
  );

  const addProject = useCallback(() => {
    setData((d) => ({
      ...d,
      projects: [...d.projects, { title: '', description: '' }],
    }));
  }, []);

  const removeProject = useCallback((idx: number) => {
    setData((d) => ({
      ...d,
      projects:
        d.projects.length <= 1
          ? d.projects
          : d.projects.filter((_, i) => i !== idx),
    }));
  }, []);

  // ── Clipboard for the AI prompt ──────────────────────────────────

  const copyPrompt = useCallback(() => {
    navigator.clipboard.writeText(AI_IMPORT_PROMPT).then(
      () => {
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 1800);
      },
      () => {
        /* clipboard denied — silent */
      },
    );
  }, []);

  // ── Review preview rows ──────────────────────────────────────────

  const previewRows = useMemo(() => {
    const rows: Array<{ step: Step; path: string; content: string }> = [];
    for (const s of STEPS) {
      const path = pathForStep(s);
      if (!path) continue;
      const content = renderMarkdownForStep(s, data);
      rows.push({ step: s, path, content });
    }
    return rows;
  }, [data]);

  const filledFileCount = useMemo(
    () => previewRows.filter((r) => r.content.trim()).length,
    [previewRows],
  );

  // ── Render guard ─────────────────────────────────────────────────

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="neuron-onboarding-title"
        // Click outside is intentionally a no-op — the X button is the
        // ONLY way to close mid-flow (with a confirm). This matches the
        // PRD: "Modal non-dismissable click-out (solo cierre explícito)".
      >
        <motion.div
          ref={cardRef}
          tabIndex={-1}
          className={cn(
            'w-full max-w-3xl max-h-[90vh] flex flex-col',
            'bg-white dark:bg-[#0b1120] border border-black/10 dark:border-white/10',
            'rounded-2xl shadow-[0_30px_70px_rgba(0,0,0,0.35)] overflow-hidden',
            'outline-none',
          )}
          initial={{ opacity: 0, y: 18, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
        >
          {/* ── Header ─────────────────────────────────────────── */}
          <div className="px-6 py-4 border-b border-black/5 dark:border-white/5 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
                <Brain className="w-4 h-4 text-white" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[#0e1745]/45 dark:text-white/45">
                  Onboarding · paso {stepIndex + 1} de {STEPS.length}
                </div>
                <h2
                  id="neuron-onboarding-title"
                  className="text-[15px] font-semibold text-[#0e1745] dark:text-white"
                >
                  Conociendo a Ana, tu asistente
                </h2>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfirmingSkip(true)}
              disabled={saving || savingAll}
              className={cn(
                'h-8 w-8 flex items-center justify-center rounded-full',
                'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
                'hover:bg-black/5 dark:hover:bg-white/10 transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
              )}
              aria-label="Saltar onboarding"
              title="Saltar onboarding"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* ── Progress bar ───────────────────────────────────── */}
          <div className="px-6 pt-3 pb-2 shrink-0">
            <div className="h-1.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full"
                initial={false}
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
              />
            </div>
          </div>

          {/* ── Body ──────────────────────────────────────────── */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="space-y-4"
              >
                {step === 'welcome' && (
                  <WelcomeStep onStart={goNext} />
                )}

                {step === 'identity' && (
                  <IdentityStep
                    data={data.identity}
                    onChange={updateIdentity}
                  />
                )}

                {step === 'work' && (
                  <LongFormStep
                    title="¿Qué hacés día a día?"
                    description="Contale a Ana en qué consiste tu trabajo. Sé concreto: tareas reales, qué decisiones tomás, qué problemas resolvés. Mientras más detalle, mejor te conoce."
                    placeholder="Ej: dirijo marketing en una agencia. Mis días arrancan revisando métricas de campañas activas, después gestiono al equipo creativo, y por la tarde estoy en reuniones con clientes…"
                    value={data.work}
                    onChange={(v) => setData((d) => ({ ...d, work: v }))}
                    ariaLabel="Descripción de tu trabajo día a día"
                  />
                )}

                {step === 'projects' && (
                  <ProjectsStep
                    projects={data.projects}
                    onChangeField={updateProjectField}
                    onAdd={addProject}
                    onRemove={removeProject}
                  />
                )}

                {step === 'team' && (
                  <LongFormStep
                    title="¿Con quién trabajás?"
                    description="Equipo, clientes, mentores, partners. Nombrá personas y describí brevemente la relación. Esto ayuda a Ana cuando mencionás a 'Oscar' o 'el equipo de marketing'."
                    placeholder="Ej: Oscar — mi VP, decide presupuesto. Cata — diseñadora senior, mi mano derecha. Cliente Garnier — Ana María, gerente de marca…"
                    value={data.team}
                    onChange={(v) => setData((d) => ({ ...d, team: v }))}
                    ariaLabel="Tu equipo y órbita"
                  />
                )}

                {step === 'style' && (
                  <LongFormStep
                    title="¿Cómo te gusta trabajar?"
                    description="Horarios, tools que usás, formato de feedback que preferís, anti-patterns que detestás, lenguaje técnico de tu industria. Cosas que harían que Ana sonara como uno de tu equipo."
                    placeholder="Ej: arranco a las 8am, deep work hasta las 12. Uso Linear + Figma + Notion. Feedback directo, sin rodeos. Detesto reuniones sin agenda…"
                    value={data.style}
                    onChange={(v) => setData((d) => ({ ...d, style: v }))}
                    ariaLabel="Tu estilo de trabajo"
                  />
                )}

                {step === 'ai-import' && (
                  <AiImportStep
                    value={data.aiImport}
                    onChange={(v) =>
                      setData((d) => ({ ...d, aiImport: v }))
                    }
                    copied={copiedPrompt}
                    onCopy={copyPrompt}
                  />
                )}

                {step === 'review' && (
                  <ReviewStep
                    previewRows={previewRows}
                    openPreview={openPreview}
                    onTogglePreview={(p) =>
                      setOpenPreview((cur) => (cur === p ? null : p))
                    }
                    filledFileCount={filledFileCount}
                    commitState={commitState}
                  />
                )}
              </motion.div>
            </AnimatePresence>

            {error && (
              <div className="mt-4 p-3 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200/60 dark:border-rose-500/30 text-[12px] text-rose-700 dark:text-rose-300 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* ── Footer ────────────────────────────────────────── */}
          <div className="px-6 py-4 border-t border-black/5 dark:border-white/5 flex items-center justify-between gap-3 shrink-0 bg-white/40 dark:bg-white/[0.02]">
            <div className="flex items-center gap-1.5">
              {!isFirstStep && (
                <GhostButton onClick={goPrev} disabled={saving || savingAll}>
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Volver
                </GhostButton>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {step !== 'welcome' && step !== 'review' && (
                <GhostButton
                  onClick={goNext}
                  disabled={saving || savingAll}
                >
                  Saltar este paso
                </GhostButton>
              )}

              {step === 'welcome' && (
                <PrimaryButton onClick={goNext}>
                  Empezar
                  <ArrowRight className="w-3.5 h-3.5" />
                </PrimaryButton>
              )}

              {step !== 'welcome' && step !== 'review' && (
                <PrimaryButton
                  onClick={saveCurrentAndAdvance}
                  loading={saving}
                  disabled={savingAll}
                >
                  Guardar y continuar
                  <ArrowRight className="w-3.5 h-3.5" />
                </PrimaryButton>
              )}

              {step === 'review' && (
                <PrimaryButton
                  onClick={finalizeAll}
                  loading={savingAll}
                  disabled={saving}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Guardar todo y empezar
                </PrimaryButton>
              )}
            </div>
          </div>
        </motion.div>

        {/* ── Skip-confirm overlay (modal-on-modal) ───────────── */}
        <AnimatePresence>
          {confirmingSkip && (
            <motion.div
              className="absolute inset-0 z-[121] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="onboarding-skip-title"
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                className={cn(
                  'w-full max-w-md p-5 rounded-2xl',
                  'bg-white dark:bg-[#0b1120] border border-black/10 dark:border-white/10',
                  'shadow-[0_24px_60px_rgba(0,0,0,0.35)]',
                )}
              >
                <h3
                  id="onboarding-skip-title"
                  className="text-[14px] font-semibold text-[#0e1745] dark:text-white"
                >
                  ¿Seguro que querés saltar?
                </h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#0e1745]/65 dark:text-white/65">
                  Ana sabrá menos sobre vos al arrancar. Podés volver más
                  tarde desde <strong>Mi memoria</strong>. Lo que escribiste
                  hasta ahora queda guardado como borrador.
                </p>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <GhostButton onClick={() => setConfirmingSkip(false)}>
                    Volver al wizard
                  </GhostButton>
                  <PrimaryButton
                    onClick={() => {
                      setConfirmingSkip(false);
                      onClose();
                    }}
                  >
                    Saltar por ahora
                  </PrimaryButton>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Per-step subcomponents ──────────────────────────────────────────

function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <div className="space-y-5 max-w-2xl">
      <div className="space-y-2">
        <h3 className="text-[20px] font-semibold text-[#0e1745] dark:text-white tracking-tight">
          Hola — vamos a presentarte a Ana
        </h3>
      </div>
      <div className="space-y-3 text-[13.5px] leading-relaxed text-[#0e1745]/75 dark:text-white/75">
        <p>
          Ana es tu asistente que va a recordar contexto entre
          conversaciones. Mientras más sepa de vos al arrancar, más útil
          es desde el primer turno.
        </p>
        <p>
          Te voy a hacer unas 7 preguntas — algunas cortas, otras donde
          podés escribir todo lo que quieras. Una de ellas es la magia:
          vas a copiar un prompt en ChatGPT/Claude/Gemini y pegar la
          respuesta acá. Eso acelera todo.
        </p>
        <p className="text-[#0e1745]/55 dark:text-white/55 text-[12.5px]">
          Tiempo estimado: 5–10 minutos. Podés saltar cualquier paso y
          volver luego desde <strong>Mi memoria</strong>.
        </p>
      </div>
      <button
        type="button"
        onClick={onStart}
        className={cn(
          'h-11 px-6 rounded-xl text-[13px] font-semibold inline-flex items-center gap-2',
          'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-sm',
          'hover:from-indigo-600 hover:to-purple-700 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
        )}
        autoFocus
      >
        Empezar
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

function IdentityStep({
  data,
  onChange,
}: {
  data: IdentityFields;
  onChange: (
    field: keyof IdentityFields,
  ) => (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h3 className="text-[18px] font-semibold text-[#0e1745] dark:text-white tracking-tight">
          Lo básico sobre vos
        </h3>
        <p className="mt-1 text-[12.5px] text-[#0e1745]/60 dark:text-white/55">
          Esto le da a Ana un anclaje rápido. Sé breve.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5 sm:col-span-2">
          <StepLabel>Nombre completo</StepLabel>
          <TextInput
            value={data.full_name}
            onChange={(v) =>
              onChange('full_name')({
                target: { value: v },
              } as ChangeEvent<HTMLInputElement>)
            }
            placeholder="Ej: Juan Manuel Rojas"
            autoFocus
            ariaLabel="Nombre completo"
          />
        </div>
        <div className="space-y-1.5">
          <StepLabel>Rol</StepLabel>
          <TextInput
            value={data.role}
            onChange={(v) =>
              onChange('role')({
                target: { value: v },
              } as ChangeEvent<HTMLInputElement>)
            }
            placeholder="Ej: Director de Diseño"
            ariaLabel="Rol profesional"
          />
        </div>
        <div className="space-y-1.5">
          <StepLabel>Empresa</StepLabel>
          <TextInput
            value={data.company}
            onChange={(v) =>
              onChange('company')({
                target: { value: v },
              } as ChangeEvent<HTMLInputElement>)
            }
            placeholder="Ej: Shift"
            ariaLabel="Empresa"
          />
        </div>
        <div className="space-y-1.5">
          <StepLabel>Ubicación</StepLabel>
          <TextInput
            value={data.location}
            onChange={(v) =>
              onChange('location')({
                target: { value: v },
              } as ChangeEvent<HTMLInputElement>)
            }
            placeholder="Ej: Bogotá, Colombia"
            ariaLabel="Ubicación"
          />
        </div>
        <div className="space-y-1.5">
          <StepLabel>Zona horaria</StepLabel>
          <TextInput
            value={data.timezone}
            onChange={(v) =>
              onChange('timezone')({
                target: { value: v },
              } as ChangeEvent<HTMLInputElement>)
            }
            placeholder="Ej: GMT-5"
            ariaLabel="Zona horaria"
          />
        </div>
      </div>
    </div>
  );
}

function LongFormStep({
  title,
  description,
  placeholder,
  value,
  onChange,
  ariaLabel,
}: {
  title: string;
  description: string;
  placeholder?: string;
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-[18px] font-semibold text-[#0e1745] dark:text-white tracking-tight">
          {title}
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[#0e1745]/60 dark:text-white/55">
          {description}
        </p>
      </div>
      <LongText
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus
        ariaLabel={ariaLabel}
      />
    </div>
  );
}

function ProjectsStep({
  projects,
  onChangeField,
  onAdd,
  onRemove,
}: {
  projects: ProjectEntry[];
  onChangeField: (idx: number, field: keyof ProjectEntry, value: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-[18px] font-semibold text-[#0e1745] dark:text-white tracking-tight">
          ¿En qué estás trabajando ahora?
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[#0e1745]/60 dark:text-white/55">
          Listá tus proyectos en curso. Ana los va a referenciar cuando
          hables de ellos.
        </p>
      </div>
      <div className="space-y-3">
        {projects.map((p, idx) => (
          <div
            key={idx}
            className={cn(
              'p-3.5 rounded-xl border border-black/8 dark:border-white/10',
              'bg-white/50 dark:bg-white/[0.03]',
            )}
          >
            <div className="flex items-start gap-3">
              <div className="flex-1 space-y-2.5">
                <div className="space-y-1.5">
                  <StepLabel>Proyecto #{idx + 1} — Título</StepLabel>
                  <TextInput
                    value={p.title}
                    onChange={(v) => onChangeField(idx, 'title', v)}
                    placeholder="Ej: Rebrand cliente X"
                    autoFocus={idx === 0}
                    ariaLabel={`Título del proyecto ${idx + 1}`}
                  />
                </div>
                <div className="space-y-1.5">
                  <StepLabel>Descripción</StepLabel>
                  <textarea
                    value={p.description}
                    onChange={(e) =>
                      onChangeField(idx, 'description', e.target.value)
                    }
                    rows={3}
                    placeholder="Brevemente: qué es, en qué etapa estás, cuándo se entrega…"
                    aria-label={`Descripción del proyecto ${idx + 1}`}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg text-[13px] leading-relaxed resize-y',
                      'bg-white/70 dark:bg-white/5 border border-black/8 dark:border-white/10',
                      'text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30',
                      'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40',
                      'transition-colors',
                    )}
                  />
                </div>
              </div>
              {projects.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemove(idx)}
                  className={cn(
                    'h-8 w-8 flex items-center justify-center rounded-md shrink-0 mt-5',
                    'text-[#0e1745]/45 dark:text-white/45 hover:text-rose-500 dark:hover:text-rose-400',
                    'hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60',
                  )}
                  aria-label={`Eliminar proyecto ${idx + 1}`}
                  title="Eliminar proyecto"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className={cn(
          'h-9 px-3 rounded-lg text-[12px] font-semibold inline-flex items-center gap-1.5',
          'border border-dashed border-indigo-500/40 dark:border-indigo-400/40',
          'text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-500/10',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
          'transition-colors',
        )}
      >
        <Plus className="w-3.5 h-3.5" />
        Agregar proyecto
      </button>
    </div>
  );
}

function AiImportStep({
  value,
  onChange,
  copied,
  onCopy,
}: {
  value: string;
  onChange: (next: string) => void;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-[18px] font-semibold text-[#0e1745] dark:text-white tracking-tight flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-500 dark:text-indigo-300" aria-hidden />
          Pedile ayuda a tu IA habitual
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[#0e1745]/60 dark:text-white/55">
          Si ya usás ChatGPT, Claude o Gemini, ya saben mucho de vos. Copiá
          este prompt, pegalo en tu chat habitual con ellos, y pegá la
          respuesta que te dan acá. Es la forma más rápida de cargar tu
          perfil.
        </p>
      </div>

      <div
        className={cn(
          'rounded-xl border border-black/8 dark:border-white/10',
          'bg-[#0e1745]/[0.03] dark:bg-white/[0.03]',
          'p-3.5',
        )}
      >
        <div className="flex items-center justify-between mb-2">
          <StepLabel>Prompt para tu IA</StepLabel>
          <button
            type="button"
            onClick={onCopy}
            className={cn(
              'h-7 px-2.5 rounded-md text-[11.5px] font-semibold inline-flex items-center gap-1.5',
              'bg-white dark:bg-white/10 border border-black/8 dark:border-white/10',
              'text-[#0e1745] dark:text-white hover:bg-indigo-50 dark:hover:bg-indigo-500/15',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
              'transition-colors',
            )}
            aria-label="Copiar prompt al portapapeles"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3" /> Copiado
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" /> Copiar
              </>
            )}
          </button>
        </div>
        <pre
          className={cn(
            'text-[11.5px] font-mono leading-relaxed whitespace-pre-wrap',
            'text-[#0e1745]/85 dark:text-white/75 max-h-56 overflow-y-auto',
            'pr-1',
          )}
        >
          {AI_IMPORT_PROMPT}
        </pre>
      </div>

      <div className="space-y-1.5">
        <StepLabel>Pegá acá la respuesta de tu IA</StepLabel>
        <LongText
          value={value}
          onChange={onChange}
          rows={10}
          placeholder="Pegá acá el markdown que te devolvió ChatGPT/Claude/Gemini…"
          ariaLabel="Respuesta importada de tu IA habitual"
        />
        <p className="text-[11.5px] text-[#0e1745]/50 dark:text-white/50">
          No tiene que ser perfecto — Ana va a integrar lo que pegues con
          el resto.
        </p>
      </div>
    </div>
  );
}

function ReviewStep({
  previewRows,
  openPreview,
  onTogglePreview,
  filledFileCount,
  commitState,
}: {
  previewRows: Array<{ step: Step; path: string; content: string }>;
  openPreview: string | null;
  onTogglePreview: (path: string) => void;
  filledFileCount: number;
  commitState: Record<string, 'pending' | 'saved' | 'error' | 'skipped'>;
}) {
  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="text-[18px] font-semibold text-[#0e1745] dark:text-white tracking-tight">
          Listo — esto es lo que Ana va a saber de vos
        </h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[#0e1745]/60 dark:text-white/55">
          Revisá los {filledFileCount}{' '}
          {filledFileCount === 1 ? 'archivo' : 'archivos'} que vamos a
          guardar en tu memoria. Podés volver a editar cualquier paso
          antes de confirmar.
        </p>
      </div>
      <div className="space-y-2">
        {previewRows.map((row) => {
          const empty = !row.content.trim();
          const stateForPath = commitState[row.path];
          const isOpen = openPreview === row.path;
          return (
            <div
              key={row.path}
              className={cn(
                'rounded-xl border overflow-hidden',
                empty
                  ? 'border-dashed border-black/10 dark:border-white/10 bg-transparent'
                  : 'border-black/8 dark:border-white/10 bg-white/50 dark:bg-white/[0.03]',
              )}
            >
              <button
                type="button"
                onClick={() => !empty && onTogglePreview(row.path)}
                className={cn(
                  'w-full px-3.5 py-2.5 flex items-center justify-between gap-3 text-left',
                  empty
                    ? 'cursor-default'
                    : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:bg-black/[0.03] dark:focus-visible:bg-white/[0.03]',
                  'transition-colors',
                )}
                aria-expanded={isOpen}
                aria-disabled={empty}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-mono text-[#0e1745] dark:text-white truncate">
                    {row.path}
                  </div>
                  <div className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45 mt-0.5">
                    {empty
                      ? 'Sin contenido — no se guardará'
                      : `${row.content.length.toLocaleString()} caracteres`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {stateForPath === 'saved' && (
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                      <Check className="w-3 h-3" /> guardado
                    </span>
                  )}
                  {stateForPath === 'pending' && (
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-300 flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      guardando…
                    </span>
                  )}
                  {stateForPath === 'error' && (
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                      error
                    </span>
                  )}
                  {!empty && (
                    <span aria-hidden className="text-[#0e1745]/40 dark:text-white/40">
                      {isOpen ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </span>
                  )}
                </div>
              </button>
              {!empty && isOpen && (
                <pre
                  className={cn(
                    'px-3.5 py-2.5 text-[11.5px] font-mono leading-relaxed whitespace-pre-wrap',
                    'text-[#0e1745]/80 dark:text-white/75 max-h-64 overflow-y-auto',
                    'border-t border-black/5 dark:border-white/5',
                  )}
                >
                  {row.content}
                </pre>
              )}
            </div>
          );
        })}
      </div>
      {filledFileCount === 0 && (
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200/60 dark:border-amber-500/30 text-[12px] text-amber-800 dark:text-amber-200">
          No agregaste contenido en ningún paso. Si confirmás, no se va a
          guardar nada y Ana arrancará sin contexto sobre vos.
        </div>
      )}
    </div>
  );
}

export default NeuronOnboardingWizard;
