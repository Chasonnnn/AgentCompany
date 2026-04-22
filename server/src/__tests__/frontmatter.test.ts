import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseFrontmatterMarkdown,
  parseYamlFile,
  parseYamlFrontmatter,
} from "../services/frontmatter.js";
import { HttpError } from "../errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const skillsRoot = path.join(repoRoot, "skills");

async function listBundledSkillFiles(): Promise<string[]> {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    const stat = await fs.stat(skillFile).catch(() => null);
    if (stat?.isFile()) out.push(skillFile);
  }
  return out;
}

describe("parseYamlFrontmatter", () => {
  it("returns empty object for empty input", () => {
    expect(parseYamlFrontmatter("")).toEqual({});
    expect(parseYamlFrontmatter("   \n\n")).toEqual({});
  });

  it("parses scalars, arrays, and nested maps with native types", () => {
    const raw = [
      "name: widget",
      "count: 5",
      "ratio: 0.25",
      "enabled: true",
      "disabled: false",
      "tag: ~",
      "tags:",
      "  - alpha",
      "  - beta",
      "metadata:",
      "  owner: team",
      "  nested:",
      "    level: 2",
    ].join("\n");

    expect(parseYamlFrontmatter(raw)).toEqual({
      name: "widget",
      count: 5,
      ratio: 0.25,
      enabled: true,
      disabled: false,
      tag: null,
      tags: ["alpha", "beta"],
      metadata: {
        owner: "team",
        nested: { level: 2 },
      },
    });
  });

  it("preserves folded scalar whitespace", () => {
    const raw = [
      "description: >",
      "  first line",
      "  second line",
    ].join("\n");
    expect(parseYamlFrontmatter(raw)).toEqual({
      description: "first line second line\n",
    });
  });

  it("returns empty object when the top-level value is not a map", () => {
    expect(parseYamlFrontmatter("- one\n- two\n")).toEqual({});
    expect(parseYamlFrontmatter('"just a string"\n')).toEqual({});
  });

  it("throws a 422 unprocessable error with a clean message for invalid YAML", () => {
    expect.assertions(3);
    try {
      parseYamlFrontmatter('name: "unclosed\n');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).message).toMatch(/^Invalid YAML frontmatter: /);
    }
  });

  it("uses the caller-supplied errorLabel for context in error messages", () => {
    expect.assertions(2);
    try {
      parseYamlFrontmatter("foo: [unterminated", { errorLabel: "SKILL.md frontmatter" });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).toMatch(/^Invalid SKILL.md frontmatter: /);
    }
  });

  it("rejects explicit YAML type tags that js-yaml's default schema does not support", () => {
    const raw = 'attack: !!js/function "function () { return 42; }"\n';
    expect(() => parseYamlFrontmatter(raw)).toThrow(HttpError);
    try {
      parseYamlFrontmatter(raw);
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      expect((err as HttpError).message).toMatch(/^Invalid YAML frontmatter: /);
    }
  });
});

describe("parseYamlFile", () => {
  it("parses a standalone YAML document", () => {
    const raw = [
      "agents:",
      "  alice:",
      "    role: planner",
      "projects:",
      "  onboarding:",
      "    active: true",
    ].join("\n");
    expect(parseYamlFile(raw)).toEqual({
      agents: { alice: { role: planner_value() } },
      projects: { onboarding: { active: true } },
    });
  });

  it("reports the file context in error messages by default", () => {
    expect.assertions(2);
    try {
      parseYamlFile('broken: [\n');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).toMatch(/^Invalid YAML file: /);
    }
  });
});

function planner_value() {
  return "planner";
}

describe("parseFrontmatterMarkdown", () => {
  it("returns empty frontmatter + trimmed body when the document has no leading ---", () => {
    const raw = "# Title\n\nBody text.\n";
    expect(parseFrontmatterMarkdown(raw)).toEqual({
      frontmatter: {},
      body: "# Title\n\nBody text.",
    });
  });

  it("splits frontmatter from body and trims both sides", () => {
    const raw = [
      "---",
      "name: widget",
      "enabled: true",
      "---",
      "",
      "# Widget",
      "",
      "Hello.",
      "",
    ].join("\n");
    const parsed = parseFrontmatterMarkdown(raw);
    expect(parsed.frontmatter).toEqual({ name: "widget", enabled: true });
    expect(parsed.body).toBe("# Widget\n\nHello.");
  });

  it("normalizes CRLF line endings before splitting the frontmatter block", () => {
    const raw = ["---", "name: widget", "---", "", "Body."].join("\r\n");
    const parsed = parseFrontmatterMarkdown(raw);
    expect(parsed.frontmatter).toEqual({ name: "widget" });
    expect(parsed.body).toBe("Body.");
  });

  it("treats a '---' separator inside the body as part of the body, not a second frontmatter block", () => {
    const raw = [
      "---",
      "name: widget",
      "---",
      "",
      "# Heading",
      "",
      "Before.",
      "",
      "---",
      "",
      "After the horizontal rule.",
      "",
    ].join("\n");
    const parsed = parseFrontmatterMarkdown(raw);
    expect(parsed.frontmatter).toEqual({ name: "widget" });
    expect(parsed.body).toBe("# Heading\n\nBefore.\n\n---\n\nAfter the horizontal rule.");
  });

  it("returns empty frontmatter when the closing --- fence is missing", () => {
    const raw = "---\nname: widget\n\n# Body without closing fence\n";
    const parsed = parseFrontmatterMarkdown(raw);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe(raw.trim());
  });

  it("surfaces the caller's errorLabel when the frontmatter block is malformed", () => {
    const raw = '---\nname: "unterminated\n---\n\nBody.\n';
    expect.assertions(2);
    try {
      parseFrontmatterMarkdown(raw, { errorLabel: "SKILL.md frontmatter" });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).message).toMatch(/^Invalid SKILL.md frontmatter: /);
    }
  });
});

describe("parseFrontmatterMarkdown golden-file coverage for bundled skills", () => {
  it("parses every SKILL.md under skills/ into a plain object with name and description", async () => {
    const skillFiles = await listBundledSkillFiles();
    expect(skillFiles.length).toBeGreaterThan(0);

    for (const skillFile of skillFiles) {
      const markdown = await fs.readFile(skillFile, "utf8");
      const parsed = parseFrontmatterMarkdown(markdown, { errorLabel: "SKILL.md frontmatter" });

      expect(
        parsed.frontmatter,
        `frontmatter for ${skillFile} should be a plain record`,
      ).toBeTypeOf("object");
      expect(Array.isArray(parsed.frontmatter)).toBe(false);
      expect(typeof parsed.frontmatter.name).toBe("string");
      expect(typeof parsed.frontmatter.description).toBe("string");
      expect(parsed.body.length).toBeGreaterThan(0);
    }
  });
});
