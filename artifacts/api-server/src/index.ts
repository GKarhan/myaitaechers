import { checkOpenRouterAuthentication } from "@workspace/integrations-openrouter-ai";
import app from "./app";
import { logger } from "./lib/logger";
import { seed } from "./seed";
import {
  startQuizGenerationJobs,
  stopQuizGenerationJobs,
} from "./services/quiz-generation-jobs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

seed().then(async () => {
  await startQuizGenerationJobs();
  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    void checkOpenRouterAuthentication().then((diagnostics) => {
      logger.info({ diagnostics }, "OpenRouter authentication check");
    }).catch(() => { logger.warn("OpenRouter authentication check unavailable"); });
  });
  server.on("close", stopQuizGenerationJobs);
});
