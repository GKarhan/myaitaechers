export type CognitiveLevelFormValue = {
  cognitiveLevel: string;
  performanceObjective: string;
  successCriterion: string;
  minimumIndependentEvidence: number;
  preferredInteractionTypes: string[];
};

type Props = {
  value: CognitiveLevelFormValue;
  onChange: (patch: Partial<CognitiveLevelFormValue>) => void;
  fieldCls: string;
  excludedLevels?: string[];
};

const LEVELS = [
  ["remember", "Հիշել"],
  ["understand", "Հասկանալ"],
  ["apply", "Կիրառել"],
  ["analyze", "Վերլուծել"],
  ["evaluate", "Գնահատել"],
  ["create", "Ստեղծել"],
] as const;

const INTERACTIONS = [
  ["multiple_choice", "Բազմակի ընտրություն"],
  ["multi_select", "Բազմակի ընտրություն (մի քանի ճիշտ պատասխան)"],
  ["true_false", "Ճիշտ / Սխալ"],
  ["matching", "Համապատասխանեցում"],
  ["classification", "Դասակարգում"],
  ["ordering", "Հերթականության դասավորում"],
  ["numeric_answer", "Թվային պատասխան"],
  ["short_answer", "Կարճ պատասխան"],
  ["constructed_response", "Ընդարձակ պատասխան"],
  ["problem_solving", "Խնդրի լուծում"],
] as const;

export default function CognitiveLevelForm({ value, onChange, fieldCls, excludedLevels = [] }: Props) {
  return (
    <div className="space-y-1.5">
      <select
        className={`${fieldCls} text-[10px]`}
        value={value.cognitiveLevel}
        onChange={(event) => onChange({ cognitiveLevel: event.target.value })}
      >
        <option value="">-- Ուսումնական մակարդակ --</option>
        {LEVELS
          .filter(([key]) => !excludedLevels.includes(key) || key === value.cognitiveLevel)
          .map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <textarea
        className={`${fieldCls} resize-none text-[10px]`}
        rows={2}
        placeholder="Կատարողական նպատակ (Armenian)..."
        value={value.performanceObjective}
        onChange={(event) => onChange({ performanceObjective: event.target.value })}
      />
      <textarea
        className={`${fieldCls} resize-none text-[10px]`}
        rows={2}
        placeholder="Հաջողության չափանիշ (Armenian)..."
        value={value.successCriterion}
        onChange={(event) => onChange({ successCriterion: event.target.value })}
      />
      <div className="flex items-center gap-2">
        <label className="text-[9px] text-white/50">Պահանջվող անկախ ապացույցներ</label>
        <input
          type="number"
          min={1}
          className={`${fieldCls} w-16 text-[10px]`}
          value={value.minimumIndependentEvidence}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            onChange({ minimumIndependentEvidence: Number.isInteger(parsed) && parsed > 0 ? parsed : 1 });
          }}
        />
      </div>
      <div>
        <p className="text-[9px] text-white/50 mb-1">Նախընտրելի պատասխանների տեսակներ</p>
        <div className="flex flex-wrap gap-1">
          {INTERACTIONS.map(([key, label]) => {
            const checked = value.preferredInteractionTypes.includes(key);
            return (
              <button
                type="button"
                key={key}
                onClick={() => onChange({
                  preferredInteractionTypes: checked
                    ? value.preferredInteractionTypes.filter((item) => item !== key)
                    : [...value.preferredInteractionTypes, key],
                })}
                className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                  checked ? "bg-indigo-500/40 text-indigo-200" : "bg-white/8 text-white/40 hover:bg-white/15"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}