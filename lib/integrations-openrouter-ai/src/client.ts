import OpenAI from "openai";

if (!process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_OPENROUTER_BASE_URL must be set. Did you forget to provision the OpenRouter AI integration?",
  );
}

if (!process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_OPENROUTER_API_KEY must be set. Did you forget to provision the OpenRouter AI integration?",
  );
}

export const openrouter = new OpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY,
});

/** Read-only provider authentication check. Never return credentials or response bodies. */
export async function checkOpenRouterAuthentication(client: OpenAI = openrouter, transport: typeof globalThis.fetch = globalThis.fetch) {
  const key = client.apiKey ?? "";
  const base = new URL(client.baseURL);
  let authorizationHeaderPresent = false;
  let redirected = false;
  const diagnostics = {
    keyConfigured: key.trim().length > 0,
    keyHasWhitespace: /\s/.test(key),
    keyHasBearerPrefix: /^Bearer\s/i.test(key),
    keyHasOpenRouterPrefix: key.startsWith("sk-or-"),
    canonicalBaseURL: base.origin === "https://openrouter.ai" && base.pathname.replace(/\/$/, "") === "/api/v1",
  };
  const probe = client.withOptions({
    maxRetries: 0,
    timeout: 10_000,
    fetch: async (input, init) => {
      authorizationHeaderPresent = new Headers(init?.headers).has("authorization");
      const response = await transport(input, init);
      redirected = response.redirected;
      return response;
    },
  });
  try {
    // GET /key reads key metadata; it does not generate tokens or map a lesson.
    await probe.get("/key");
    return { ...diagnostics, authorizationHeaderPresent, redirected, status: 200 };
  } catch (error) {
    return { ...diagnostics, authorizationHeaderPresent, redirected,
      status: error instanceof OpenAI.APIError ? error.status : null };
  }
}
