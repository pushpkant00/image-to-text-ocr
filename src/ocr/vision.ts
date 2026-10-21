// Cloud OCR client — Gemini vision, called directly with the user's own API
// key. There is no backend: the image and the key go straight from the
// extension to Google (which sends access-control-allow-origin for the
// extension origin, so no proxy is needed).
//
// Prompt/response contract:
//   request  -> one image + a language hint
//   response -> { text }

/**
 * Measured on a 1300x900 page: 3.5 Flash answers in ~2-3s with thinking off.
 * 3.7/3.8 Flash reject thinkingLevel MINIMAL and then stall (90s+), so they are
 * not offered any more.
 */
export const DEFAULT_VISION_MODEL = 'gemini-3.5-flash';

/** Models the picker offers; anything else in storage is migrated away. */
export const VISION_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'] as const;

export type VisionProvider = 'google' | 'openrouter';

const OR_ROOT = 'https://openrouter.ai/api/v1';
const OR_CHAT_URL = `${OR_ROOT}/chat/completions`;

/**
 * Free (":free") OpenRouter models that accept images, in the order the picker
 * shows them. Serving changes often, so Settings refreshes this from
 * GET /api/v1/models and falls back to this list when offline.
 */
export const OPENROUTER_FREE_MODELS: { id: string; label: string }[] = [
  { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'Nemotron 3.5 Super VL' },
  { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B' },
  { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B' },
  { id: 'minimax/minimax-m3.1-flash:free', label: 'MiniMax M3.1 Flash' },
  { id: 'dots-studio/dots-3-note-preview:free', label: 'Dots3 Note' },
  { id: 'thinkingmachines/inkling-small:free', label: 'Inkling Small' },
];

/** Stored value is "provider:model" so one dropdown can hold both services. */
export function modelValue(provider: VisionProvider, model: string): string {
  return `${provider}:${model}`;
}

export function parseVisionModel(value: string | undefined): {
  provider: VisionProvider;
  model: string;
} {
  const raw = (value || '').trim();
  if (raw.startsWith('openrouter:')) {
    return { provider: 'openrouter', model: raw.slice('openrouter:'.length) };
  }
  if (raw.startsWith('google:')) return { provider: 'google', model: raw.slice('google:'.length) };
  return { provider: 'google', model: raw || DEFAULT_VISION_MODEL };
}

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Largest edge (px) sent to the model. Gemini tiles at 768px, so 1536 keeps
 *  4 tiles instead of 6 while staying sharp enough for screen text. */
export const MAX_VISION_EDGE = 1536;

/** Inline request budget is 20MB for prompt + image bytes combined. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const LANGUAGE_NAMES: Record<string, string> = {
  eng: 'English',
  hin: 'Hindi',
  spa: 'Spanish',
  fra: 'French',
  deu: 'German',
  jpn: 'Japanese',
  chi_sim: 'Chinese (Simplified)',
};

export interface VisionResult {
  text: string;
}

/** Called with the full transcript so far every time new text arrives. */
export type OcrDeltaHandler = (fullText: string) => void;

export interface VisionRequest {
  /** Image data URL (data:image/png;base64,...). */
  imageData: string;
  /** User's API key for the chosen provider (stored on-device, never synced). */
  apiKey?: string;
  model?: string;
  /** Which service to call; defaults to Google Gemini. */
  provider?: VisionProvider;
  /** Language hint (eng/hin/…), or 'auto' to let the model decide. */
  language?: string;
  signal?: AbortSignal;
}

export class VisionError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status = 0, retryable = false) {
    super(message);
    this.name = 'VisionError';
    this.status = status;
    this.retryable = retryable;
  }
}

