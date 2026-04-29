/**
 * El Cerebro - Report Data
 * Datos tipados del reporte de insights para el panel administrativo
 * Actualizar semanalmente corriendo extract_db_insights.py
 */

export interface CategoryData {
    key: string;
    label: string;
    count: number;
    confidence: number;
    color: string;
    icon: string;
}

export interface Risk {
    id: string;
    title: string;
    description: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    impact: string;
    mitigation: string;
    insightId: number;
    agent: string;
}

export interface Vector {
    id: string;
    title: string;
    description: string;
    confidence: number;
    agent: string;
    actionable: string;
}

export interface TenantData {
    id: string;
    name: string;
    type: string;
    industry: string;
    insights: number;
    confidence: number;
    puntoMedioAccess: boolean;
}

export interface HealthMetrics {
    insights24h: number;
    insights7d: number;
    sessions24h: number;
    activePatterns: number;
    activeConsolidations: number;
    extractionErrors24h: number;
    avgConfidence: number;
    piiScrubbed: number;
    totalInsights: number;
}

export interface AgentStats {
    id: string;
    count: number;
    confidence: number;
    tenants: number;
}

export interface SentimentData {
    sentiment: string;
    count: number;
    percentage: number;
}

export const reportData = {
    // Metadata
    generatedAt: "2026-03-15T20:35:00-05:00",
    period: "14-16 Marzo 2026",
    totalInsights: 34,
    totalSessions: 18,
    activeAgents: 17,

    // KPIs
    kpis: {
        totalInsights: 34,
        avgConfidence: 83.1,
        piiScrubbedPercent: 71,
        activeAgents: 17,
        extractionSuccess: 100,
        insights24h: 31,
    },

    // Categorías
    categories: [
        {
            key: "riesgos_ciegos",
            label: "Riesgos Ciegos",
            count: 9,
            confidence: 94.2,
            color: "#EF4444",
            icon: "AlertTriangle",
        },
        {
            key: "patrones_sectoriales",
            label: "Patrones Sectoriales",
            count: 12,
            confidence: 78.9,
            color: "#3B82F6",
            icon: "TrendingUp",
        },
        {
            key: "vectores_aceleracion",
            label: "Vectores Aceleración",
            count: 10,
            confidence: 76.0,
            color: "#10B981",
            icon: "Rocket",
        },
        {
            key: "gaps_productividad",
            label: "Gaps Productividad",
            count: 3,
            confidence: 89.7,
            color: "#F59E0B",
            icon: "Wrench",
        },
    ] as CategoryData[],

    // Riesgos
    risks: [
        {
            id: "lgpd-risk",
            title: "Cumplimiento LGPD en Entrenamiento de IA",
            description: "Uso de datos clientes para entrenamiento de IA sin base legal específica (Art. 7, I LGPD). El Machine Unlearning es técnicamente complejo.",
            severity: "critical",
            impact: "Multas hasta 2% del facturado en Brasil + daño reputacional",
            mitigation: "Implementar anonimización verdadera (Art. 13/14 LGPD) y actualizar políticas de privacidad",
            insightId: 32,
            agent: "patricia",
        },
        {
            id: "scope-creep",
            title: "Scope Creep No Gobernado",
            description: "Aceptación de 'change requests' no evaluados a mitad de sprint. El cliente presenta cambios como 'pequeños' pero son CRs no evaluados.",
            severity: "critical",
            impact: "Erosión de entrega del sprint, creación de precedentes adversos",
            mitigation: "Buffer de análisis 48h + taxonomía MoSCoW + negociar swap/next sprint/CR formal",
            insightId: 34,
            agent: "catalina",
        },
        {
            id: "churn-sponsor",
            title: "Churn Silencioso por Pérdida de Sponsor",
            description: "Clientes con health score verde pierden su sponsor ejecutivo, creando riesgo de churn no detectado por métricas tradicionales.",
            severity: "high",
            impact: "Desvinculación gradual sin señales de alerta, pérdida de revenue recurrente",
            mitigation: "Protocolo 3 pasos: identificar nuevo sponsor, evaluar estado real, reconstruir relación",
            insightId: 31,
            agent: "emilio",
        },
        {
            id: "subsidy-risk",
            title: "Inviabilidad de Subsidios para IA en LATAM",
            description: "No existen programas dedicados de subsidios/incentivos fiscales para IA en CR, Panamá ni Colombia en 2025.",
            severity: "high",
            impact: "Estrategias de planificación basadas en incentivos sectoriales específicos son inviables",
            mitigation: "Reorientar hacia incentivos fiscales genéricos (zona franca, deducibles I+D)",
            insightId: 13,
            agent: "roberto",
        },
        {
            id: "channel-error",
            title: "Error de Canal B2B Enterprise",
            description: "Usar Meta Ads para competir con LinkedIn en generación de leads Enterprise B2B. La incapacidad de Meta para segmentar por cargo+empresa desperdicia budget.",
            severity: "medium",
            impact: "70% del budget desperdiciado en audiencias sin intención de compra",
            mitigation: "Modelo 70/20/10: 70% LinkedIn, 20% Meta Retargeting, 10% Testing",
            insightId: 27,
            agent: "isabella",
        },
    ] as Risk[],

    // Vectores de Aceleración
    vectors: [
        {
            id: "pipeline-velocity",
            title: "Pipeline Velocity como Diagnóstico",
            description: "Fórmula estructurada de Pipeline Velocity para diagnosticar exactamente dónde está la fuga en el funnel.",
            confidence: 95,
            agent: "santiago",
            actionable: "Extraer valores del CRM últimos 90 días, calcular línea base semanal, asignar recursos según bottleneck",
        },
        {
            id: "fine-tuning",
            title: "Fine-Tuning Open Source Democratizado",
            description: "Llama 3, Mistral y DeepSeek permiten fine-tuning de nivel producción sin clústeres GPU masivos.",
            confidence: 95,
            agent: "sofia",
            actionable: "Evaluar adopción de fine-tuning para casos de uso específicos antes que la competencia",
        },
        {
            id: "autonomous-agents",
            title: "Agentes Autónomos Cross-App",
            description: "Migración de interfaces conversacionales básicas hacia agentes con capacidad de ejecución cross-app.",
            confidence: 85,
            agent: "diego",
            actionable: "Desarrollar capacidades de agentes autónomos con orquestación entre aplicaciones",
        },
        {
            id: "win-loss",
            title: "Framework DESARMADO-ARQUEOLOGÍA-SÍNTESIS",
            description: "El error crítico en Win/Loss es tratar la llamada como justificación post-mortem. El cliente detecta defensividad en 30 segundos.",
            confidence: 95,
            agent: "daniela",
            actionable: "Implementar entrevistador neutral + técnica de silencio de 4 segundos + consolidación sin sesgo",
        },
    ] as Vector[],

    // Tenants
    tenants: [
        {
            id: "shift",
            name: "Shift Lab",
            type: "internal",
            industry: "Tech/SaaS",
            insights: 33,
            confidence: 82.9,
            puntoMedioAccess: true,
        },
        {
            id: "garnier",
            name: "Garnier",
            type: "client",
            industry: "Media/Comunicación",
            insights: 1,
            confidence: 89.0,
            puntoMedioAccess: true,
        },
        {
            id: "tres_pinos",
            name: "Tres Pinos",
            type: "client",
            industry: "Retail/Consumo",
            insights: 0,
            confidence: 0,
            puntoMedioAccess: false,
        },
    ] as TenantData[],

    // Health Metrics
    health: {
        insights24h: 31,
        insights7d: 34,
        sessions24h: 16,
        activePatterns: 0,
        activeConsolidations: 0,
        extractionErrors24h: 0,
        avgConfidence: 83.1,
        piiScrubbed: 24,
        totalInsights: 34,
    } as HealthMetrics,

    // Agent Stats (Top 10)
    agents: [
        { id: "carmen", count: 4, confidence: 76.3, tenants: 1 },
        { id: "sofia", count: 4, confidence: 87.5, tenants: 1 },
        { id: "shiftai", count: 4, confidence: 71.3, tenants: 1 },
        { id: "lucia", count: 3, confidence: 88.3, tenants: 1 },
        { id: "roberto", count: 3, confidence: 90.7, tenants: 1 },
        { id: "diego", count: 3, confidence: 70.0, tenants: 1 },
        { id: "isabella", count: 2, confidence: 92.0, tenants: 2 },
        { id: "susana", count: 2, confidence: 49.0, tenants: 1 },
        { id: "emilio", count: 1, confidence: 95.0, tenants: 1 },
        { id: "jorge", count: 1, confidence: 95.0, tenants: 1 },
    ] as AgentStats[],

    // Sentiment Distribution
    sentiments: [
        { sentiment: "neutral", count: 16, percentage: 47 },
        { sentiment: "positive", count: 12, percentage: 35 },
        { sentiment: "negative", count: 6, percentage: 18 },
    ] as SentimentData[],

    // Industry Distribution
    industries: [
        { name: "Tech/SaaS", count: 31, percentage: 91.2 },
        { name: "Media/Comunicación", count: 2, percentage: 5.9 },
        { name: "Retail/Consumo", count: 1, percentage: 2.9 },
    ],

    // Temporal Data
    temporal: [
        { date: "2026-03-16", count: 16 },
        { date: "2026-03-15", count: 15 },
        { date: "2026-03-14", count: 3 },
    ],

    // Macro Patterns
    patterns: [
        {
            title: "Pivot SEO → GEO",
            description: "Transición crítica del SEO tradicional hacia optimización para motores de respuesta (Perplexity, AI Overviews).",
            confidence: 95,
            agents: ["lucia", "sofia"],
        },
        {
            title: "Crisis de Madurez Digital",
            description: "Transformaciones digitales fracasan porque digitalizan procesos sin transformar el modelo de toma de decisiones.",
            confidence: 94,
            agents: ["mateo", "diego", "shiftai"],
        },
        {
            title: "Resistencia Cultural a IA",
            description: "Principal inhibidor no es tecnológico sino narrativo-cultural: miedo al desplazamiento laboral.",
            confidence: 95,
            agents: ["shiftai"],
        },
        {
            title: "Evolución Criterio VC",
            description: "Inversión mutó de 'crecimiento a toda costa' hacia 'eficiencia operativa y unit economics'.",
            confidence: 90,
            agents: ["roberto"],
        },
        {
            title: "Lógica Relacional Centroamérica",
            description: "En CR y Panamá, factor humano/confianza precede a validación técnica en ciclo de venta B2B.",
            confidence: 95,
            agents: ["carmen"],
        },
    ],
};

export default reportData;
