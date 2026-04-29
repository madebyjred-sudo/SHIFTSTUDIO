import { motion } from "motion/react";
import { Rocket, Target, CheckCircle } from "lucide-react";
import reportData from "../../data/report-data";

export default function VectorPanel() {
    const { vectors } = reportData;

    return (
        <div className="glass-dark rounded-2xl p-6 border border-white/10">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-white font-heading">
                        Vectores de Aceleración
                    </h3>
                    <p className="text-white/50 text-sm mt-1">
                        Oportunidades de alto potencial identificadas
                    </p>
                </div>
                <div className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400">
                    <Rocket className="w-6 h-6" />
                </div>
            </div>

            <div className="space-y-4">
                {vectors.map((vector, index) => (
                    <motion.div
                        key={vector.id}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.5, delay: index * 0.1 }}
                        className="p-4 rounded-xl bg-white/5 hover:bg-white/10 transition-colors border border-white/5"
                    >
                        <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 mt-1">
                                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                                    <Target className="w-4 h-4 text-emerald-400" />
                                </div>
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <h4 className="text-white font-medium">{vector.title}</h4>
                                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">
                                        {vector.confidence}% conf
                                    </span>
                                </div>
                                <p className="text-white/60 text-sm mt-1">
                                    {vector.description}
                                </p>
                                <div className="mt-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                                    <div className="flex items-start gap-2">
                                        <CheckCircle className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                                        <p className="text-emerald-300 text-sm">
                                            {vector.actionable}
                                        </p>
                                    </div>
                                </div>
                                <div className="mt-2 flex items-center gap-2">
                                    <span className="text-white/40 text-xs">Agente:</span>
                                    <span className="text-white/60 text-xs font-medium capitalize">
                                        {vector.agent}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>
        </div>
    );
}
