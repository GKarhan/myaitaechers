/**
 * PDF page extraction — full dump of pages 9-14 to find exercises
 */
import { extractPdfPageRange } from "../../services/lesson-mapping.js";
import path from "path";

const filePath = path.join(process.cwd(), "uploads", "1786385206643-292484125.pdf");

(async () => {
  for (let p = 9; p <= 14; p++) {
    const text = await extractPdfPageRange(filePath, p, p);
    console.log(`\n${"═".repeat(70)}`);
    console.log(`PDF PAGE ${p}  (${text.length} chars)`);
    console.log("═".repeat(70));
    console.log(text);   // full content, no truncation
  }
})();
