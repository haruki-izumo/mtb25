export async function chatCompletion(params: {
  apiKey: string;
  prompt: string;
}) {
  const model = process.env.OPENAI_MODEL || process.env.GEMINI_MODEL || "gpt-4o-mini";
  // Prefer Gemini AI Studio when key looks like Google; otherwise OpenAI-compatible.
  const key = params.apiKey.trim();
  const useGemini = !key.startsWith("sk-") || process.env.FORCE_GEMINI === "true";

  if (useGemini && !key.startsWith("sk-")) {
    const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: params.prompt }] }],
        generationConfig: { temperature: 0.4 },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Gemini error: ${res.status} ${body.slice(0, 300)}`);
      (err as Error & { status: number; code: string }).status = 502;
      (err as Error & { code: string }).code = "gemini";
      throw err;
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();
    if (!text) throw new Error("Empty Gemini response");
    return text;
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      messages: [{ role: "user", content: params.prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`OpenAI error: ${res.status} ${body.slice(0, 300)}`);
    (err as Error & { status: number; code: string }).status = 502;
    (err as Error & { code: string }).code = "openai";
    throw err;
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty OpenAI response");
  return text;
}
