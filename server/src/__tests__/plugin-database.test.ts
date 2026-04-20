import { describe, expect, it } from "vitest";
import {
  derivePluginDatabaseNamespace,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";

describe("plugin-database guards", () => {
  it("derives a stable bounded namespace", () => {
    const namespace = derivePluginDatabaseNamespace("acme.workflow-plugin", "workflow");
    expect(namespace).toMatch(/^plugin_workflow_[a-f0-9]+$/);
    expect(namespace.length).toBeLessThanOrEqual(63);
    expect(derivePluginDatabaseNamespace("acme.workflow-plugin", "workflow")).toBe(namespace);
  });

  it("allows migration statements in the plugin namespace", () => {
    expect(() =>
      validatePluginMigrationStatement(
        'create table plugin_workflow_deadbeef.jobs (id uuid primary key)',
        "plugin_workflow_deadbeef",
      ),
    ).not.toThrow();
  });

  it("rejects migration references to non-whitelisted public tables", () => {
    expect(() =>
      validatePluginMigrationStatement(
        'create view plugin_workflow_deadbeef.v as select * from public.issue_comments',
        "plugin_workflow_deadbeef",
        ["issues"],
      ),
    ).toThrow(/not whitelisted/);
  });

  it("allows runtime select from plugin namespace and whitelisted public tables", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "select p.id, i.title from plugin_workflow_deadbeef.jobs p join public.issues i on i.id = p.issue_id",
        "plugin_workflow_deadbeef",
        ["issues"],
      ),
    ).not.toThrow();
  });

  it("rejects runtime execute outside the plugin namespace", () => {
    expect(() =>
      validatePluginRuntimeExecute(
        "update public.issues set title = 'bad'",
        "plugin_workflow_deadbeef",
      ),
    ).toThrow(/target must be inside plugin namespace/);
  });
});
