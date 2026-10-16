import { useEffect, useRef, useState } from "react";

type Job = { status?: string; progress?: string | null; error?: string | null };
type Quality = { status?: string; blockingCodes?: string[]; reviewCodes?: string[] };
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** One teacher action, existing server routes, no automatic final approval.
 * Stop on partial C1 / failed job; never start C2 on unverified C1 persistence.
 */
export function UnifiedLessonMapButton({
  lessonId, token, hasExistingMap, onRefresh,
}: {
  lessonId: number;
  token: string | null | undefined;
  hasExistingMap: boolean;
  onRefresh: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);
  const runningRef = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  async function request(path: string, method: "GET" | "POST" = "GET") {
    if (cancelled.current) throw new Error("Գործողությունն ընդհատվել է։");
    const response = await fetch(`/api/lessons/${lessonId}/${path}`, {
      method, headers: { Authorization: `Bearer ${token ?? ""}` },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async function untilDone(path: string, label: string): Promise<Job> {
    for (let attempt = 0; attempt < 240; attempt++) {
      const job = await request(path) as Job;
      setMessage(`${label} · ${job.progress ?? job.status ?? "սպասում"}`);
      if (job.status === "completed") return job;
      if (job.status === "failed" || job.status === "coverage_failed") {
        throw new Error(`${label}: ${job.error ?? "Պահանջվում է աղբյուրների վերանայում"}`);
      }
      if (job.status !== "pending" && job.status !== "running") {
        throw new Error(`${label}: անսպասելի կարգավիճակ՝ ${job.status ?? "անհայտ"}`);
      }
      await wait(3000);
      if (cancelled.current) throw new Error("Գործողությունն ընդհատվել է։");
    }
    throw new Error(`${label}: ժամանակի սահմանաչափը լրացել է։ Ստուգեք պահպանված աշխատանքի կարգավիճակը։`);
  }
  async function run() {
    if (runningRef.current || !token || hasExistingMap) return;
    runningRef.current = true;
    setRunning(true);
    setMessage("Սկսվում է C1 քարտեզագրումը…");
    try {
      await request("map", "POST");
      await untilDone("map-status", "C1");
      onRefresh();
      setMessage("Ստեղծվում են C2 ճանաչողական ուղիները…");
      const c2 = await request("generate-cognitive-paths", "POST");
      if (c2.status !== "completed") throw new Error("C2 ստեղծումը չի ավարտվել");
      setMessage("Ստեղծվում է մեթոդական բովանդակությունը…");
      await request("generate-teaching-content", "POST");
      await untilDone("generate-status", "Մեթոդական փաթեթ");
      onRefresh();
      setMessage("Ստուգվում է ամբողջական քարտեզը…");
      const quality = await request("unified-quality-readiness") as Quality;
      if (quality.status === "QUALITY_READY") {
        setMessage("Քարտեզն ամբողջական է ըստ ավտոմատ ստուգումների։ Պահանջվում է ուսուցչի հաստատում։");
      } else if (quality.status === "TEACHER_REVIEW_REQUIRED") {
        setMessage(`Քարտեզը ստեղծված է․ պահանջվում է ուսուցչի վերանայում (${(quality.reviewCodes ?? []).join(", ")})։`);
      } else {
        setMessage(`Քարտեզը ստեղծված է, սակայն կան բացեր՝ ${(quality.blockingCodes ?? []).join(", ") || "ստուգման խնդիր"}։ Հաստատում չի կատարվել։`);
      }
    } catch (error) {
      setMessage(`Գործընթացը կանգ է առել․ ${error instanceof Error ? error.message : "անհայտ սխալ"}։ Արդեն ստեղծված տվյալները չեն ջնջվել։`);
    } finally {
      runningRef.current = false;
      if (!cancelled.current) setRunning(false);
      onRefresh();
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        onClick={() => void run()}
        disabled={!token || running || hasExistingMap}
        title={hasExistingMap ? "Դասի քարտեզն արդեն գոյություն ունի․ վերաքարտեզագրումը պահանջում է առանձին հաստատում" : "C1 → C2 → մեթոդական փաթեթ → որակի ստուգում"}
        className="rounded-lg border border-indigo-400/40 bg-indigo-500/15 px-2.5 py-1 text-xs text-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running ? "⏳ Քարտեզագրում…" : "✨ Միասնական քարտեզագրում"}
      </button>
      {message && <p role="status" className="max-w-xs text-[10px] leading-relaxed text-amber-200">{message}</p>}
    </div>
  );
}
