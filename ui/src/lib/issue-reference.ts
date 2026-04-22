import {
  buildIssueReferenceHref,
  findIssueReferenceMatches,
  normalizeIssueIdentifier,
  parseIssueReferenceHref,
} from "@paperclipai/shared";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

export function parseIssuePathIdFromPath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  return parseIssueReferenceHref(pathOrUrl)?.identifier ?? null;
}

export function parseIssueReferenceFromHref(href: string | null | undefined) {
  if (!href) return null;
  const trimmed = href.trim();
  const identifier =
    parseIssueReferenceHref(trimmed)?.identifier
    ?? normalizeIssueIdentifier(trimmed)
    ?? null;
  if (!identifier) return null;
  return {
    issuePathId: identifier,
    href: buildIssueReferenceHref(identifier),
  };
}

function createIssueLinkNode(value: string, href: string, childType: "text" | "inlineCode" = "text"): MarkdownNode {
  return {
    type: "link",
    url: href,
    children: [{ type: childType, value }],
  };
}

function linkifyIssueReferencesInText(value: string): MarkdownNode[] | null {
  const matches = findIssueReferenceMatches(value);
  if (matches.length === 0) return null;

  const nodes: MarkdownNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    const start = match.index;
    const end = start + match.length;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(createIssueLinkNode(match.matchedText, buildIssueReferenceHref(match.identifier)));
    cursor = end;
  }

  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const issueRef = parseIssueReferenceFromHref(child.value);
      if (issueRef) {
        nextChildren.push(createIssueLinkNode(child.value, issueRef.href, "inlineCode"));
        continue;
      }
    }

    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyIssueReferencesInText(child.value);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }

    rewriteMarkdownTree(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkLinkIssueReferences() {
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree);
  };
}
