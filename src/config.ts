/**
 * ShiftAI Embed Configuration
 * 
 * VITE_GATEWAY_URL: URL del Shift AI Gateway (Express server).
 * - Dev local: se usa el proxy de Vite (default: "")
 * - Producción: "https://gateway.shiftpn.com" o la URL que corresponda
 * 
 * Cuando vayas a producción (CPanel), cambia esto en .env.local:
 *   VITE_GATEWAY_URL=https://tu-gateway-url.com
 */
export const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "";
