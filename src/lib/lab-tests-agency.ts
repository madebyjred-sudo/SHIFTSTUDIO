/**
 * LAB TESTS PARA AGENCIAS CREATIVAS Y PR
 * 3 Casos B2B de alto impacto con logging completo
 */

import { useActiveGraphStore } from '../store';

export interface LabResult {
    caseId: string;
    caseName: string;
    timestamp: string;
    durationMs: number;
    nodes: Array<{
        id: string;
        type: string;
        agent?: string;
        prompt?: string;
        status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
        outputText?: string;
        startTime?: number;
        endTime?: number;
        durationMs?: number;
    }>;
    edges: Array<{ id: string; source: string; target: string }>;
    finalOutput?: string;
}

export const labResults: LabResult[] = [];

// CASO 1: CRISIS DE REPUTACIÓN
// Agencia PR recibe alerta de crisis. Necesita análisis paralelo de Legal, PR y CEO
// que converge en un consolidador para dar una respuesta única coordinada.
const crisisReputation: any = {
    nodes: [
        {
            id: 'ctx-crisis',
            type: 'context',
            position: { x: 50, y: 250 },
            data: {
                text: `ALERTA DE CRISIS: Cliente PharmaCorp. Un influencer con 2M de seguidores acaba de publicar un video afirmando que nuestro suplemento "VitaBoost" causó efectos adversos. El video tiene 500K views en 3 horas. Medios de salud están solicitando declaraciones. Tenemos 6 horas para responder antes de que los medios mainstream lo cubran. Necesitamos: (1) evaluación legal de riesgos, (2) estrategia de comunicación de crisis, (3) posicionamiento ejecutivo para declaraciones.`
            }
        },
        {
            id: 'legal-crisis',
            type: 'specialist',
            position: { x: 400, y: 100 },
            data: {
                agent: 'patricia',
                prompt: 'Evalúa los riesgos legales inmediatos: responsabilidad del producto, posibles demandas, requisitos regulatorios FDA/ANMAT, y qué puede/debe decir legalmente la empresa. Prioriza: qué NO debemos decir.'
            }
        },
        {
            id: 'pr-crisis',
            type: 'specialist',
            position: { x: 400, y: 250 },
            data: {
                agent: 'valentina',
                prompt: 'Diseña estrategia de comunicación de crisis: mensajes clave, canales prioritarios, timing de respuesta, y cómo contrarrestar la narrativa del influencer. Incluye: tono recomendado y3 posturas posibles.'
            }
        },
        {
            id: 'ceo-crisis',
            type: 'specialist',
            position: { x: 400, y: 400 },
            data: {
                agent: 'carmen',
                prompt: 'Define posicionamiento ejecutivo: ¿el CEO debe salir al frente o un portavoz? ¿Qué nivel de responsabilidad asumimos? ¿Narrativa de defensa proactiva o cautelosa? Equilibra reputación vs riesgo legal.'
            }
        },
        {
            id: 'consolidator-crisis',
            type: 'specialist',
            position: { x: 750, y: 250 },
            data: {
                agent: 'catalina',
                prompt: 'Consolida los tres análisis (Legal, PR, CEO) en UN documento de crisis cohesivo. Resume: riesgos principales, estrategia recomendada, mensajes clave aprobados por legal, y línea de tiempo de acción. Este documento irá directo al CEO para aprobación.'
            }
        }
    ],
    edges: [
        { id: 'e1', source: 'ctx-crisis', target: 'legal-crisis' },
        { id: 'e2', source: 'ctx-crisis', target: 'pr-crisis' },
        { id: 'e3', source: 'ctx-crisis', target: 'ceo-crisis' },
        { id: 'e4', source: 'legal-crisis', target: 'consolidator-crisis' },
        { id: 'e5', source: 'pr-crisis', target: 'consolidator-crisis' },
        { id: 'e6', source: 'ceo-crisis', target: 'consolidator-crisis' }
    ]
};

