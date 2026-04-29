/**
 * @file AuthView.tsx
 * @description Pantalla de login del ecosistema Shift.
 * Construida con componentes UI estilo shadcn + Tailwind CSS v4.
 * NO usa @supabase/auth-ui-react (incompatible con React 19).
 * El mismo usuario/contraseña sirve para todos los productos Shift.
 */

import React, { useState } from 'react'
import { supabase } from '../services/supabaseClient'
import LoginCardSection from '@/components/ui/login-signup'

export function AuthView() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        setError(null)
        setLoading(true)

        if (!supabase) {
            setError('Auth no está configurada. Pedile al admin que setee VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (o VITE_BYPASS_AUTH=true para anon mode).')
            setLoading(false)
            return
        }

        try {
            const { error: authError } = await supabase.auth.signInWithPassword({
                email,
                password,
            })

            if (authError) {
                // Mensajes de error en español
                const errorMessages: Record<string, string> = {
                    'Invalid login credentials': 'Correo o contraseña incorrectos.',
                    'Email not confirmed': 'Debes confirmar tu correo electrónico antes de iniciar sesión.',
                    'Too many requests': 'Demasiados intentos. Espera unos minutos e intenta de nuevo.',
                }
                setError(errorMessages[authError.message] ?? 'Error al iniciar sesión. Intenta de nuevo.')
                setLoading(false)
            }
        } catch (_error) {
            setError('No fue posible conectar con el servidor. Intenta de nuevo en unos segundos.')
            setLoading(false)
        }

        // Si hay éxito, Supabase actualiza el estado de sesión globalmente
        // onAuthStateChange en App.tsx detectará el cambio automáticamente
    }

    return (
        <LoginCardSection
            email={email}
            password={password}
            loading={loading}
            error={error}
            onEmailChange={setEmail}
            onPasswordChange={setPassword}
            onSubmit={handleSubmit}
        />
    )
}
