import { NextResponse } from "next/server";

/**
 * Cross-origin rules for the one endpoint browser code is allowed to call.
 *
 * A website on one origin posting a lead to abetConnect on another is a cross-origin
 * request. Without an OPTIONS answer that names the visitor's exact origin, the
 * browser blocks the POST before it reaches us — and the failure is invisible in
 * server logs, because the request never arrives. This file is why a customer's
 * form can work at all.
 *
 * The echo is deliberately narrow. `access-control-allow-origin: *` on an endpoint
 * that takes credentials would hand every other website on the internet the right
 * to read the response, and `vary: Origin` has to be present even on the refusals:
 * a cache that does not know the answer depends on the origin will serve one
 * customer's CORS headers to the next site that asks.
 */

/** scheme://host[:port], lowercased, path and query stripped. "" if unusable. */
export function normaliseOrigin(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.pathname !== "/" || url.search || url.hash) {
      // "https://acme.com/forms" is a person meaning "acme.com"; the scheme plus
      // host is the whole answer, so a path is stripped rather than refused.
      return url.origin;
    }
    return url.origin;
  } catch {
    return "";
  }
}

/** A stored list ("a.com,b.com") or a UI list, normalised and deduped. */
export function normaliseOrigins(raw: string | string[]): string[] {
  const list = Array.isArray(raw) ? raw : raw.split(",");
  return [...new Set(list.map(normaliseOrigin).filter(Boolean))];
}

/** The request's Origin, but only when this key is configured for it. */
export function matchedOrigin(request: Request, allowed: string): string | null {
  const raw = request.headers.get("origin")?.trim();
  if (!raw) return null;
  const origin = normaliseOrigin(raw);
  return origin && normaliseOrigins(allowed).includes(origin) ? origin : null;
}

export function corsHeaders(request: Request, allowed: string): Record<string, string> {
  const origin = matchedOrigin(request, allowed);
  if (!origin) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/**
 * The preflight answer for an origin we cannot check against a key yet.
 *
 * A browser sends OPTIONS with no Authorization header — it has not been
 * authorised, and it never attaches credentials to a preflight — so there is no
 * allowlist to match at this point. Echoing the origin is safe because a preflight
 * grants nothing: the POST that follows is still fully authenticated, and if its
 * own response lacks a matching allow-origin, no script on another site can read a
 * single byte of it. Revealing method and header names is no secret either; they
 * are in the public OpenAPI document.
 */
export function preflightAny(request: Request): NextResponse {
  const raw = request.headers.get("origin")?.trim();
  const origin = raw ? normaliseOrigin(raw) : "";
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-api-key",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  });
}
