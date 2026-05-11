/**
 * @file useNeuronOnboarding.ts
 * @description Decides whether the onboarding wizard should fire for the
 * current user on Studio boot. The wizard is a "first login + empty
 * neuron" experience — once the user finishes (or explicitly dismisses
 * recently), we stay out of their way.
 *
 * Rules (in order of precedence — first matching short-circuits):
 *   1. No supabase session / no email → never show. The wizard writes
 *      to /memories/profile/* via the BFF, which needs a JWT.
 *   2. localStorage `studio-onboarding-completed-${email}` set → never
 *      re-show automatically (user can still re-enter from NeuronPanel).
 *   3. localStorage `studio-onboarding-dismissed-${email}` set within
 *      the last 7 days → snooze. After 7d we'll nag once more.
 *   4. `listNeuronFiles()` returns non-empty → user already has memory,
 *      onboarding would be redundant (and might overwrite real data).
 *   5. Otherwise → show.
 *
 * Failure of the neuron list call is silent (warn only): if Cerebro is
 * unreachable we MUST NOT block the rest of Studio from rendering.
 *
 * Storage keys are scoped per-email so multi-account boxes (different
 * users on the same browser profile) don't leak state across each other.
 */
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../services/supabaseClient';
import { listNeuronFiles } from '../services/neuronClient';

const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function completedKey(email: string): string {
  return `studio-onboarding-completed-${email}`;
}

function dismissedKey(email: string): string {
  return `studio-onboarding-dismissed-${email}`;
}

export interface UseNeuronOnboardingResult {
  /** Active session email, or null if no auth context yet. */
  email: string | null;
  /** True only when the wizard should auto-open on boot. */
  shouldShow: boolean;
  /** Imperative re-entry from settings/NeuronPanel — bypasses the gates. */
  forceOpen: () => void;
  /** Hide the wizard right now; flagged as "dismissed" with a 7d snooze. */
  dismiss: () => void;
  /** Hide the wizard right now; flagged as "completed" permanently. */
  complete: () => void;
  /** True while the empty-neuron check is in flight. */
  checking: boolean;
}

export function useNeuronOnboarding(): UseNeuronOnboardingResult {
  const [email, setEmail] = useState<string | null>(null);
  const [shouldShow, setShouldShow] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!supabase) {
          if (!cancelled) setChecking(false);
          return;
        }
        const { data } = await supabase.auth.getSession();
        const sessionEmail = data.session?.user?.email ?? null;
        if (cancelled) return;
        setEmail(sessionEmail);
        if (!sessionEmail) {
          setChecking(false);
          return;
        }

        // Gate 2: already completed
        if (localStorage.getItem(completedKey(sessionEmail)) === 'true') {
          setChecking(false);
          return;
        }

        // Gate 3: recently dismissed
        const dismissedAt = localStorage.getItem(dismissedKey(sessionEmail));
        if (dismissedAt) {
          const ts = parseInt(dismissedAt, 10);
          if (!Number.isNaN(ts) && Date.now() - ts < DISMISS_TTL_MS) {
            setChecking(false);
            return;
          }
        }

        // Gate 4: empty neuron check
        const list = await listNeuronFiles();
        if (cancelled) return;
        const isEmpty = !list.files || list.files.length === 0;
        if (isEmpty) {
          setShouldShow(true);
        }
      } catch (e) {
        // Silent fail — onboarding is NEVER critical path. If the BFF
        // is down (502) or the JWT expired (401), Studio still works.
        console.warn('[onboarding] gate check failed:', e);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (email) {
      try {
        localStorage.setItem(dismissedKey(email), String(Date.now()));
      } catch {
        /* storage disabled — best effort */
      }
    }
    setShouldShow(false);
  }, [email]);

  const complete = useCallback(() => {
    if (email) {
      try {
        localStorage.setItem(completedKey(email), 'true');
        localStorage.removeItem(dismissedKey(email));
      } catch {
        /* storage disabled — best effort */
      }
    }
    setShouldShow(false);
  }, [email]);

  const forceOpen = useCallback(() => {
    setShouldShow(true);
  }, []);

  return { email, shouldShow, forceOpen, dismiss, complete, checking };
}
