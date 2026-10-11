
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;

// Общий бюджет. Оставляем запас до ограничения времени ответа Алисы.
const TOTAL_RESPONSE_BUDGET_MS = 3900;
const SERPER_TIMEOUT_MS = 2400;
const GEMINI_TIMEOUT_MS = 1100;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если переданы результаты интернет-поиска, используй их для ответа на актуальные вопросы. Не утверждай, что поиск выполнен, если результатов нет.",
  "Не выдумывай даты, события, источники и факты. Если данных недостаточно, честно сообщи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) {
    return text || "Не удалось подготовить ответ.";
  }

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );

  if (sentenceEnd >= 300) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");
  return (
    lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate
  ).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up|internet|online)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|поиск|актуальн|сколько стоит|свежие данные|в интернете|опубликован|последние события|на данный момент|текущ(ий|ая|ие|его|ую)|что произошло|что происходит/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const effectiveTimeout = Math.max(100, timeoutMs);

  const timer = setTimeout(
    () => controller.abort(),
    effectiveTimeout
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    return {
      response,
      data,
      durationMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key) {
    console.warn("SERPER_SKIP: API key is missing.");
    return "";
  }

  if (timeoutMs < 150) {
    console.warn("SERPER_SKIP: insufficient time budget.");
    return "";
  }

  const startedAt = Date.now();

  try {
    const { response, data, durationMs } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          q: query,
          gl: "ru",
          hl: "ru",
          num: 5
        })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("SERPER_HTTP_ERROR", JSON.stringify({
        status: response.status,
        durationMs
      }));
      return "";
    }

    const organic = Array.isArray(data.organic)
      ? data.organic
      : [];

    const items = organic.slice(0, 5).map((item, i) => {
      const title = String(item.title || "").slice(0, 180);
      const snippet = String(item.snippet || "").slice(0, 350);
      const link = String(item.link || "").slice(0, 240);

      return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
    });

    const answerBox =
      data.answerBox?.answer ||
      data.answerBox?.snippet;

    if (answerBox) {
      items.unshift(
        `Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`
      );
    }

    const result = items.length ? items.join("\n") : "";

    console.log("SERPER_OK", JSON.stringify({
      status: response.status,
      durationMs,
      resultCount: organic.length,
      answerBoxPresent: Boolean(answerBox),
      usableResults: Boolean(result)
    }));

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    if (error?.name === "AbortError") {
      console.warn("SERPER_TIMEOUT", JSON.stringify({
        durationMs,
        timeoutMs
      }));
    } else {
      console.error("SERPER_NETWORK_ERROR", JSON.stringify({
        durationMs,
        error: String(error?.message || "Unknown error").slice(0, 200)
      }));
    }

    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("MISSING_GEMINI_KEY");
  }

  if (timeoutMs < 250) {
    throw new Error("TIME_BUDGET_EXHAUSTED");
  }

  const model = String(
    process.env.GEMINI_MODEL || DEFAULT_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты интернет-поиска:\n${searchContext}\n\nИспользуй эти результаты как источник фактов. Если они не отвечают на вопрос, прямо сообщи об этом. Не утверждай, что поиск не проводился, если результаты переданы.`
    : text;

  contents.push({
    role: "user",
    parts: [{ text: prompt }]
  });

  const startedAt = Date.now();

  const { response, data, durationMs } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    console.error("GEMINI_HTTP_ERROR", JSON.stringify({
      status: response.status,
      durationMs
    }));

    if (response.status === 401 || response.status === 403) {
      throw new Error("GEMINI_KEY_REJECTED");
    }

    if (response.status === 429) {
      throw new Error("GEMINI_QUOTA");
    }

    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];

  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) {
      throw new Error("GEMINI_BLOCKED");
    }

    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  console.log("GEMINI_OK", JSON.stringify({
    durationMs: Date.now() - startedAt,
    searchContextUsed: Boolean(searchContext),
    answerLength: answer.length
  }));

  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }

  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер не настроен. Проверьте GEMINI_API_KEY в Vercel.";

    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ.";

    case "GEMINI_QUOTA":
      return "Превышен лимит запросов к Gemini. Попробуйте позже.";

    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";

    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте ещё раз.";

    default:
      return "Не получилось получить ответ от нейросети. Попробуйте позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const startedAt = Date.now();
  const remainingMs = () =>
    TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  const body =
    req.body && typeof req.body === "object"
      ? req.body
      : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(
    body?.state?.session?.history
  );

  console.log("ALICE_REQUEST", JSON.stringify({
    method: req.method,
    textLength: text.length,
    searchIntent: isSearchIntent(text)
  }));

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";

    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Оставляем время для Gemini и формирования ответа Алисы.
      const searchBudget = Math.min(
        SERPER_TIMEOUT_MS,
        Math.max(0, remainingMs() - 2300)
      );

      searchContext = await searchWeb(text, searchBudget);
    }

    const geminiBudget = Math.max(
      0,
      Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 300)
    );

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      geminiBudget
    );

    const history = [
      ...oldHistory,
      {
        role: "user",
        text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      },
      {
        role: "model",
        text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    console.log("ALICE_RESPONSE", JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      searchUsed: Boolean(searchContext)
    }));

    return res.status(200).json(
      aliceResponse(answer, false, history)
    );
  } catch (error) {
    const safeError =
      error?.name === "AbortError"
        ? new Error("TIME_BUDGET_EXHAUSTED")
        : error;

    console.warn(
      "ALICE_FALLBACK",
      JSON.stringify({
        elapsedMs: Date.now() - startedAt,
        error: safeError?.message || "unknown error"
      })
    );

    return res.status(200).json(
      aliceResponse(errorForUser(safeError), false, oldHistory)
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory
};
