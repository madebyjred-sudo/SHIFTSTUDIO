import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, ChevronDown, ShieldAlert, AlertOctagon } from "lucide-react";
import { useState } from "react";
import reportData from "../../data/report-data";

const severityConfig = {
    critical: {
        color: "#EF4444",
        bgColor: "rgba(239, 68, 68, 0.15)",
        icon: ShieldAlert,
        label: "CRÍTICO",
    },
    high: {
        color: "#F97316",
        bgColor: "rgba(249, 115, 22, 0.15)",
        icon: AlertOctagon,
        label: "ALTO",
    },
    medium: {
        color: "#F59E0B",
        bgColor: "rgba(245, 158, 11, 0.15)",
        icon: AlertTriangle,
        label: "MEDIO",
    },
    low: {
        color: "#3B82F6",
        bgColor: "rgba(59, 130, 246, 0.15)",
        icon: AlertTriangle,
        label: "BAJO",
    },
};

interface RiskCardProps {
    risk: (typeof reportData.risks)[0];
    index: number;
}

function RiskCard({ risk, index }: RiskCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const config = severityConfig[risk.severity];
    const Icon = config.icon;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: index * 0.1 }}
            className="glass-dark rounded-xl border border-white/10 overflow-hidden"
        >
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-4 flex items-center gap-3 text-left hover:bg-white/5 transition-colors"
            >
                <div
                    className="p-2 rounded-lg flex-shrink-0"
                    style={{ backgroundColor: config.bgColor, color: config.color }}
                >
                    <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span
                            className="text-xs font-bold px-2 py-0.5 rounded"
                            style={{ backgroundColor: config.bgColor, color: config.color }}
                        >
                            {config.label}
                        </span>
                        <span className="text-white/40 text-xs">#{risk.insightId}</span>
                    </div>
                    <h4 className="text-white font-medium mt-1 truncate">{risk.title}</h4>
                </div>
                <motion.div
                    animate={{ rotate: isExpanded ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className="text-white/40"
                >
                    <ChevronDown className="w-5 h-5" />
                </motion.div>
            </button>

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3 }}
                        className="border-t border-white/10"
                    >
                        <div className="p-4 space-y-3">
                            <div>
                                <span className="text-white/50 text-xs uppercase tracking-wider">
                                    Descripción
                                </span>
                                <p className="text-white/80 text-sm mt-1">{risk.description}</p>
                            </div>
                            <div>
                                <span className="text-white/50 text-xs uppercase tracking-wider">
                                    Impacto
                                </span>
                                <p
                                    className="text-sm mt-1 font-medium"
                                    style={{ color: config.color }}
                                >
                                    {risk.impact}
                                </p>
                            </div>
                            <div>
                                <span className="text-white/50 text-xs uppercase tracking-wider">
                                    Mitigación
                                </span>
                                <p className="text-white/80 text-sm mt-1">{risk.mitigation}</p>
                            </div>
                            <div className="flex items-center justify-between pt-2 border-t border-white/5">
                                <span className="text-white/40 text-xs">Agente: {risk.agent}</span>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
}

export default function RiskPanel() {
    const { risks } = reportData;

    const criticalCount = risks.filter((r) => r.severity === "critical").length;
    const highCount = risks.filter((r) => r.severity === "high").length;

    return (
        <div className="glass-dark rounded-2xl p-6 border border-white/10">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-white font-heading">
                        Riesgos Críticos Detectados
                    </h3>
                    <p className="text-white/50 text-sm mt-1">
                        Alertas priorizadas por impacto estratégico
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {criticalCount > 0 && (
                        <span className="px-3 py-1 rounded-full text-xs font-bold bg-red-500/20 text-red-400">
                            {criticalCount} CRÍTICO
                        </span>
                    )}
                    {highCount > 0 && (
                        <span className="px-3 py-1 rounded-full text-xs font-bold bg-orange-500/20 text-orange-400">
                            {highCount} ALTO
                        </span>
                    )}
                </div>
            </div>

            <div className="space-y-3">
                {risks.map((risk, index) => (
                    <RiskCard key={risk.id} risk={risk} index={index} />
                ))}
            </div>
        </div>
    );
}
