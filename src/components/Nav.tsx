export type AppView = "chat" | "personas" | "memory" | "data" | "settings";

const ITEMS: Array<{ id: AppView; label: string; mark: string }> = [
  { id: "chat", label: "会話", mark: "話" },
  { id: "personas", label: "パートナー", mark: "人" },
  { id: "memory", label: "記憶", mark: "憶" },
  { id: "data", label: "引っ越し", mark: "移" },
  { id: "settings", label: "設定", mark: "設" },
];

interface NavProps {
  active: AppView;
  onChange(view: AppView): void;
  online: boolean;
}

export function Nav({ active, onChange, online }: NavProps) {
  return (
    <nav className="app-nav" aria-label="メインメニュー">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">九</div>
        <div>
          <strong>SAIVerse Lite</strong>
          <span>ふたりの部屋</span>
        </div>
      </div>
      <div className="nav-items">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            className={active === item.id ? "nav-item active" : "nav-item"}
            onClick={() => onChange(item.id)}
            aria-current={active === item.id ? "page" : undefined}
          >
            <span className="nav-mark" aria-hidden="true">{item.mark}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className={online ? "connection online" : "connection offline"}>
        <span aria-hidden="true" />{online ? "オンライン" : "オフライン"}
      </div>
    </nav>
  );
}
