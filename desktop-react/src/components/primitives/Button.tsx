import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "primary" | "ghost";
  iconOnly?: boolean;
  children: ReactNode;
};

export function Button({ tone = "default", iconOnly = false, className = "", children, ...rest }: Props) {
  const toneClass = tone === "primary" ? "primary" : tone === "ghost" ? "ghost" : "";
  return (
    <button className={`btn ${toneClass} ${iconOnly ? "icon" : ""} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}

