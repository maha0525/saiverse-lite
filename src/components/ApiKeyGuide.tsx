// API キー取得のステップガイド。データ (apiKeyGuideData.ts) と対で移植可能にしてある。
// 依存は React と lucide-react のみ — SAIVerse 本体の frontend にもこのペアごと持ち込める。
import { CircleAlert, ExternalLink } from "lucide-react";
import type { ApiKeyGuideData } from "../apiKeyGuideData";

export function ApiKeyGuide({ guide }: { guide: ApiKeyGuideData }) {
  return (
    <div className="key-guide">
      <p className="key-guide-cost">{guide.costNote}</p>
      <ol className="guide-steps">
        {guide.steps.map((step, index) => (
          <li className="guide-step" key={step.title}>
            <span className="guide-step-number" aria-hidden="true">{index + 1}</span>
            <div className="guide-step-body">
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
              {step.uiLabel && <span className="guide-ui-label">{step.uiLabel}</span>}
              {step.link && (
                <a className="guide-link" href={step.link.url} target="_blank" rel="noreferrer noopener">
                  {step.link.label}<ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="guide-cautions">
        {guide.cautions.map((caution) => (
          <p key={caution}><CircleAlert size={14} strokeWidth={2} aria-hidden="true" /> {caution}</p>
        ))}
      </div>
      <p className="field-help">画面の文言は各社の更新で多少変わることがあります。キーは {guide.keyPrefixHint} です。</p>
    </div>
  );
}
