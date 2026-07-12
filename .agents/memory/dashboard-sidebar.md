---
name: Dashboard sidebar architecture
description: How the student dashboard sidebar navigation is implemented
---

## Rule
The dashboard uses **state-based section switching** within a single `/dashboard` route. No URL routing changes.

**Why:** Spec says "Do NOT change routing." A single-page state approach keeps auth/routing untouched while supporting 8 sidebar sections.

## Structure
```tsx
type Section = "ai-teacher" | "home" | "tasks" | "subjects" | "schedule" | "progress" | "library" | "profile";
const [section, setSection] = useState<Section>("home");
```

## My Tasks (key section)
Parallel-fetches ALL lessons from every subject in the schedule:
```tsx
const subjects = [...new Set(schedule.map(s => s.subject))];
Promise.all(subjects.map(subject => fetch(`/api/student/course-lessons?subject=${encodeURIComponent(subject)}`, ...)))
```
Results sorted: active → assigned → completed. Status mapped as student-facing labels (not teacher labels).

## Layout
- Desktop: `lg:translate-x-0 lg:static` sidebar always visible
- Mobile: `fixed` sidebar toggled by hamburger, with overlay dismiss
- Sidebar width: `w-60` (240px)

## Lesson status mapping (student-facing)
- assigned → 🟡 Сpassum е
- active → 🟢 Wnthacqi мej  
- completed → ✅ Ávártvats
