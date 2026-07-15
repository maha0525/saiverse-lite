import { Brain, MessageCircle, Settings, Truck, Users, type LucideIcon } from "lucide-react";
import logoUrl from "../assets/logo.png";

export type AppView = "chat" | "personas" | "memory" | "data" | "settings";

const ITEMS: Array<{ id: AppView; label: string; icon: LucideIcon }> = [
  { id: "chat", label: "会話", icon: MessageCircle },
  { id: "personas", label: "パートナー", icon: Users },
  { id: "memory", label: "記憶", icon: Brain },
  { id: "data", label: "引っ越し", icon: Truck },
  { id: "settings", label: "設定", icon: Settings },
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
        <div className="brand-mark" aria-hidden="true"><img src={logoUrl} alt="" /></div>
        <div>
          <strong>SAIVerse Lite</strong>
          <span>ふたりの部屋</span>
        </div>
      </div>
      <div className="nav-items">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={active === item.id ? "nav-item active" : "nav-item"}
              onClick={() => onChange(item.id)}
              aria-current={active === item.id ? "page" : undefined}
            >
              <span className="nav-mark" aria-hidden="true"><Icon size={20} strokeWidth={1.8} /></span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className={online ? "connection online" : "connection offline"}>
        <span aria-hidden="true" />{online ? "オンライン" : "オフライン"}
      </div>
    </nav>
  );
}
