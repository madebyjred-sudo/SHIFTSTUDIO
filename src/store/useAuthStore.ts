/**
 * @file useAuthStore.ts
 * @description Store Zustand para el estado de autenticación del ecosistema Shift.
 * Gestiona la sesión de Supabase de forma centralizada.
 * Consumir con: const { session, user, isAuthenticated } = useAuthStore()
 */

import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../services/supabaseClient'

interface AuthState {
    /** Sesión activa de Supabase (null = no autenticado) */
    session: Session | null
    /** Usuario autenticado extraído de la sesión */
    user: User | null
    /** true cuando hay sesión activa confirmada */
    isAuthenticated: boolean
    /** true mientras se verifica la sesión inicial (evita flash de login) */
    isAuthLoading: boolean

    /** Actualiza la sesión y deriva user/isAuthenticated automáticamente */
    setSession: (session: Session | null) => void
    /** Cierra sesión en Supabase y limpia el estado local */
    logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
    session: null,
    user: null,
    isAuthenticated: false,
    isAuthLoading: true,

    setSession: (session) => {
        set({
            session,
            user: session?.user ?? null,
            isAuthenticated: !!session,
            isAuthLoading: false,
        })
    },

    logout: async () => {
        if (supabase) {
            await supabase.auth.signOut()
        }
        // onAuthStateChange en App.tsx detectará el cambio y mostrará AuthView
        set({
            session: null,
            user: null,
            isAuthenticated: false,
            isAuthLoading: false,
        })
    },
}))
