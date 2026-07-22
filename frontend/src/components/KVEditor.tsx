import type { KV } from '../types';

export default function KVEditor({
  items, onChange, keyPlaceholder = 'key', valuePlaceholder = 'value',
}: {
  items: KV[];
  onChange: (items: KV[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const update = (i: number, patch: Partial<KV>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div>
      {items.map((kv, i) => (
        <div className="kv-row" key={i}>
          <input type="checkbox" checked={kv.enabled} title="Include this entry" onChange={(e) => update(i, { enabled: e.target.checked })} />
          <input type="text" value={kv.key} placeholder={keyPlaceholder} onChange={(e) => update(i, { key: e.target.value })} />
          <input type="text" value={kv.value} placeholder={valuePlaceholder} onChange={(e) => update(i, { value: e.target.value })} />
          <button className="btn icon danger" title="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...items, { key: '', value: '', enabled: true }])}>+ Add</button>
    </div>
  );
}
