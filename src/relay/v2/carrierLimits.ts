/**
 * Fixed production resource ceiling shared by the Broker route authority and
 * Host carrier admission. Configuration may lower it, never raise it.
 */
export const RELAY_V2_CARRIER_ROUTE_HARD_LIMIT = 256;
export const RELAY_V2_CARRIER_ROUTE_IDENTITY_HARD_LIMIT = 4_096;
