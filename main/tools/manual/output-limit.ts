/**
 * Budget for a single directly readable manual request.
 *
 * This is a product budget, not a measured runtime maximum: build-time validation can only see
 * statically known manual surfaces, while rtws-specific app/MCP manuals are discovered later.
 * Keep enough headroom for legitimate long-form chapters, but still fail obviously bloated
 * handbook content during build instead of discovering it only at runtime.
 */
export const MANUAL_SINGLE_REQUEST_CHAR_LIMIT = 25_000;
