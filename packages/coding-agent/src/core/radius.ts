import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@anvaya.sh/padma-ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "PADMA_RADIUS_GATEWAY";
/** MCP endpoint of the gateway the built-in Radius provider signs in to. */
export const RADIUS_MCP_URL = `${normalizeRadiusGatewayUrl(DEFAULT_RADIUS_GATEWAY)}/mcp`;

/** Radius gateway origin, honoring the `PADMA_RADIUS_GATEWAY` override. */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}
