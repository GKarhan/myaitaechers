import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const repo = fileURLToPath(new URL("../", import.meta.url));
const requireApi = createRequire(
  path.join(repo, "artifacts/api-server/package.json"),
);
const { build } = requireApi("esbuild");
const bundle = await build({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { setBaseUrl } from "@workspace/api-client-react";
      import { UnifiedLessonMapButton } from "./src/components/UnifiedLessonMapButton";
      setBaseUrl("https://mapping.invalid");
      createRoot(document.getElementById("root")).render(
        <React.StrictMode><UnifiedLessonMapButton lessonId={7} token="test-only"
          hasExistingMap={true} onRefresh={() => {}} /></React.StrictMode>);
    `,
    resolveDir: path.join(repo, "artifacts/myaiteacher"),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const html =
  '<div id="root"></div><script>' +
  bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") +
  "</script>";
const browser = await chromium.launch({ headless: true });
let passed = 0;
try {
  for (const interruptedStage of ["C1", "C2", "TEACHING"]) {
    const page = await browser.newPage();
    const posts = [];
    let action = "WAIT";
    await page.route("https://mapping.invalid/**", async (route) => {
      const req = route.request();
      const endpoint = new URL(req.url()).pathname.split("/").at(-1);
      if (req.isNavigationRequest())
        return route.fulfill({ contentType: "text/html", body: html });
      if (req.method() === "POST") posts.push(endpoint);
      let result;
      if (endpoint === "unified-resume-state")
        result = {
          action,
          reason: "EXISTING_JOB_ACTIVE",
          snapshot: { hasCanonicalNodes: true },
          activeJobs:
            action === "WAIT"
              ? [
                  {
                    jobId: 9,
                    updatedAt: new Date().toISOString(),
                    progress: interruptedStage,
                    recoverable: false,
                  },
                ]
              : [],
        };
      else if (endpoint === "generate-cognitive-paths") {
        action = "START_TEACHING";
        result = { status: "completed" };
      } else if (endpoint === "generate-teaching-content") {
        action = "QUALITY_CHECK";
        result = { jobId: 10, status: "pending" };
      } else if (endpoint === "generate-status")
        result = { status: "completed" };
      else if (endpoint === "unified-quality-readiness")
        result = { status: "QUALITY_READY" };
      else throw new Error("Unexpected endpoint " + endpoint);
      return route.fulfill({ json: result });
    });
    await page.goto("https://mapping.invalid/");
    await page
      .getByRole("button", { name: "Շարունակել", exact: true })
      .waitFor();
    // Navigation destroys component memory; the new instance must use the API.
    await page.goto("https://mapping.invalid/");
    const button = page.getByRole("button", {
      name: "Շարունակել",
      exact: true,
    });
    await button.waitFor();
    assert.deepEqual(posts, []);
    await button.evaluate((button) => {
      button.click();
      button.click();
    });
    action =
      interruptedStage === "C1"
        ? "START_C2"
        : interruptedStage === "C2"
          ? "START_TEACHING"
          : "QUALITY_CHECK";
    await page
      .getByRole("status")
      .filter({ hasText: "Պահանջվում է ուսուցչի հաստատում" })
      .waitFor({ timeout: 20000 });
    assert.equal(posts.filter((x) => x === "map").length, 0);
    assert.equal(
      posts.filter((x) => x === "generate-cognitive-paths").length,
      interruptedStage === "C1" ? 1 : 0,
    );
    assert.equal(
      posts.filter((x) => x === "generate-teaching-content").length,
      interruptedStage === "TEACHING" ? 0 : 1,
    );
    assert.equal(
      posts.some((x) => x.includes("approve")),
      false,
    );
    await page.close();
    passed++;
    console.log("PASS navigation resume from active " + interruptedStage);
  }
  for (const conflict of [false, true]) {
    const page = await browser.newPage();
    const posts = [];
    let recovered = false;
    const stamp = "2026-10-16T00:00:00.000Z";
    await page.route("https://mapping.invalid/**", async (route) => {
      const req = route.request();
      if (req.isNavigationRequest())
        return route.fulfill({ contentType: "text/html", body: html });
      const endpoint = new URL(req.url()).pathname.split("/").at(-1);
      if (req.method() === "POST") posts.push(endpoint);
      if (endpoint === "recover-mapping-job") {
        assert.deepEqual(req.postDataJSON(), {
          jobId: 9,
          observedUpdatedAt: stamp,
          confirmed: true,
        });
        recovered = !conflict;
        return route.fulfill({
          status: conflict ? 409 : 200,
          json: conflict
            ? { error: "JOB_UPDATED_OR_NOT_STALE" }
            : { retiredJobId: 9 },
        });
      }
      assert.equal(endpoint, "unified-resume-state");
      return route.fulfill({
        json: {
          action: recovered ? "START_C1" : "REVIEW",
          reason: "STALE_JOB_REQUIRES_REVIEW",
          snapshot: { hasCanonicalNodes: false },
          activeJobs: recovered
            ? []
            : [
                {
                  jobId: 9,
                  updatedAt: stamp,
                  progress: null,
                  recoverable: true,
                },
              ],
        },
      });
    });
    await page.goto("https://mapping.invalid/");
    await page.getByRole("button", { name: "↩ Վերականգնել" }).click();
    assert.deepEqual(posts, []);
    await page.getByRole("button", { name: "Հաստատել", exact: true }).click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some(
        (button) =>
          !button.disabled &&
          (button.textContent === "Հաստատել" ||
            button.textContent === "✨ Միասնական քարտեզագրում"),
      ),
    );
    assert.deepEqual(posts, ["recover-mapping-job"]);
    await page.close();
    passed++;
    console.log(
      "PASS explicit recovery " +
        (conflict ? "heartbeat conflict" : "confirmation"),
    );
  }
  console.log(
    passed + " browser scenarios passed (actual React component, mocked API).",
  );
} finally {
  await browser.close();
}
