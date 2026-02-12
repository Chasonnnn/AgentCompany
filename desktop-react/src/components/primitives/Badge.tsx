import type { ReactNode } from "react";

type Props = {
  tone?: "default" | "warn" | "danger";
  children: ReactNode;
};

export function Badge({ tone = "default", children }: Props) {
  return <span className={`badge ${tone === "default" ? "" : tone}`.trim()}>{children}</span>;
}

