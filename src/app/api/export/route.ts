import { NextResponse } from "next/server";
import { apiError } from "@/lib/api";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";
import { buildWorkspaceExport, workspaceExportFilename } from "@/lib/export";

export const dynamic = "force-dynamic";

/**
 * GET /api/export — the buyer's copy of the workspace, as one JSON file.
 *
 * Session-gated like the pages, not API-key-gated: the export contains every
 * contact and conversation in the workspace, and it is a data-rights door for
 * the people who own the account, not a machine integration. Owners and admins
 * may take it; a member can read the queue but cannot walk away with the whole
 * workspace in one request.
 *
 * The filename is built from the workspace slug (already constrained by signup)
 * and sanitised again here, so a slug can never become a header injection. The
 * response is `no-store` — an export sits in the browser's download list
 * already, and must not be cached by a shared proxy.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return apiError("authentication_error", 401, "Sign in required.");
  }
  if (!canManageRoles(session.role)) {
    return apiError("permission_error", 403, "Only an owner or admin can export the workspace.");
  }

  try {
    const data = await buildWorkspaceExport(session.workspaceId);
    const filename = workspaceExportFilename(data.workspace.slug);
    return new NextResponse(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[export] workspace export failed:", err);
    return apiError("internal_error", 500, "Could not build the workspace export.");
  }
}
