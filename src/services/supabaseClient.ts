/**
 * @file supabaseClient.ts
 * @description Singleton del cliente Supabase para el ecosistema Shift.
 * Todos los productos (Brand Hub, Shift Studio, Sentinel) comparten este
 * Identity Provider centralizado. NO instanciar en otros archivos.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const bypassAuth = import.meta.env.VITE_BYPASS_AUTH === 'true'

// Soft-fail en deploys sin Supabase (anon mode / bypass auth):
// - Antes throw-eaba en boot y rompía el bundle entero (pantalla en blanco).
// - Ahora exportamos null cuando faltan vars o bypass está prendido;
//   los callers (App.tsx, AuthView.tsx, useAuthStore.ts) deben checkear
//   `if (!supabase) ...` y degradarse a "anonymous" sin auth real.
let _supabase: SupabaseClient | null = null

if (supabaseUrl && supabaseAnonKey) {
    _supabase = createClient(supabaseUrl, supabaseAnonKey)
} else if (bypassAuth) {
    console.warn('[Supabase] VITE_BYPASS_AUTH=true — corriendo en anon mode (sin auth real).')
} else {
    console.warn('[Supabase] Variables de entorno no configuradas. Auth deshabilitado. ' +
                 'Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY o VITE_BYPASS_AUTH=true.')
}

export const supabase = _supabase
