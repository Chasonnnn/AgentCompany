export function ErrorState({ message }: { message: string }) {
  return (
    <div className="empty-state">
      <div className="error">Unable to load data</div>
      <div className="muted" style={{ marginTop: 8 }}>
        {message}
      </div>
    </div>
  );
}

