// Shared student navigation — single source of truth for Dashboard and StudentLayout
export type NavKey =
  | "ai-teacher" | "home" | "tasks" | "subjects" | "homework"
  | "schedule" | "progress" | "library" | "profile" | "quizzes";

export const NAV_ITEMS: { key: NavKey; emoji: string; label: string }[] = [
  { key: "ai-teacher", emoji: "🤖", label: "ԱԲ ուսուցիչ" },
  { key: "home",       emoji: "🏠", label: "Գլխավոր" },
  { key: "tasks",      emoji: "📝", label: "Իմ դասերը" },
  { key: "subjects",   emoji: "📚", label: "Իմ առարկաները" },
  { key: "homework",   emoji: "📋", label: "Իմ տնայինները" },
  { key: "quizzes",   emoji: "📋", label: "Իմ թեստերը" },
  { key: "schedule",   emoji: "📅", label: "Դասացուցակ" },
  { key: "progress",   emoji: "📈", label: "Իմ առաջընթացը" },
  { key: "library",    emoji: "📖", label: "Գրադարան" },
  { key: "profile",    emoji: "👤", label: "Իմ պրոֆիլը" },
];

export function lessonStatusBadge(mySessionStatus: string | null | undefined): { text: string; cls: string } {
  if (mySessionStatus === "completed")
    return { text: "✅ Ավարտված", cls: "bg-teal-400/15 text-teal-400 border-teal-400/20" };
  if (mySessionStatus === "active")
    return { text: "🟢 Ընթացքի մեջ", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" };
  return { text: "🟡 Սպասում է", cls: "bg-amber-400/15 text-amber-400 border-amber-400/20" };
}

