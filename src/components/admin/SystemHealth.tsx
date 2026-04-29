import { motion } from "motion/react";
import { Activity, Database, Shield, Zap } from "lucide-react";
import reportData from "../../data/report-data";

function HealthBar({ label, value, max, color, icon: Icon }: { label: string; value: number; max: number; color: string; icon: React.ComponentType<{ className?: string }> }) {
    const percentage = Math.min((value / max) * 100, 100);

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-white/40" />
                    <span className="text-white/70 text-sm">{label}</span>
                </div>
                <span className="text-white font-medium text-sm">{value}</span>
            </div>
            <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${percentage}%` }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    className="h-full rounded-full"
                    style={{ backgroundColor: color }}
                />
            </div>
        </div>
    );
}

export default function SystemHealth() {
    const { health } = reportData;

    return (
        <div className="glass-dark rounded-2xl p-6 border border-white/10">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-white font-heading">
                        Salud del Sistema
                    </h3>
                    <p className="text-white/50 text-sm mt-1">
                        Métricas de performance y extracción
                    </p>
                </div>
                <div className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400">
                    <Activity className="w-6 h-6" />
                </div>
            </div>

            <div className="space-y-5">
                <HealthBar
                    label="Insights (24h)"
                    value={health.insights24h}
                    max={35}
                    color="#3B82F6"
                    icon={Database}
                />
                <HealthBar
                    label="Sessions (24h)"
                    value={health.sessions24h}
                    max={20}
                    color="#8B5CF6"
                    icon={Activity}
                />
                <HealthBar
                    label="PII Scrubbed"
                    value={health.piiScrubbed}
                    max={health.totalInsights}
                    color="#10B981"
                    icon={Shield}
                />
                <HealthBar
                    label="Extracciones Exitosas"
                    value={100 - health.extractionErrors24h}
                    max={100}
                    color="#F59E0B"
                    icon={Zap}
                />
            </div>

            {/* Status indicators */}
            <div className="mt-6 pt-4 border-t border-white/10 space-y-2">
                <div className="flex items-center justify-between">
                    <span className="text-white/50 text-sm">Avg Confidence</span>
                    <span className="text-emerald-400 font-medium">{health.avgConfidence}%</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-white/50 text-sm">Active Patterns</span>
                    <span className="text-white/70 font-medium">{health.activePatterns}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-white/50 text-sm">Active Consolidations</span>
                    <span className="text-white/70 font-medium">{health.activeConsolidations}</span>
                </div>
            </div>

            {/* Overall status */}
            <div className="mt-6 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-emerald-400 text-sm font-medium">Sistema Operativo</span>
                </div>
            </div>
        </div>
    );
}