function systemInstruction(language?: string): string {
  const code = (language || 'auto').toLowerCase();
  const name = code === 'auto' ? '' : LANGUAGE_NAMES[code];
  const lines = [
    'You are a precise OCR engine. Transcribe every piece of text in the image exactly as it appears.',
    '',
    'Rules:',
    '- Output only the transcribed text. No preamble, no commentary, no markdown code fences.',
    '- Preserve the original reading order, line breaks and paragraph breaks.',
    '- Do not translate, summarize, fix spelling, or invent text that is not in the image.',
    '- Keep punctuation, capitalization, symbols and numbers exactly as printed.',
    '- Illegible fragments: reproduce the closest readable characters, never describe the image.',
    '- If the image contains no readable text at all, return an empty text.',
  ];
  if (name) lines.push(`- The text is in ${name}.`);
  return lines.join('\n');
}

/** Split "data:image/png;base64,AAAA" into its mime type and raw base64. */
export function splitDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new VisionError('Image data is not a data URL');
  const mimeType = match[1] || 'image/png';
  const data = match[3] || '';
  if (!data) throw new VisionError('Image data is empty');
  return { mimeType, data };
}

/** How thinking is disabled, per model family. MINIMAL level is Gemini 3+;
 *  thinkingBudget 0 is Gemini 2.5; 'off' means omit the field entirely. */
type ThinkingMode = 'level' | 'budget' | 'off';

interface BodyOptions {
  thinking: ThinkingMode;
}

function buildGeminiBody(
  image: { mimeType: string; data: string },
  language: string | undefined,
  options: BodyOptions,
): string {
  // Plain text, not JSON: the reply *is* the transcription, so there is no
  // schema to negotiate and no escaping overhead.
  const generationConfig: Record<string, unknown> = { maxOutputTokens: 8192 };

  // Thinking tokens dominate latency — OCR needs none. Gemini 3 uses
  // thinkingLevel, Gemini 2.5 uses thinkingBudget; send the one that works.
  if (options.thinking === 'level') generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
  else if (options.thinking === 'budget') generationConfig.thinkingConfig = { thinkingBudget: 0 };

  return JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction(language) }] },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Transcribe all text in this image.' },
          { inlineData: { mimeType: image.mimeType, data: image.data } },
        ],
      },
    ],
    generationConfig,
  });
}

/** Pull {text} out of a reply that may be wrapped in prose or fences. */
export function parsePayload(raw: string): VisionResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();

  const candidates: string[] = [];
  if (cleaned) candidates.push(cleaned);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { text?: unknown };
      if (typeof parsed?.text === 'string') return { text: parsed.text };
    } catch {
      /* try the next candidate */
    }
  }

  // Model ignored the schema and replied with plain text — use it verbatim.
  return { text: cleaned };
}

interface ApiErrorInfo {
  detail: string;
  status: string;
  reason: string;
}

function readApiError(body: string): ApiErrorInfo {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        status?: string;
        details?: { message?: string; reason?: string }[];
      };
    };
    const details = parsed?.error?.details || [];
    const reason = details.map((d) => d?.reason || '').find(Boolean) || '';
    const detail = details.find((d) => d?.message)?.message || parsed?.error?.message || '';
    return { detail, status: parsed?.error?.status || '', reason };
  } catch {
    return { detail: body.slice(0, 200), status: '', reason: '' };
  }
}

function describeError(status: number, body: string): VisionError {
  const { detail, status: apiStatus, reason } = readApiError(body);
  const haystack = `${apiStatus} ${reason} ${detail}`;

  // An invalid key comes back as 400 INVALID_ARGUMENT / API_KEY_INVALID.
  if (/API_KEY_INVALID|API_KEY_EXPIRED|PERMISSION_DENIED|UNAUTHENTICATED/i.test(haystack)) {
    return new VisionError('Gemini API key is missing or invalid. Check it in Settings.', status);
  }
  if (/RESOURCE_EXHAUSTED|RATE_LIMIT|QUOTA/i.test(haystack) || status === 429) {
    return new VisionError('Gemini rate limit reached. Try again shortly.', status, true);
  }
  if (status === 404 || /NOT_FOUND|was not found/i.test(haystack)) {
    return new VisionError(
      'That Gemini model is unavailable. Check the model name in Settings.',
      status,
    );
  }
  if (status === 400) {
    return new VisionError(`Gemini rejected the request. ${detail}`.trim(), status);
  }
  if (status === 401 || status === 403) {
    return new VisionError('Gemini API key is missing or invalid. Check it in Settings.', status);
  }
  if (status >= 500) {
    return new VisionError('Gemini is temporarily unavailable. Try again shortly.', status, true);
  }
  return new VisionError(detail || `Gemini request failed (${status}).`, status, status >= 500);
}

