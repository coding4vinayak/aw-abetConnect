// The export's filename is the one part of the download that becomes an HTTP
// header. These tests pin the two things that matter: the date is the UTC day
// the buyer took the file, and a hostile slug cannot add a header of its own.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workspaceExportFilename } from "../../src/lib/export";

const day = new Date("2026-10-20T23:59:59.000Z");

describe("workspaceExportFilename", () => {
  it("names the product, the workspace and the UTC day", () => {
    assert.equal(
      workspaceExportFilename("acme-leads", day),
      "abetconnect-acme-leads-2026-10-20.json",
    );
  });

  it("treats a slug as text, not as a path or a header", () => {
    const name = workspaceExportFilename('../Acme "North"\r\nSet-Cookie: a=b', day);
    assert.equal(name, "abetconnect-acme-north-set-cookie-a-b-2026-10-20.json");
    assert.ok(!name.includes("/"));
    assert.ok(!name.includes('"'));
    assert.ok(!name.includes("\r"));
    assert.ok(!name.includes("\n"));
  });

  it("keeps a filename even when the slug is empty or only punctuation", () => {
    assert.equal(workspaceExportFilename("", day), "abetconnect-workspace-2026-10-20.json");
    assert.equal(workspaceExportFilename("!!!", day), "abetconnect-workspace-2026-10-20.json");
  });

  it("uses the date it is given, not the clock at call time", () => {
    assert.match(workspaceExportFilename("acme", new Date("2027-01-02T00:00:00Z")), /-2027-01-02\.json$/);
  });
});
