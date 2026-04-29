import { motion } from "motion/react";
import { Brain, Calendar, TrendingUp } from "lucide-react";
import KPICards from "./KPICards";
import CategoryChart from "./CategoryChart";
import RiskPanel from "./RiskPanel";
import VectorPanel from "./VectorPanel";
import TenantTabs from "./TenantTabs";
import SystemHealth from "./SystemHealth";
import reportData from "../../data/report-data";

function MacroPatterns() {
    return (
        <div className="glass-dark rounded-2xl p-6 border border-white/10">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-white font-heading">
                        Patrones Macro Identificados
                    </h3>
                    <p className="text-white/50 text-sm mt-1">
                        Tendencias estratégicas de alto nivel
                    </p>
                </div>
                <TrendingUp className="w-6 h-6 text-white/40" />
            </div>

            <div className="space-y-4">
                {reportData.patterns.map((pattern, index) => (
                    <motion.div
                        key={pattern.title}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, delay: index * 0.1 }}
                        className="p-4 rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
                    >
                        <div className="flex items-start gap-3">
                            <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                                <span className="text-blue-400 text-xs font-bold">{index + 1}</span>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <h4 className="text-white font-medium">{pattern.title}</h4>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
                                        {pattern.confidence}% conf
                                    </span>
                                </div>
                                <p className="text-white/60 text-sm mt-1">{pattern.description}</p>
                                <div className="flex gap-1 mt-2">
                                    {pattern.agents.map((agent) => (
                                        <span
                                            key={agent}
                                            className="text-xs text-white/40 bg-white/5 px-2 py-0.5 rounded"
                                        >
                                            {agent}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>
        </div>
    );
}

export default function AdminDashboard() {
    return (
        <div className="min-h-screen bg-mesh text-white font-sans overflow-x-hidden">
            {/* Header */}
            <header className="border-b border-white/10 bg-black/20 backdrop-blur-lg sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-6 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-purple-500/20 text-purple-400">
                                <Brain className="w-6 h-6" />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold font-heading">
                                    El Cerebro
                                </h1>
                                <p className="text-white/50 text-sm">
                                    Intelligence Dashboard
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2 text-white/50 text-sm">
                                <Calendar className="w-4 h-4" />
                                <span>{reportData.period}</span>
                            </div>
                            <div className="px-3 py-1 rounded-full bg-white/10 text-white/70 text-sm">
                                {reportData.totalInsights} insights
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-6 py-8">
                {/* KPIs */}
                <section className="mb-8">
                    <KPICards />
                </section>

                {/* Grid Layout */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                    {/* Left Column */}
                    <div className="space-y-8">
                        <CategoryChart />
                        <RiskPanel />
                    </div>

                    {/* Right Column */}
                    <div className="space-y-8">
                        <VectorPanel />
                        <TenantTabs />
                        <SystemHealth />
                    </div>
                </div>

                {/* Full Width: Macro Patterns */}
                <section className="mb-8">
                    <MacroPatterns />
                </section>

                {/* Footer */}
                <footer className="text-center text-white/30 text-sm py-8 border-t border-white/10">
                    <p>El Cerebro v1.0 — Generated {reportData.generatedAt}</p>
                    <p className="mt-1">Shift Lab Intelligence Platform</p>
                </footer>
            </main>
        </div>
    );
}
