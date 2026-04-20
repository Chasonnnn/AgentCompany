import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueDecisionQuestions, issues } from "@paperclipai/db";
import type { CreateIssueDecisionQuestion } from "@paperclipai/shared";

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripInlineMarkdown(input: string) {
  return input
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTrailingInstruction(input: string) {
  return input
    .replace(/\s+Reply in any form[\s\S]*$/i, "")
    .replace(/\s+I(?:'|’)ll lock scope[\s\S]*$/i, "")
    .trim();
}

function parseNumberedOptions(sectionKey: string, input: string) {
  const compact = cleanTrailingInstruction(input).replace(/\s+/g, " ").trim();
  if (!compact) return [];

  const chunks = compact
    .split(/\s(?=\d+\.\s+)/)
    .map((chunk) => chunk.replace(/^\d+\.\s+/, "").trim())
    .map((chunk) => cleanTrailingInstruction(chunk))
    .filter(Boolean);

  const seenKeys = new Set<string>();

  return chunks.flatMap((chunk, index) => {
    const separatorMatch = chunk.match(/\s+[—-]\s+/);
    const separatorIndex = separatorMatch?.index ?? -1;
    const labelPart = separatorIndex >= 0 ? chunk.slice(0, separatorIndex) : chunk;
    const descriptionPart = separatorIndex >= 0 ? chunk.slice(separatorIndex + separatorMatch![0].length) : "";
    const label = stripInlineMarkdown(labelPart).replace(/[:.]\s*$/, "").trim();
    const description = stripInlineMarkdown(descriptionPart).trim() || null;
    if (!label) return [];

    let key = `${sectionKey.toLowerCase()}-${slugify(label) || `option-${index + 1}`}`;
    while (seenKeys.has(key)) key = `${key}-${index + 1}`;
    seenKeys.add(key);

    return [{
      key,
      label,
      ...(description ? { description } : {}),
    }];
  });
}

function buildBundledQuestionTitlePrefix(title: string) {
  const cleaned = title
    .replace(/\(re-asked\)/gi, "")
    .replace(/:\s*.*open decisions?.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || title.trim();
}

export function splitBundledDecisionQuestionInput(input: CreateIssueDecisionQuestion): CreateIssueDecisionQuestion[] | null {
  if (Array.isArray(input.recommendedOptions) && input.recommendedOptions.length > 0) {
    return null;
  }

  const question = input.question.replace(/\r/g, "").trim();
  if (!question) return null;

  const headingRe = /(?:\*\*)?Decision\s+([A-Z0-9]+)\s*[—-]\s*/gi;
  const headings = Array.from(question.matchAll(headingRe));
  if (headings.length < 2) return null;

  const intro = stripInlineMarkdown(
    question
      .slice(0, headings[0]?.index ?? 0)
      .replace(/\s+/g, " ")
      .replace(/Three picks bundled below\.?$/i, "")
      .trim(),
  );
  const sharedWhyBlocked = [input.whyBlocked?.trim() || "", intro].filter(Boolean).join(" ").trim() || null;
  const titlePrefix = buildBundledQuestionTitlePrefix(input.title);

  const sections = headings.flatMap((heading, index) => {
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? question.length;
    const sectionText = question.slice(start, end).trim();
    const withoutHeading = sectionText.replace(/^(?:\*\*)?Decision\s+[A-Z0-9]+\s*[—-]\s*/i, "").trim();
    const optionMarkerIndex = withoutHeading.search(/(?:^|\s)1\.\s+/);
    if (optionMarkerIndex < 0) return [];

    const labelRaw = withoutHeading.slice(0, optionMarkerIndex).trim();
    const label = stripInlineMarkdown(
      labelRaw
        .replace(/\bPick one:?$/i, "")
        .trim(),
    )
      .replace(/[.:]+\s*$/, "")
      .trim();
    if (!label) return [];

    const options = parseNumberedOptions(heading[1] ?? `decision-${index + 1}`, withoutHeading.slice(optionMarkerIndex));
    if (options.length === 0) return [];

    return [{
      title: titlePrefix && titlePrefix !== input.title.trim() ? `${titlePrefix}: ${label}` : label,
      question: `Which option should we choose for ${label}?`,
      whyBlocked: sharedWhyBlocked,
      blocking: input.blocking,
      recommendedOptions: options,
      suggestedDefault: null,
      linkedApprovalId: input.linkedApprovalId ?? null,
    } satisfies CreateIssueDecisionQuestion];
  });

  return sections.length >= 2 ? sections : null;
}

export async function normalizeBundledOpenDecisionQuestions(
  db: Db,
  filters: { issueId?: string; companyId?: string },
) {
  const rows = await db
    .select()
    .from(issueDecisionQuestions)
    .where(
      and(
        eq(issueDecisionQuestions.status, "open"),
        ...(filters.issueId ? [eq(issueDecisionQuestions.issueId, filters.issueId)] : []),
        ...(filters.companyId ? [eq(issueDecisionQuestions.companyId, filters.companyId)] : []),
      ),
    );

  for (const row of rows) {
    const splitQuestions = splitBundledDecisionQuestionInput({
      title: row.title,
      question: row.question,
      whyBlocked: row.whyBlocked ?? null,
      blocking: row.blocking,
      recommendedOptions: Array.isArray(row.recommendedOptions) ? row.recommendedOptions as CreateIssueDecisionQuestion["recommendedOptions"] : [],
      suggestedDefault: row.suggestedDefault ?? null,
      linkedApprovalId: row.linkedApprovalId ?? null,
    });
    if (!splitQuestions) continue;

    const now = new Date();
    await db.transaction(async (tx) => {
      const dismissed = await tx
        .update(issueDecisionQuestions)
        .set({
          status: "dismissed",
          answer: {
            answer: `Automatically split into ${splitQuestions.length} structured decision questions.`,
            note: `Automatically split into ${splitQuestions.length} structured decision questions.`,
          },
          answeredAt: now,
          updatedAt: now,
        })
        .where(and(eq(issueDecisionQuestions.id, row.id), eq(issueDecisionQuestions.status, "open")))
        .returning()
        .then((updatedRows) => updatedRows[0] ?? null);

      if (!dismissed) return;

      await tx.insert(issueDecisionQuestions).values(
        splitQuestions.map((questionInput) => ({
          companyId: row.companyId,
          issueId: row.issueId,
          target: row.target,
          requestedByAgentId: row.requestedByAgentId,
          requestedByUserId: row.requestedByUserId,
          status: "open",
          blocking: questionInput.blocking ?? true,
          title: questionInput.title,
          question: questionInput.question,
          whyBlocked: questionInput.whyBlocked ?? null,
          recommendedOptions: questionInput.recommendedOptions ?? [],
          suggestedDefault: questionInput.suggestedDefault ?? null,
          linkedApprovalId: questionInput.linkedApprovalId ?? row.linkedApprovalId ?? null,
          updatedAt: now,
        })),
      );

      await tx.update(issues).set({ updatedAt: now }).where(eq(issues.id, row.issueId));
    });
  }
}
