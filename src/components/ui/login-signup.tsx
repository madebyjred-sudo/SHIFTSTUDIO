"use client"

import * as React from "react"
import { useEffect, useRef, useState } from "react"
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { Chrome, Eye, EyeOff, Github, Lock, Mail } from "lucide-react"
import { ShiftyLogo } from "@/components/ShiftyLogo"

interface LoginCardSectionProps {
    email?: string
    password?: string
    loading?: boolean
    error?: string | null
    onEmailChange?: (value: string) => void
    onPasswordChange?: (value: string) => void
    onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void
}

export default function LoginCardSection({
    email,
    password,
    loading = false,
    error = null,
    onEmailChange,
    onPasswordChange,
    onSubmit,
}: LoginCardSectionProps) {
    const [internalEmail, setInternalEmail] = useState("")
    const [internalPassword, setInternalPassword] = useState("")
    const [showPassword, setShowPassword] = useState(false)

    const emailValue = email ?? internalEmail
    const passwordValue = password ?? internalPassword
    const setEmailValue = onEmailChange ?? setInternalEmail
    const setPasswordValue = onPasswordChange ?? setInternalPassword

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        if (onSubmit) {
            onSubmit(event)
            return
        }
        event.preventDefault()
    }

    const canvasRef = useRef<HTMLCanvasElement | null>(null)

    useEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

        const canvas = canvasRef.current
        const ctx = canvas?.getContext("2d")
        if (!canvas || !ctx) return

        const setSize = () => {
            canvas.width = window.innerWidth
            canvas.height = window.innerHeight
        }
        setSize()

        type Particle = { x: number; y: number; v: number; o: number }
        let particles: Particle[] = []
        let raf = 0

        const makeParticle = () => ({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            v: Math.random() * 0.25 + 0.05,
            o: Math.random() * 0.35 + 0.15,
        })

        const init = () => {
            particles = []
            const count = Math.floor((canvas.width * canvas.height) / 9000)
            for (let i = 0; i < count; i++) particles.push(makeParticle())
        }

        const draw = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height)
            particles.forEach((particle) => {
                particle.y -= particle.v
                if (particle.y < 0) {
                    particle.x = Math.random() * canvas.width
                    particle.y = canvas.height + Math.random() * 40
                    particle.v = Math.random() * 0.25 + 0.05
                    particle.o = Math.random() * 0.35 + 0.15
                }
                ctx.fillStyle = `rgba(250,250,250,${particle.o})`
                ctx.fillRect(particle.x, particle.y, 0.7, 2.2)
            })
            raf = requestAnimationFrame(draw)
        }

        const onResize = () => {
            setSize()
            init()
        }

        window.addEventListener("resize", onResize)
        init()
        raf = requestAnimationFrame(draw)

        return () => {
            window.removeEventListener("resize", onResize)
            cancelAnimationFrame(raf)
        }
    }, [])

    return (
        <section className="fixed inset-0 bg-mesh text-white font-sans">
            <style>{`
        .accent-lines{position:absolute;inset:0;pointer-events:none;opacity:.6}
        .hline,.vline{position:absolute;background:rgba(0,71,171,0.25);will-change:transform,opacity}
        .hline{left:0;right:0;height:1px;transform:scaleX(0);transform-origin:50% 50%;animation:drawX .8s cubic-bezier(.22,.61,.36,1) forwards}
        .vline{top:0;bottom:0;width:1px;transform:scaleY(0);transform-origin:50% 0%;animation:drawY .9s cubic-bezier(.22,.61,.36,1) forwards}
        .hline:nth-child(1){top:18%;animation-delay:.12s}
        .hline:nth-child(2){top:50%;animation-delay:.22s}
        .hline:nth-child(3){top:82%;animation-delay:.32s}
        .vline:nth-child(4){left:22%;animation-delay:.42s}
        .vline:nth-child(5){left:50%;animation-delay:.54s}
        .vline:nth-child(6){left:78%;animation-delay:.66s}
        .hline::after,.vline::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(0,71,171,0.45),transparent);opacity:0;animation:shimmer .9s ease-out forwards}
        .hline:nth-child(1)::after{animation-delay:.12s}
        .hline:nth-child(2)::after{animation-delay:.22s}
        .hline:nth-child(3)::after{animation-delay:.32s}
        .vline:nth-child(4)::after{animation-delay:.42s}
        .vline:nth-child(5)::after{animation-delay:.54s}
        .vline:nth-child(6)::after{animation-delay:.66s}
        @keyframes drawX{0%{transform:scaleX(0);opacity:0}60%{opacity:.95}100%{transform:scaleX(1);opacity:.7}}
        @keyframes drawY{0%{transform:scaleY(0);opacity:0}60%{opacity:.95}100%{transform:scaleY(1);opacity:.7}}
        @keyframes shimmer{0%{opacity:0}35%{opacity:.25}100%{opacity:0}}

        .card-animate {
          opacity: 0;
          transform: translateY(20px);
          animation: fadeUp 0.8s cubic-bezier(.22,.61,.36,1) 0.4s forwards;
        }
        @keyframes fadeUp {
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .hline,.vline,.hline::after,.vline::after,.card-animate { animation: none !important; }
        }
      `}</style>

            <div className="absolute inset-0 pointer-events-none [background:radial-gradient(80%_60%_at_50%_30%,rgba(0,71,171,0.18),transparent_60%)]" />

            <div className="accent-lines">
                <div className="hline" />
                <div className="hline" />
                <div className="hline" />
                <div className="vline" />
                <div className="vline" />
                <div className="vline" />
            </div>

            <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full pointer-events-none opacity-40 mix-blend-screen"
            />

            <header className="absolute left-0 right-0 top-0 flex items-center justify-center px-6 py-5 border-b border-white/10">
                <ShiftyLogo className="h-8 w-auto opacity-95" />
            </header>

            <div className="grid h-full w-full place-items-center px-4 pt-16">
                <Card className="card-animate w-full max-w-sm glass-dark border-white/10">
                    <CardHeader className="space-y-1">
                        <CardTitle className="text-2xl font-heading text-white">Welcome back</CardTitle>
                        <CardDescription className="text-white/50">
                            Sign in to your Shifty Studio account
                        </CardDescription>
                    </CardHeader>

                    <CardContent>
                        <form onSubmit={handleSubmit} className="grid gap-5">
                            <div className="grid gap-2">
                                <Label htmlFor="email" className="text-white/70">
                                    Email
                                </Label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                                    <Input
                                        id="email"
                                        type="email"
                                        value={emailValue}
                                        onChange={(event) => setEmailValue(event.target.value)}
                                        placeholder="you@example.com"
                                        autoComplete="email"
                                        required
                                        disabled={loading}
                                        className="pl-10 bg-black/25 border-white/10 text-white placeholder:text-white/25 focus:border-[#0047AB]/60 focus:ring-[#0047AB]/30"
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label htmlFor="password" className="text-white/70">
                                    Password
                                </Label>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                                    <Input
                                        id="password"
                                        type={showPassword ? "text" : "password"}
                                        value={passwordValue}
                                        onChange={(event) => setPasswordValue(event.target.value)}
                                        placeholder="••••••••"
                                        autoComplete="current-password"
                                        required
                                        disabled={loading}
                                        className="pr-10 pl-10 bg-black/25 border-white/10 text-white placeholder:text-white/25 focus:border-[#0047AB]/60 focus:ring-[#0047AB]/30"
                                    />
                                    <button
                                        type="button"
                                        aria-label={showPassword ? "Hide password" : "Show password"}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-2 text-white/35 hover:text-white/70 transition-colors"
                                        onClick={() => setShowPassword((value) => !value)}
                                    >
                                        {showPassword ? (
                                            <EyeOff className="h-4 w-4" />
                                        ) : (
                                            <Eye className="h-4 w-4" />
                                        )}
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Checkbox
                                        id="remember"
                                        className="border-white/20 data-[state=checked]:bg-[#0047AB] data-[state=checked]:border-[#0047AB] data-[state=checked]:text-white"
                                    />
                                    <Label htmlFor="remember" className="text-white/50">
                                        Remember me
                                    </Label>
                                </div>
                                <button
                                    type="button"
                                    aria-label="Recuperar contraseña"
                                    className="text-sm text-white/60 hover:text-white transition-colors"
                                >
                                    Forgot password?
                                </button>
                            </div>

                            {error && (
                                <div
                                    role="alert"
                                    aria-live="polite"
                                    className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                                >
                                    {error}
                                </div>
                            )}

                            <Button
                                type="submit"
                                disabled={loading || !emailValue || !passwordValue}
                                className="h-10 w-full rounded-lg bg-[#0047AB] text-white hover:bg-[#0047AB]/85 disabled:opacity-40 font-heading transition-colors"
                            >
                                {loading ? "Verificando..." : "Iniciar sesión"}
                            </Button>

                            <div className="relative">
                                <Separator className="bg-white/10" />
                                <span className="absolute left-1/2 -top-3 -translate-x-1/2 bg-[#0a1535]/80 px-2 text-[11px] uppercase tracking-widest text-white/30">
                                    or
                                </span>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <Button
                                    type="button"
                                    variant="outline"
                                    aria-label="Iniciar sesión con GitHub"
                                    className="h-10 rounded-lg border-white/10 bg-white/5 text-white hover:bg-white/10 hover:border-white/20 transition-colors"
                                >
                                    <Github className="mr-2 h-4 w-4" />
                                    GitHub
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    aria-label="Iniciar sesión con Google"
                                    className="h-10 rounded-lg border-white/10 bg-white/5 text-white hover:bg-white/10 hover:border-white/20 transition-colors"
                                >
                                    <Chrome className="mr-2 h-4 w-4" />
                                    Google
                                </Button>
                            </div>
                        </form>
                    </CardContent>

                    <CardFooter className="flex items-center justify-center text-sm text-white/40">
                        ¿No tienes cuenta?
                        <button
                            type="button"
                            className="ml-1 text-[#0047AB] hover:text-[#0047AB]/80 hover:underline transition-colors"
                        >
                            Crea una
                        </button>
                    </CardFooter>
                </Card>
            </div>
        </section>
    )
}
