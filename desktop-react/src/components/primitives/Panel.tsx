import type { ReactNode } from "react";

type Props = {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function Panel({ title, actions, children }: Props) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-header hstack" style={{ justifyContent: "space-between" }}>
          {title ? <h4>{title}</h4> : <span />}
          {actions ?? null}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

