import { motion } from "motion/react";
import { Building2, CheckCircle, XCircle, TrendingUp } from "lucide-react";
import { useState } from "react";
import reportData from "../../data/report-data";

export default function TenantTabs() {
    const { tenants } = reportData;
    const [activeTenant, setActiveTenant] = useState(tenants[0].id);

    const selectedTenant = tenants.find((t) => t.id === activeTenant);

    return (
        <div className="glass-dark rounded-2xl p-6 border border-white/10">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-white font-heading">
                        Análisis por Tenant
                    </h3>
                    <p className="text-white/50 text-sm mt-1">
                        Distribución de insights por organización
                    </p>
                </div>
                <Building2 className="w-6 h-6 text-white/40" />
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-6">
                {tenants.map((tenant) => (
                    <button
                        key={tenant.id}
                        onClick={() => setActiveTenant(tenant.id)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTenant === tenant.id
                                ? "bg-white/10 text-white"
                                : "text-white/50 hover:text-white hover:bg-white/5"
                            }`}
                    >
                        {tenant.name}
                    </button>
                ))}
            </div>

            {/* Content */}
            {selectedTenant && (
                <motion.div
                    key={selectedTenant.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    className="space-y-4"
                >
                    <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 rounded-xl bg-white/5">
                            <span className="text-white/40 text-xs">Insights</span>
                            <p className="text-2xl font-bold text-white">{selectedTenant.insights}</p>
                        </div>
                        <div className="p-4 rounded-xl bg-white/5">
                            <span className="text-white/40 text-xs">Confianza</span>
                            <p className="text-2xl font-bold text-white">
                                {selectedTenant.confidence > 0 ? `${selectedTenant.confidence}%` : "-"}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-4 p-4 rounded-xl bg-white/5">
                        <div className="flex-1">
                            <span className="text-white/40 text-xs">Industria</span>
                            <p className="text-white font-medium">{selectedTenant.industry}</p>
                        </div>
                        <div className="flex-1">
                            <span className="text-white/40 text-xs">Tipo</span>
                            <p className="text-white font-medium capitalize">{selectedTenant.type}</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 p-4 rounded-xl bg-white/5">
                        <span className="text-white/40 text-xs flex-1">Punto Medio Access</span>
                        {selectedTenant.puntoMedioAccess ? (
                            <span className="flex items-center gap-1 text-emerald-400 text-sm">
                                <CheckCircle className="w-4 h-4" /> Activo
                            </span>
                        ) : (
                            <span className="flex items-center gap-1 text-red-400 text-sm">
                                <XCircle className="w-4 h-4" /> Inactivo
                            </span>
                        )}
                    </div>
                </motion.div>
            )}

            {/* Summary */}
            <div className="mt-6 pt-4 border-t border-white/10">
                <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-white/40" />
                    <span className="text-white/50 text-sm">
                        {tenants.reduce((acc, t) => acc + t.insights, 0)} insights totales
                    </span>
                </div>
            </div>
        </div>
    );
}
