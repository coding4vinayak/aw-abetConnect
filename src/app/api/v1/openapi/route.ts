import { NextResponse } from "next/server";
import { openapiSpec } from "@/lib/openapi";

/**
 * GET /api/v1/openapi — the machine-readable contract, unauthenticated.
 *
 * Public on purpose. An integrator decides whether to build against an API before
 * they are allowed to hold a key, and a spec behind auth is a spec nobody reads.
 * It describes the surface; it contains no secrets and no tenant data.
 *
 * `scripts/check-contract.mjs` runs this same object against the source at check
 * time, so what is served here is asserted rather than maintained.
 */
export async function GET() {
  return NextResponse.json(openapiSpec, {
    headers: {
      // The spec changes when the code does; a stale copy is worse than a revalidate.
      "cache-control": "public, max-age=60, s-maxage=300",
    },
  });
}