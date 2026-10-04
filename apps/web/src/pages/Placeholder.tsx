export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="stack">
      <h1>{title}</h1>
      <div className="card">
        <p className="muted">این بخش در {phase} ساخته می‌شود.</p>
      </div>
    </div>
  );
}
