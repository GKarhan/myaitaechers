import { customFetch } from "@workspace/api-client-react";
import { useEffect, useRef, useState } from "react";

type Job = { status?: string; progress?: string | null; error?: string | null };
type Resume = {
  action:
    | "WAIT"
    | "REVIEW"
    | "START_C1"
    | "START_C2"
    | "START_TEACHING"
    | "QUALITY_CHECK";
  reason: string;
  activeJobs: {
    jobId: number;
    updatedAt: string;
    recoverable: boolean;
    progress: string | null;
  }[];
  snapshot: { hasCanonicalNodes: boolean };
};
type Quality = {
  status?: string;
  blockingCodes?: string[];
  reviewCodes?: string[];
};
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One teacher action, existing server routes, no automatic final approval.
 * Stop on partial C1 / failed job; never start C2 on unverified C1 persistence.
 */
export function UnifiedLessonMapButton({
  lessonId,
  token,
  hasExistingMap,
  onRefresh,
}: {
  lessonId: number;
  token: string | null | undefined;
  hasExistingMap: boolean;
  onRefresh: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const [message, setMessage] = useState("");
  const [resume, setResume] = useState<Resume | null>(null);
  const cancelled = useRef(false);
  const runningRef = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    let disposed = false;
    let observeActive = false;
    const refresh = async () => {
      try {
        const state = await customFetch<Resume>(
          `/api/lessons/${lessonId}/unified-resume-state`,
        );
        if (!disposed) {
          observeActive = state.action === "WAIT";
          setResume(state);
        }
      } catch {
        if (!disposed) setResume(null);
      }
    };
    if (token) void refresh();
    const timer = setInterval(() => {
      if (token && observeActive && !runningRef.current) void refresh();
    }, 5000);
    return () => {
      disposed = true;
      cancelled.current = true;
      clearInterval(timer);
    };
  }, [lessonId, token]);

  async function recover() {
    const job = resume?.activeJobs.find((j) => j.recoverable);
    if (!job || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      await customFetch(`/api/lessons/${lessonId}/recover-mapping-job`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
        body: JSON.stringify({
          jobId: job.jobId,
          observedUpdatedAt: job.updatedAt,
          confirmed: true,
        }),
      });
      setResume((await request("unified-resume-state")) as Resume);
      setMessage("");
      setConfirmRecovery(false);
      onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "անհայտ սխալ");
    } finally {
      runningRef.current = false;
      if (!cancelled.current) setRunning(false);
    }
  }
  async function request(path: string, method: "GET" | "POST" = "GET") {
    if (cancelled.current) throw new Error("Գործողությունն ընդհատվել է։");
    return customFetch<any>(`/api/lessons/${lessonId}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token ?? ""}` },
    });
  }
  async function untilDone(path: string, label: string): Promise<Job> {
    for (let attempt = 0; attempt < 240; attempt++) {
      const job = (await request(path)) as Job;
      setMessage(`${label} · ${job.progress ?? job.status ?? "սպասում"}`);
      if (job.status === "completed") return job;
      if (job.status === "failed" || job.status === "coverage_failed") {
        throw new Error(
          `${label}: ${job.error ?? "Պահանջվում է աղբյուրների վերանայում"}`,
        );
      }
      if (job.status !== "pending" && job.status !== "running") {
        throw new Error(
          `${label}: անսպասելի կարգավիճակ՝ ${job.status ?? "անհայտ"}`,
        );
      }
      await wait(3000);
      if (cancelled.current) throw new Error("Գործողությունն ընդհատվել է։");
    }
    throw new Error(
      `${label}: ժամանակի սահմանաչափը լրացել է։ Ստուգեք պահպանված աշխատանքի կարգավիճակը։`,
    );
  }
  async function run() {
    if (runningRef.current || !token) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const attempted = new Set<string>();
      let waits = 0;
      for (let step = 0; step < 8; step++) {
        const state = (await request("unified-resume-state")) as Resume;
        setResume(state);
        if (state.action === "REVIEW") throw new Error(state.reason);
        if (state.action === "QUALITY_CHECK") break;
        if (state.action === "WAIT") {
          setMessage(state.reason);
          await wait(3000);
          if (++waits >= 240) throw new Error(state.reason);
          step--;
          continue;
        }
        if (attempted.has(state.action))
          throw new Error("TEACHER_REVIEW_REQUIRED");
        attempted.add(state.action);
        try {
          if (state.action === "START_C1") {
            setMessage("Սկսվում է C1 քարտեզագրումը…");
            await request("map", "POST");
            await untilDone("map-status", "C1");
          } else if (state.action === "START_C2") {
            setMessage("Ստեղծվում են C2 ճանաչողական ուղիները…");
            const c2 = await request("generate-cognitive-paths", "POST");
            if (c2.status !== "completed")
              throw new Error("C2 ստեղծումը չի ավարտվել");
          } else {
            setMessage("Ստեղծվում է մեթոդական բովանդակությունը…");
            await request("generate-teaching-content", "POST");
            await untilDone("generate-status", "C2 / Teaching Package");
          }
        } catch (error) {
          // Another tab may have claimed the stage after our snapshot.
          const current = (await request("unified-resume-state")) as Resume;
          if (current.action !== "WAIT") throw error;
          attempted.delete(state.action);
        }
        onRefresh();
        if (step === 7) throw new Error("TEACHER_REVIEW_REQUIRED");
      }
      onRefresh();
      setMessage("Ստուգվում է ամբողջական քարտեզը…");
      const quality = (await request("unified-quality-readiness")) as Quality;
      if (quality.status === "QUALITY_READY") {
        setMessage(
          "Քարտեզն ամբողջական է ըստ ավտոմատ ստուգումների։ Պահանջվում է ուսուցչի հաստատում։",
        );
      } else if (quality.status === "TEACHER_REVIEW_REQUIRED") {
        setMessage(
          `Քարտեզը ստեղծված է․ պահանջվում է ուսուցչի վերանայում (${(quality.reviewCodes ?? []).join(", ")})։`,
        );
      } else {
        setMessage(
          `Քարտեզը ստեղծված է, սակայն կան բացեր՝ ${(quality.blockingCodes ?? []).join(", ") || "ստուգման խնդիր"}։ Հաստատում չի կատարվել։`,
        );
      }
    } catch (error) {
      setMessage(
        `Գործընթացը կանգ է առել․ ${error instanceof Error ? error.message : "անհայտ սխալ"}։ Արդեն ստեղծված տվյալները չեն ջնջվել։`,
      );
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
        disabled={!token || running || !resume || resume.action === "REVIEW"}
        title={
          resume?.action === "REVIEW" && hasExistingMap
            ? "Դասի քարտեզն արդեն գոյություն ունի․ վերաքարտեզագրումը պահանջում է առանձին հաստատում"
            : "C1 → C2 → մեթոդական փաթեթ → որակի ստուգում"
        }
        className="rounded-lg border border-indigo-400/40 bg-indigo-500/15 px-2.5 py-1 text-xs text-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {running
          ? "⏳ Քարտեզագրում…"
          : resume?.snapshot.hasCanonicalNodes || resume?.action === "WAIT"
            ? "Շարունակել"
            : "✨ Միասնական քարտեզագրում"}
      </button>
      {resume?.activeJobs.some((j) => j.recoverable) && (
        <div>
          {!confirmRecovery ? (
            <button
              type="button"
              disabled={running}
              onClick={() => setConfirmRecovery(true)}
            >
              ↩ Վերականգնել
            </button>
          ) : (
            <>
              <p>Ընդհատված քարտեզագրման անվտանգ շարունակություն</p>
              <button
                type="button"
                disabled={running}
                onClick={() => void recover()}
              >
                Հաստատել
              </button>
              <button
                type="button"
                disabled={running}
                onClick={() => setConfirmRecovery(false)}
              >
                Չեղարկել
              </button>
            </>
          )}
        </div>
      )}
      {!message && resume?.action === "REVIEW" && (
        <p role="status" className="text-xs text-amber-200">
          Քարտեզը ստեղծված է․ պահանջվում է ուսուցչի վերանայում
        </p>
      )}
      {!message && resume?.action === "WAIT" && (
        <p role="status">
          {resume.activeJobs[0]?.progress ?? "⏳ Քարտեզագրում…"}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="max-w-xs text-[10px] leading-relaxed text-amber-200"
        >
          {message}
        </p>
      )}
    </div>
  );
}