// CASO 2: CAMPAÑA MULTICANAL
// Concepto creativo que se adapta a diferentes canales y se consolida en estrategia integrada
const multichannelCampaign: any = {
    nodes: [
        {
            id: 'ctx-campaign',
            type: 'context',
            position: { x: 50, y: 300 },
            data: {
                text: `NUEVO CLIENTE: EcoTech, startup de tecnología sustentable. Brief: Lanzar su app de huella de carbono personal. Target: Millennials y Gen Z conscientes del medio ambiente. Presupuesto: medio. Necesitamos un concepto creativo BIG IDEA que luego se adapte a Instagram, TikTok, LinkedIn y PR (comunicado de prensa). Al final necesitamos una estrategia integrada cohesiva.`
            }
        },
        {
            id: 'creative-bigidea',
            type: 'specialist',
            position: { x: 350, y: 200 },
            data: {
                agent: 'valentina',
                prompt: 'Genera la BIG IDEA creativa para EcoTech: concepto central memorable, insight humano, y propuesta de valor emocional. Debe ser adaptabl a digital y tradicional.'
            }
        },
        {
            id: 'adapt-instagram',
            type: 'specialist',
            position: { x: 650, y: 50 },
            data: {
                agent: 'daniela',
                prompt: 'Toma la BIG IDEA y crea: 3 carruseles de Instagram + captions + hashtags. Enfocado en estética aspiracional y comunidad.'
            }
        },
        {
            id: 'adapt-tiktok',
            type: 'specialist',
            position: { x: 650, y: 200 },
            data: {
                agent: 'daniela',
                prompt: 'Toma la BIG IDEA y crea: 2 scripts de TikTok (15s y 60s) con trending audio sugerido. Enfocado en viralidad y challenge potencial.'
            }
        },
        {
            id: 'adapt-linkedin',
            type: 'specialist',
            position: { x: 650, y: 350 },
            data: {
                agent: 'roberto',
                prompt: 'Toma la BIG IDEA y crea: artículo de LinkedIn para el fundador de EcoTech + 2 posts de empresa. Enfocado en thought leadership y impacto de negocio.'
            }
        },
        {
            id: 'adapt-pr',
            type: 'specialist',
            position: { x: 650, y: 500 },
            data: {
                agent: 'valentina',
                prompt: 'Toma la BIG IDEA y crea: comunicado de prensa completo (titular, bajada, cuerpo, quote del CEO). Enfocado en periodistas de tech y sostenibilidad.'
            }
        },
        {
            id: 'consolidator-campaign',
            type: 'specialist',
            position: { x: 1000, y: 300 },
            data: {
                agent: 'catalina',
                prompt: 'Consolida TODO en Estrategia de Campaña Integrada 360°: BIG IDEA + adaptaciones por canal + línea de tiempo de lanzamiento + KPIs sugeridos + presupuesto estimado por canal. Documento final para presentación al cliente.'
            }
        }
    ],
    edges: [
        { id: 'e1', source: 'ctx-campaign', target: 'creative-bigidea' },
        { id: 'e2', source: 'creative-bigidea', target: 'adapt-instagram' },
        { id: 'e3', source: 'creative-bigidea', target: 'adapt-tiktok' },
        { id: 'e4', source: 'creative-bigidea', target: 'adapt-linkedin' },
        { id: 'e5', source: 'creative-bigidea', target: 'adapt-pr' },
        { id: 'e6', source: 'ctx-campaign', target: 'consolidator-campaign' },
        { id: 'e7', source: 'adapt-instagram', target: 'consolidator-campaign' },
        { id: 'e8', source: 'adapt-tiktok', target: 'consolidator-campaign' },
        { id: 'e9', source: 'adapt-linkedin', target: 'consolidator-campaign' },
        { id: 'e10', source: 'adapt-pr', target: 'consolidator-campaign' }
    ]
};

// CASO 3: PITCH DE NUEVO CLIENTE
// Research → Estrategia → Creativo → Ejecutivo consolidado
const newClientPitch: any = {
    nodes: [
        {
            id: 'ctx-pitch',
            type: 'context',
            position: { x: 50, y: 200 },
            data: {
                text: `OPORTUNIDAD PITCH: FinStart Bank quiere cambiar de agencia. Es un banco tradicional intentando atraer a jóvenes (18-30). Sus competidores son Nubank, Ualá y Mercado Pago. Tenemos reunión de pitch en 48 horas. Necesitamos: análisis competitivo, estrategia de repositionamiento, y concepto creativo ganador.`
            }
        },
        {
            id: 'research-competitive',
            type: 'specialist',
            position: { x: 350, y: 100 },
            data: {
                agent: 'daniela',
                prompt: 'Análisis competitivo profundo: Nubank, Ualá, Mercado Pago. Analiza: posicionamiento, fortalezas, debilidades, mensajes clave, y brechas que FinStart puede explotar. Incluye perceptual map.'
            }
        },
        {
            id: 'strategy-positioning',
            type: 'specialist',
            position: { x: 350, y: 300 },
            data: {
                agent: 'roberto',
                prompt: 'Estrategia de repositionamiento: ¿cómo hace un banco tradicional para ser relevante para Gen Z sin parecer forzado? Propuesta de valor única, arquitectura de marca, y customer journey redesign.'
            }
        },
        {
            id: 'creative-concept',
            type: 'specialist',
            position: { x: 650, y: 200 },
            data: {
                agent: 'valentina',
                prompt: 'Concepto creativo ganador para el pitch: BIG IDEA, manifesto de marca, moodboard descriptivo, y 3 ideas de activación (una digital, una experiencial, una tradicional). Debe diferenciarse de los fintech.'
            }
        },
        {
            id: 'consolidator-pitch',
            type: 'specialist',
            position: { x: 950, y: 200 },
            data: {
                agent: 'carmen',
                prompt: 'Consolida en Presentación Ejecutiva de Pitch: Resumen ejecutivo (1 página) + Análisis competitivo (2 págs) + Estrategia (2 págs) + Concepto creativo (3 págs) + Implementación y presupuesto estimado (2 págs). Documento listo para presentar al CMO de FinStart.'
            }
        }
    ],
    edges: [
        { id: 'e1', source: 'ctx-pitch', target: 'research-competitive' },
        { id: 'e2', source: 'ctx-pitch', target: 'strategy-positioning' },
        { id: 'e3', source: 'research-competitive', target: 'creative-concept' },
        { id: 'e4', source: 'strategy-positioning', target: 'creative-concept' },
        { id: 'e5', source: 'research-competitive', target: 'consolidator-pitch' },
        { id: 'e6', source: 'strategy-positioning', target: 'consolidator-pitch' },
        { id: 'e7', source: 'creative-concept', target: 'consolidator-pitch' }
    ]
};

