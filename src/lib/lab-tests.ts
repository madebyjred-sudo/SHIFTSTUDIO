import { useActiveGraphStore } from '../store';

const testCases = {
    // Caso 1: El "War Room" Paralelo (Stress Test del Motor Fase 3)
    parallel_stress: {
        nodes: [
            { id: 'ctx1', type: 'context', position: { x: 50, y: 200 }, data: { text: "Reporte Q3: Ingresos bajaron 15% por fuga de clientes en LATAM. Necesitamos un plan urgente de retención y análisis legal de posibles penalizaciones por incumplimiento de contratos." } },
            { id: 'sp_cfo', type: 'specialist', position: { x: 400, y: 50 }, data: { agent: 'roberto', prompt: 'Analiza el impacto financiero de la fuga del 15%.' } },
            { id: 'sp_legal', type: 'specialist', position: { x: 400, y: 250 }, data: { agent: 'patricia', prompt: 'Identifica riesgos legales por penalizaciones.' } },
            { id: 'sp_cs', type: 'specialist', position: { x: 400, y: 450 }, data: { agent: 'emilio', prompt: 'Propón un plan de retención de urgencia.' } },
            { id: 'export1', type: 'export', position: { x: 800, y: 250 }, data: { format: 'PDF' } }
        ],
        edges: [
            { id: 'e1', source: 'ctx1', target: 'sp_cfo' },
            { id: 'e2', source: 'ctx1', target: 'sp_legal' },
            { id: 'e3', source: 'ctx1', target: 'sp_cs' },
            { id: 'e4', source: 'sp_cfo', target: 'export1' },
            { id: 'e5', source: 'sp_legal', target: 'export1' },
            { id: 'e6', source: 'sp_cs', target: 'export1' }
        ]
    },

    // Caso 2: El "Pitch Deck" Secuencial (Deep Context)
    sequential_pitch: {
        nodes: [
            { id: 'ctx1', type: 'context', position: { x: 50, y: 150 }, data: { text: "Cliente B2B SaaS busca una campaña de reposicionamiento de marca." } },
            { id: 'sp_cmo', type: 'specialist', position: { x: 350, y: 150 }, data: { agent: 'valentina', prompt: 'Diseña el concepto creativo principal para el reposicionamiento.' } },
            { id: 'sp_pm', type: 'specialist', position: { x: 650, y: 150 }, data: { agent: 'catalina', prompt: 'Toma el concepto creativo y estructúralo en un roadmap de 4 semanas.' } },
            { id: 'export1', type: 'export', position: { x: 950, y: 150 }, data: { format: 'PPTX' } }
        ],
        edges: [
            { id: 'e1', source: 'ctx1', target: 'sp_cmo' },
            { id: 'e2', source: 'sp_cmo', target: 'sp_pm' },
            { id: 'e3', source: 'sp_pm', target: 'export1' }
        ]
    },

    // Caso 3: Resiliencia y Fault Tolerance (Chaos Monkey)
    fault_tolerance: {
        nodes: [
            { id: 'ctx1', type: 'context', position: { x: 50, y: 150 }, data: { text: "Prueba de fallo del sistema." } },
            // Intentamos provocar un fallo usando un agente inexistente o pidiendo que falle (aunque es difícil forzar un 500 sin tocar el backend)
            // En este caso, el backend manejará esto como un prompt normal si no forzamos error.
            { id: 'sp_fail', type: 'specialist', position: { x: 350, y: 150 }, data: { agent: 'shiftai', prompt: 'SYSTEM_FORCE_ERROR_PLEASE' } },
            { id: 'export1', type: 'export', position: { x: 650, y: 150 }, data: { format: 'DOCX' } }
        ],
        edges: [
            { id: 'e1', source: 'ctx1', target: 'sp_fail' },
            { id: 'e2', source: 'sp_fail', target: 'export1' }
        ]
    },

    // Caso 4: Text Aggregation (Final Answer sin Exportar)
    text_aggregation: {
        nodes: [
            { id: 'ctx1', type: 'context', position: { x: 50, y: 150 }, data: { text: "Necesito un resumen de los competidores clave en IA: OpenAI, Anthropic, Google." } },
            { id: 'sp_intel', type: 'specialist', position: { x: 350, y: 50 }, data: { agent: 'daniela', prompt: 'Haz un análisis rápido de debilidades de OpenAI y Anthropic.' } },
            { id: 'sp_ceo', type: 'specialist', position: { x: 700, y: 150 }, data: { agent: 'carmen', prompt: 'Toma el análisis y dame un dictamen ejecutivo en 2 párrafos sobre cómo competir contra ellos. Solo texto, directo al grano.' } }
        ],
        edges: [
            { id: 'e1', source: 'ctx1', target: 'sp_intel' },
            { id: 'e2', source: 'sp_intel', target: 'sp_ceo' },
            { id: 'e3', source: 'ctx1', target: 'sp_ceo' } // Context also goes to CEO directly
        ]
    }
};

export function loadLabTest(caseName: keyof typeof testCases) {
    const store = useActiveGraphStore.getState();
    const testCase = testCases[caseName];
    if (!testCase) {
        console.error(`Caso no encontrado. Disponibles: ${Object.keys(testCases).join(', ')}`);
        return;
    }

    // Limpiar y cargar
    store.setNodes(testCase.nodes as any);
    store.setEdges(testCase.edges as any);
    console.log(`🧪 Laboratorio: Cargado caso '${caseName}'. Para ejecutar: useActiveGraphStore.getState().executeGraph()`);
}

// Exponer globalmente
if (typeof window !== 'undefined') {
    (window as any).loadLabTest = loadLabTest;
    (window as any).runLabTest = () => useActiveGraphStore.getState().executeGraph();

    // Auto-load from URL: ?lab=text_aggregation&autorun=true
    const params = new URLSearchParams(window.location.search);
    const labCase = params.get('lab');
    if (labCase) {
        // Wait for React to hydrate, then load & optionally run
        setTimeout(() => {
            console.log(`🧪 AUTO-LOAD: Detectado ?lab=${labCase}`);
            // Switch to canvas mode
            useActiveGraphStore.getState().setActiveMode('canvas');
            loadLabTest(labCase as any);

            if (params.get('autorun') === 'true') {
                setTimeout(() => {
                    console.log('🚀 AUTO-RUN: Ejecutando grafo...');
                    useActiveGraphStore.getState().executeGraph();
                }, 1000);
            }
        }, 1500);
    }
}
