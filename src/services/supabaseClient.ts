/**
 * @file supabaseClient.ts
 * @description Singleton del cliente Supabase para el ecosistema Shift.
 * Todos los productos (Brand Hub, Shift Studio, Sentinel) comparten este
 * Identity Provider centralizado. NO instanciar en otros archivos.
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('[Supabase] Variables de entorno no configuradas. Revisa .env.local')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
