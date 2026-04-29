import { FlickeringGrid } from "@/components/ui/flickering-grid-hero";

// Logo de SHIFT (FAVICON.svg) codificado en Base64 asegurando canales alpha compatibles para CSS Masking.
const LOGO_BASE64 = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4gPHN2ZyBpZD0iTGF5ZXJfMSIgZGF0YS1uYW1lPSJMYXllciAxIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NzcuMjQgNDkyLjU3Ij4gICA8ZGVmcz4gICAgPHN0eWxlPiAgICAgIC5jbHMtMSB7ICAgICAgICBmaWxsOiAjZmZmZmZmOyAgICAgIH0gICAgICAuY2xzLTIgeyAgICAgICAgZmlsbDogI2ZmZmZmZjsgICAgICB9ICAgIDwvc3R5bGU+ICA8L2RlZnM+ICA8cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMzMuNiwzNDguNjlsLTIuNjMtNy4xMmMtNC41MywxLjY3LTkuMjQsMi42OS0xNC4wNSwzLjA0di01NS4xaC0zLjc4Yy0yOC4zNi0uMDgtNTEuNDMtMjMuMjEtNTEuNDMtNTEuNTcsMC0xOS4yMywxMC41OS0zNi43MywyNy42NC00NS42OGwtMy41My02LjcyYy0xOS41NSwxMC4yNi0zMS43LDMwLjM0LTMxLjcsNTIuMzksMCwzMS4yNiwyNC40NCw1Ni45OCw1NS4yMSw1OS4wMXY1NS4zN2gzLjc5YzcuMDMsMCwxMy45Mi0xLjIzLDIwLjQ3LTMuNjRaIi8+ICA8cGF0aCBjbGFzcz0iY2xzLTIiIGQ9Ik0yMzAuODgsMjMwLjAxdi01NS4yNGMtMzAuNTcsMC01NS4zNSwyNC43OC01NS4zNSw1NS4zNXMyNC43MSw1NS4yNyw1NS4yMSw1NS4zNXY1NS4yNGMzMC41NywwLDU1LjM1LTI0Ljc4LDU1LjM1LTU1LjM1cy0yNC43MS01NS4yNy01NS4yMS01NS4zNVoiLz4gPC9zdmc+";

// Definir el estilo de la máscara
const maskStyle = {
  WebkitMaskImage: `url("${LOGO_BASE64}")`,
  WebkitMaskSize: 'contain', // Ajustado a "contain" para que el logo de Shift encaje bien verticalmente
  WebkitMaskPosition: 'center',
  WebkitMaskRepeat: 'no-repeat',
  maskImage: `url("${LOGO_BASE64}")`,
  maskSize: 'contain',
  maskPosition: 'center',
  maskRepeat: 'no-repeat',
} as const;

// Configuración de los colores Corporativos de Shift Latam (Core AI Theme)
const GRID_CONFIG = {
  background: {
    color: "#0033A0", // Azul oscuro de fondo (Shift)
    maxOpacity: 0.15,
    flickerChance: 0.12,
    squareSize: 4,
    gridGap: 4,
  },
  logo: {
    color: "#38BDF8", // Celeste eléctrico/tecnológico para el logo brillando
    maxOpacity: 0.75, // Aumenté un poco la opacidad para que el logo resalte más del fondo
    flickerChance: 0.25, // Un poco más activo para que se vea "vivo"
    squareSize: 3,
    gridGap: 5,
  },
} as const;

export const FlickeringGridDemo = () => {
  return (
    // Opacity bajada de 40 → 30 (2026-04-21): el fondo dark ya no compite
    // con un mesh animado, entonces el grid puede sentirse con más aire.
    <div className="absolute inset-0 flex w-full h-screen justify-center items-center overflow-hidden opacity-30 pointer-events-none z-0">
      {/* Fondo parpadeante general (Malla) */}
      <FlickeringGrid
        className="absolute inset-0 z-0 [mask-image:radial-gradient(ellipse_at_center,white_20%,transparent_70%)] motion-safe:animate-pulse"
        {...GRID_CONFIG.background}
      />

      {/* Logo de Shift actuando como máscara del grid frontal brillante */}
      <div
        className="absolute w-[60vh] h-[60vh] z-0 motion-safe:animate-fade-in"
        style={{
          ...maskStyle,
          animation: 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        }}
      >
        <FlickeringGrid {...GRID_CONFIG.logo} width={800} height={800} />
      </div>
    </div>
  );
};
