import type { ReactNode } from "react";

type Props = {
  active?: boolean;
  onClick?: () => void;
  left: ReactNode;
  right?: ReactNode;
};

export function ListRow({ active = false, onClick, left, right }: Props) {
  return (
    <button type="button" className={`list-row ${active ? "active" : ""}`} onClick={onClick}>
      <span>{left}</span>
      {right ?? null}
    </button>
  );
}

