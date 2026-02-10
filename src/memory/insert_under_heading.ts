export type InsertUnderHeadingArgs = {
  markdown: string;
  heading: string;
  insert_lines: string[];
};

export type InsertUnderHeadingResult =
  | { ok: true; markdown: string }
  | { ok: false; error: string };

export function insertUnderHeading(args: InsertUnderHeadingArgs): InsertUnderHeadingResult {
  const lines = args.markdown.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) => l.trimEnd() === args.heading);
  if (headingIdx === -1) {
    return { ok: false, error: `Heading not found: ${args.heading}` };
  }

  // Insert after the heading and one optional blank line (keeps headings readable).
  let insertAt = headingIdx + 1;
  if (lines[insertAt] === "") insertAt += 1;

  const newLines = [
    ...lines.slice(0, insertAt),
    ...args.insert_lines,
    "",
    ...lines.slice(insertAt)
  ];
  return { ok: true, markdown: newLines.join("\n") };
}