export const agencyTestCases: Record<string, any> = {
    crisis_reputation: crisisReputation,
    multichannel_campaign: multichannelCampaign,
    newclient_pitch: newClientPitch
};

// Función mejorada con logging completo
export async function loadAndRunAgencyTest(
    caseId: keyof typeof agencyTestCases,
    onProgress?: (result: Partial<LabResult>) => void
): Promise<LabResult> {
    const store = useActiveGraphStore.getState();
    const testCase = agencyTestCases[caseId];

    if (!testCase) {
        throw new Error(`Caso no encontrado: ${caseId}`);
    }

    console.log(`🧪 INICIANDO TEST AGENCIA: ${caseId}`);
    const startTime = Date.now();

    // Limpiar y cargar
    store.setNodes([]);
    store.setEdges([]);
    await new Promise(r => setTimeout(r, 100));

    store.setNodes(testCase.nodes);
    store.setEdges(testCase.edges);
    store.setActiveMode('canvas');

    await new Promise(r => setTimeout(r, 500));

    // Ejecutar
    console.log('🚀 Ejecutando grafo...');
    store.executeGraph();

    // Esperar a que termine y recolectar datos
    const result: LabResult = {
        caseId,
        caseName: caseId.replace(/_/g, ' ').toUpperCase(),
        timestamp: new Date().toISOString(),
        durationMs: 0,
        nodes: [],
        edges: testCase.edges
    };

    // Monitorear hasta que termine
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            const state = useActiveGraphStore.getState();
            const currentNodes = state.nodes;

            // Verificar si terminó
            const isExecuting = state.isExecuting;
            const allCompleted = currentNodes.every(
                (n: any) => n.data?.status === 'COMPLETED' || n.data?.status === 'FAILED'
            );

            // Actualizar nodos con data actual
            result.nodes = currentNodes.map((n: any) => ({
                id: n.id,
                type: n.type,
                agent: n.data?.agent,
                prompt: n.data?.prompt,
                status: n.data?.status || 'IDLE',
                outputText: n.data?.outputText,
                startTime: n.data?.startTime,
                endTime: n.data?.endTime,
                durationMs: n.data?.endTime && n.data?.startTime
                    ? (n.data.endTime as number) - (n.data.startTime as number)
                    : undefined
            }));

            if (onProgress) {
                onProgress({ ...result, durationMs: Date.now() - startTime });
            }

            if (!isExecuting || allCompleted) {
                clearInterval(checkInterval);
                result.durationMs = Date.now() - startTime;

                // Capturar output final del consolidador
                const consolidator = currentNodes.find(
                    (n: any) => n.id.includes('consolidator') && n.data?.outputText
                );
                if (consolidator) {
                    result.finalOutput = String(consolidator.data.outputText);
                }

                // Guardar en resultados
                labResults.push(result);
                console.log('✅ Test completado:', result);
                resolve(result);
            }
        }, 1000);

        // Timeout de seguridad: 5 minutos
        setTimeout(() => {
            clearInterval(checkInterval);
            result.durationMs = Date.now() - startTime;
            labResults.push(result);
            resolve(result);
        }, 300000);
    });
}

// Exponer globalmente para testing manual
if (typeof window !== 'undefined') {
    (window as any).agencyTests = agencyTestCases;
    (window as any).runAgencyTest = loadAndRunAgencyTest;
    (window as any).getLabResults = () => labResults;
}
