export function ProjectStatusBadge({
  name,
  color,
}: {
  name: string;
  color: string;
}) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {name}
    </span>
  );
}
