export function buildCliCommandLabel(): string {
  const args = process.argv.slice(2);
  return args.length > 0 ? `agentcompany ${args.join(" ")}` : "agentcompany";
}
