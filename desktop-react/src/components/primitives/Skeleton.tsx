export function Skeleton({ height = 12 }: { height?: number }) {
  return (
    <div
      style={{
        height,
        width: "100%",
        borderRadius: 8,
        background: "linear-gradient(90deg, #eef2f7 0%, #e3e9f2 50%, #eef2f7 100%)",
        backgroundSize: "200% 100%",
        animation: "pulse 1.4s ease-in-out infinite"
      }}
    />
  );
}

