import { motion } from "motion/react";
import { BarChart3, Shield, Lock, Users, Zap, Clock } from "lucide-react";
import reportData from "../../data/report-data";

interface KPICardProps {
    title: string;
    value: string | number;
    subtitle: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
    delay?: number;
}

function KPICard({ title, value, subtitle, icon: Icon, color, delay = 0 }: KPICardProps) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay }}
            whileHover={{ scale: 1.02, y: -2 }}
            className="glass-dark rounded-2xl p-6 border border-white/10 cursor-pointer group"
        >
            <div className="flex items-start justify-between">
                <div>
                    <p className="text-white/60 text-sm font-medium mb-1">{title}</p>
                    <h3 className="text-3xl font-bold text-white font-heading tracking-tight">
                        {value}
                    </h3>
                    <p className="text-white/40 text-xs mt-1">{subtitle}</p>
                </div>
                <div
                    className="p-3 rounded-xl bg-white/5 group-hover:bg-white/10 transition-colors"
                    style={{ color }}
                >
                    <Icon className="w-6 h-6" />
                </div>
            </div>
            <div
                className="mt-4 h-1 rounded-full w-16 opacity-60"
                style={{ backgroundColor: color }}
            />
        </motion.div>
    );
}

export default function KPICards() {
    const { kpis } = reportData;

    const cards = [
        {
            title: "Total Insights",
            value: kpis.totalInsights,
            subtitle: "+31 en últimas 24h",
            icon: BarChart3,
            color: "#3B82F6",
        },
        {
            title: "Confianza Promedio",
            value: `${kpis.avgConfidence}%`,
            subtitle: "Alta precisión",
            icon: Shield,
            color: "#10B981",
        },
        {
            title: "PII Scrubbing",
            value: `${kpis.piiScrubbedPercent}%`,
            subtitle: "24 de 34 anonimizados",
            icon: Lock,
            color: "#F59E0B",
        },
        {
            title: "Agentes Activos",
            value: kpis.activeAgents,
            subtitle: "17 especializados",
            icon: Users,
            color: "#8B5CF6",
        },
        {
            title: "Extracciones Exitosas",
            value: `${kpis.extractionSuccess}%`,
            subtitle: "Tasa perfecta",
            icon: Zap,
            color: "#EF4444",
        },
        {
            title: "Insights 24h",
            value: kpis.insights24h,
            subtitle: "Duplicando promedio",
            icon: Clock,
            color: "#EC4899",
        },
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cards.map((card, index) => (
                <KPICard key={card.title} {...card} delay={index * 0.1} />
            ))}
        </div>
    );
}