/** A stalled stream (no bytes at all) is aborted after this long. */
const IDLE_TIMEOUT_MS = 20_000;

interface StreamResult {
  ok: boolean;
  status: number;
  body: string;
  text: string;
  finishReason: string;
}

interface SseChunk {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
}

interface OrChunk {
  choices?: {
    finish_reason?: string;
    delta?: { content?: string | { text?: string }[] };
  }[];
}

interface SseEvent {
  text: string;
  finish: string;
}

function geminiEvent(chunk: unknown): SseEvent {
  const candidate = (chunk as SseChunk).candidates?.[0];
  const parts = candidate?.content?.parts || [];
  return {
    finish: candidate?.finishReason || '',
    text: parts
      .filter((part) => !part.thought)
      .map((part) => part.text || '')
      .join(''),
  };
}

function openRouterEvent(chunk: unknown): SseEvent {
  const choice = (chunk as OrChunk).choices?.[0];
  const content = choice?.delta?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((part) => part?.text || '').join('');
  return { finish: choice?.finish_reason || '', text };
}

/**
 * Stream one request. Returns as soon as bytes start arriving, which means the
 * caller can paint partial text while the model is still writing — the user
 * sees the transcript in ~1s instead of waiting for the last token.
 */
async function postStream(
  url: string,
  headers: Record<string, string>,
  payload: string,
  signal: AbortSignal | undefined,
  onDelta: OcrDeltaHandler,
  extract: (chunk: unknown) => SseEvent,
  label: string,
): Promise<StreamResult> {
  const model = label;
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  let response: Response;
  arm();
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: payload,
      signal: controller.signal,
    });
  } catch {
    if (timer) clearTimeout(timer);
    if (stalled || signal?.aborted) {
      throw new VisionError(
        `${model} did not respond. Check your connection and try again.`,
        0,
        true,
      );
    }
    throw new VisionError('Could not reach the OCR service. Check your internet connection.', 0, true);
  }

  if (!response.ok) {
    if (timer) clearTimeout(timer);
    const body = await response.text();
    return { ok: false, status: response.status, body, text: '', finishReason: '' };
  }

  let text = '';
  let finishReason = '';
  const reader = response.body?.getReader();
  if (!reader) {
    if (timer) clearTimeout(timer);
    return { ok: true, status: response.status, body: '', text: '', finishReason: '' };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buffer += decoder.decode(value, { stream: true });
      let breakAt = buffer.indexOf('\n');
      while (breakAt !== -1) {
        const line = buffer.slice(0, breakAt).trim();
        buffer = buffer.slice(breakAt + 1);
        breakAt = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const event = extract(chunk);
        if (event.finish) finishReason = event.finish;
        if (event.text) {
          text += event.text;
          onDelta(text);
        }
      }
    }
  } catch (err) {
    if (stalled || signal?.aborted) {
      throw new VisionError(
        `${model} stopped responding. Try a smaller selection or a faster model.`,
        0,
        true,
      );
    }
    if (err instanceof VisionError) throw err;
    throw new VisionError('The OCR response was interrupted. Try again.', 0, true);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }

  return { ok: true, status: response.status, body: '', text, finishReason };
}

/**
 * Which thinking switch a model accepted. A rejected one costs a whole extra
 * round-trip, so remember the winner and send only that afterwards.
 */
const thinkingModes = new Map<string, ThinkingMode>();

function attemptPlans(model: string): BodyOptions[] {
  const known = thinkingModes.get(model);
  if (known) return [{ thinking: known }];
  return [{ thinking: 'level' }, { thinking: 'budget' }, { thinking: 'off' }];
}

