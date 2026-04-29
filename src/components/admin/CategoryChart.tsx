import { motion } from "motion/react";
import { AlertTriangle, TrendingUp, Rocket, Wrench } from "lucide-react";
import reportData from "../../data/report-data";

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    AlertTriangle,
    TrendingUp,
    Rocket,
    Wrench,
};

export default function CategoryChart() {
    const { categories } = reportData;
    const maxCount = Math.max(...categories.map((c) => c.count));

    return (
        <div className="glass-dark rounded-2xl p-6 border border-white/10">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-white font-heading">
                        Distribución por Categoría C-Suite
                    </h3>
                    <p className="text-white/50 text-sm mt-1">
                        Insights clasificados por taxonomía ejecutiva
                    </p>
                </div>
                <div className="text-right">
                    <span className="text-3xl font-bold text-white font-heading">
                        {categories.length}
                    </span>
                    <p className="text-white/40 text-xs">categorías</p>
                </div>
            </div>

            <div className="space-y-4">
                {categories.map((category, index) => {
                    const Icon = iconMap[category.icon] || AlertTriangle;
                    const widthPercent = (category.count / maxCount) * 100;

                    return (
                        <motion.div
                            key={category.key}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.5, delay: index * 0.1 }}
                            className="group"
                        >
                            <div className="flex items-center gap-3 mb-2">
                                <div
                                    className="p-2 rounded-lg"
                                    style={{
                                        backgroundColor: `${category.color}20`,
                                        color: category.color,
                                    }}
                                >
                                    <Icon className="w-4 h-4" />
                                </div>
                                <div className="flex-1">
                                    <div className="flex items-center justify-between">
                                        <span className="text-white font-medium text-sm">
                                            {category.label}
                                        </span>
                                        <div className="flex items-center gap-3">
                                            <span
                                                className="text-xs px-2 py-0.5 rounded-full"
                                                style={{
                                                    backgroundColor: `${category.color}20`,
                                                    color: category.color,
                                                }}
                                            >
                                                {category.confidence}% conf
                                            </span>
                                            <span className="text-white font-bold w-8 text-right">
                                                {category.count}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="mt-2 h-2 bg-white/5 rounded-full overflow-hidden">
                                        <motion.div
                                            initial={{ width: 0 }}
                                            animate={{ width: `${widthPercent}%` }}
                                            transition={{
                                                duration: 0.8,
                                                delay: index * 0.1 + 0.3,
                                                ease: "easeOut",
                                            }}
                                            className="h-full rounded-full"
                                            style={{ backgroundColor: category.color }}
                                        />
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    );
                })}
            </div>

            {/* Summary */}
            <div className="mt-6 pt-4 border-t border-white/10">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-white/50">Total insights categorizados:</span>
                    <span className="text-white font-bold">
                        {categories.reduce((acc, c) => acc + c.count, 0)}
                    </span>
                </div>
            </div>
        </div>
    );
}
