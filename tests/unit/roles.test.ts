// Unit tests for the role rules: the one module that answers
// "is this person allowed to do that", directly, without a database.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canEditRole,
  canGrant,
  canManageRoles,
  isInvitableRole,
} from "../../src/lib/roles";

describe("isInvitableRole", () => {
  it("admits admin and member, never owner", () => {
    assert.equal(isInvitableRole("ADMIN"), true);
    assert.equal(isInvitableRole("MEMBER"), true);
    assert.equal(isInvitableRole("OWNER"), false);
    assert.equal(isInvitableRole("BANANA"), false);
  });
});

describe("canManageRoles", () => {
  it("is owners and admins only", () => {
    assert.equal(canManageRoles("OWNER"), true);
    assert.equal(canManageRoles("ADMIN"), true);
    assert.equal(canManageRoles("MEMBER"), false);
    assert.equal(canManageRoles(null), false);
  });
});

describe("canGrant", () => {
  it("lets an owner grant either seat", () => {
    assert.deepEqual(canGrant("OWNER", "ADMIN"), { ok: true });
    assert.deepEqual(canGrant("OWNER", "MEMBER"), { ok: true });
  });
  it("lets an admin grant members but never admins", () => {
    assert.deepEqual(canGrant("ADMIN", "MEMBER"), { ok: true });
    const refused = canGrant("ADMIN", "ADMIN");
    assert.equal(refused.ok, false);
  });
  it("refuses members and owners-as-targets", () => {
    assert.equal(canGrant("MEMBER", "MEMBER").ok, false);
    assert.equal(canGrant("OWNER", "OWNER").ok, false);
  });
});

describe("canEditRole", () => {
  it("lets an owner touch any non-owner seat", () => {
    assert.equal(canEditRole("OWNER", "ADMIN"), true);
    assert.equal(canEditRole("OWNER", "OWNER"), false);
  });
  it("lets an admin touch members only", () => {
    assert.equal(canEditRole("ADMIN", "MEMBER"), true);
    assert.equal(canEditRole("ADMIN", "ADMIN"), false);
    assert.equal(canEditRole("ADMIN", "OWNER"), false);
  });
});