async function callGemini(
  image: { mimeType: string; data: string },
  request: VisionRequest,
  onDelta: OcrDeltaHandler,
): Promise<VisionResult> {
  const apiKey = (request.apiKey || '').trim();
  if (!apiKey) throw new VisionError('No Gemini API key configured. Add one in Settings.', 401);

  const model = (request.model || DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL;
  // Streamed: the first token arrives in about a second and partial text is
  // handed to onDelta, so the UI never sits blank waiting for the last token.
  const url = `${API_ROOT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };

  let result: StreamResult | null = null;
  for (const attempt of attemptPlans(model)) {
    result = await postStream(
      url,
      headers,
      buildGeminiBody(image, request.language, attempt),
      request.signal,
      onDelta,
      geminiEvent,
      model,
    );
    if (result.ok) {
      thinkingModes.set(model, attempt.thinking);
      break;
    }
    // A 400 here means this model didn't accept the thinking field — try the
    // next spelling. Anything else is a real error; don't burn extra requests.
    const rejectedThinking =
      result.status === 400 && /thinking|budget|unknown name|not supported|unsupported/i.test(result.body);
    if (!rejectedThinking) break;
    console.warn('[ocr] thinking field rejected:', result.body.slice(0, 200));
  }
  if (!result) throw new VisionError('Gemini request failed.', 0, true);
  if (!result.ok) throw describeError(result.status, result.body);

  if (result.finishReason && result.finishReason !== 'STOP' && result.finishReason !== 'MAX_TOKENS') {
    throw new VisionError(`Gemini stopped early (${result.finishReason}).`, result.status);
  }

  if (!result.text) return { text: '' };
  return parsePayload(result.text);
}

function readOrDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed?.error?.message || '';
  } catch {
    return body.slice(0, 200);
  }
}

function describeOpenRouterError(status: number, body: string): VisionError {
  const detail = readOrDetail(body);
  if (status === 401 || status === 403) {
    return new VisionError('OpenRouter API key is missing or invalid. Check it in Settings.', status);
  }
  if (status === 402) {
    return new VisionError('OpenRouter needs credits for that model. Pick a free (":free") model.', status);
  }
  if (status === 429) {
    if (/day|daily/i.test(detail)) {
      return new VisionError(
        'OpenRouter free-model daily limit reached (resets 00:00 UTC). Use Gemini or try tomorrow.',
        status,
        true,
      );
    }
    return new VisionError('OpenRouter rate limit reached. Try again in a minute.', status, true);
  }
  if (status === 404) {
    return new VisionError(
      'That model is not available on OpenRouter right now. Pick another free model in Settings.',
      status,
    );
  }
  if (status >= 500) {
    return new VisionError('OpenRouter is temporarily unavailable. Try again shortly.', status, true);
  }
  return new VisionError(detail || `OpenRouter request failed (${status}).`, status, status >= 500);
}

async function callOpenRouter(
  image: { mimeType: string; data: string },
  request: VisionRequest,
  onDelta: OcrDeltaHandler,
): Promise<VisionResult> {
  const apiKey = (request.apiKey || '').trim();
  if (!apiKey) throw new VisionError('No OpenRouter API key configured. Add one in Settings.', 401);
  const model = (request.model || '').trim();
  if (!model) throw new VisionError('Pick an OpenRouter model in Settings.', 400);

  const body = JSON.stringify({
    model,
    stream: true,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: systemInstruction(request.language) },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe all text in this image.' },
          { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
        ],
      },
    ],
  });

  const result = await postStream(
    OR_CHAT_URL,
    {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'Image to Text OCR',
    },
    body,
    request.signal,
    onDelta,
    openRouterEvent,
    model,
  );
  if (!result.ok) throw describeOpenRouterError(result.status, result.body);
  if (result.finishReason && result.finishReason !== 'stop' && result.finishReason !== 'length') {
    throw new VisionError(`The model stopped early (${result.finishReason}).`, result.status);
  }
  if (!result.text) return { text: '' };
  return parsePayload(result.text);
}

/** Transcribe one image with the user's Gemini API key. */
export async function recognizeImage(
  request: VisionRequest,
  onDelta?: OcrDeltaHandler,
): Promise<VisionResult> {
  const image = splitDataUrl(request.imageData);
  if (image.data.length > MAX_IMAGE_BYTES) {
    throw new VisionError('Image is too large to send for OCR.', 413);
  }
  const emit = onDelta || (() => {});
  return request.provider === 'openrouter'
    ? callOpenRouter(image, request, emit)
    : callGemini(image, request, emit);
}

/**
 * Verify a key/model by running a one-token request.
 * Throws a VisionError with a human-readable message when either is wrong.
 */
export async function testVisionKey(
  apiKey: string,
  model?: string,
  signal?: AbortSignal,
  provider: VisionProvider = 'google',
): Promise<{ ms: number; note?: string; exhausted?: boolean }> {
  const started = performance.now();
  const key = (apiKey || '').trim();
  if (!key) throw new VisionError('No API key to test.', 401);
  // Catch a key pasted into the wrong provider's box before the API does.
  if (provider === 'openrouter' && !key.startsWith('sk-or-v1')) {
    throw new VisionError(
      'That is not an OpenRouter key — OpenRouter keys start with "sk-or-v1". A Google key starts with "AIza".',
      401,
    );
  }
  if (provider === 'google' && !key.startsWith('AIza')) {
    throw new VisionError(
      'That is not a Google AI Studio key — Gemini keys start with "AIza". An OpenRouter key starts with "sk-or-v1".',
      401,
    );
  }
  if (provider === 'openrouter') return testOpenRouterKey(key, signal, started);
  const target = (model || DEFAULT_VISION_MODEL).trim() || DEFAULT_VISION_MODEL;
  // Same endpoint and transport as real OCR, so the time reported here is what
  // a capture will actually cost.
  const url = `${API_ROOT}/${encodeURIComponent(target)}:streamGenerateContent?alt=sse`;
  const headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json' };

  const makeBody = (mode: ThinkingMode): string => {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: 64 };
    if (mode === 'level') generationConfig.thinkingConfig = { thinkingLevel: 'MINIMAL' };
    else if (mode === 'budget') generationConfig.thinkingConfig = { thinkingBudget: 0 };
    return JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig,
    });
  };

  const plans: ThinkingMode[] = thinkingModes.has(target)
    ? [thinkingModes.get(target) as ThinkingMode]
    : ['level', 'budget', 'off'];
  let result: StreamResult | null = null;
  for (const mode of plans) {
    result = await postStream(url, headers, makeBody(mode), signal, () => {}, geminiEvent, target);
    if (result.ok) {
      thinkingModes.set(target, mode);
      break;
    }
    const rejectedThinking =
      result.status === 400 && /thinking|budget|unknown name|not supported|unsupported/i.test(result.body);
    if (!rejectedThinking) break;
  }
  if (!result) throw new VisionError('Gemini request failed.', 0, true);
  if (!result.ok) throw describeError(result.status, result.body);
  return { ms: Math.round(performance.now() - started) };
}

/** Validate an OpenRouter key and report the remaining free-model quota. */
async function testOpenRouterKey(
  key: string,
  signal: AbortSignal | undefined,
  started: number,
): Promise<{ ms: number; note?: string; exhausted?: boolean }> {
  let response: Response;
  try {
    response = await fetch(`${OR_ROOT}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw new VisionError('Could not reach OpenRouter. Check your internet connection.', 0, true);
  }
  const body = await response.text();
  if (!response.ok) throw describeOpenRouterError(response.status, body);
  let note: string | undefined;
  let exhausted = false;
  try {
    const data = (JSON.parse(body) as {
      data?: { free_model_daily_requests?: { remaining?: number; limit?: number } };
    }).data;
    const quota = data?.free_model_daily_requests;
    if (quota && typeof quota.remaining === 'number' && typeof quota.limit === 'number') {
      const left = Math.max(0, quota.remaining);
      note = `${left}/${quota.limit} free requests left today`;
      exhausted = left <= 0;
    }
  } catch {
    /* quota is a nicety, not required */
  }
  return { ms: Math.round(performance.now() - started), note, exhausted };
}

