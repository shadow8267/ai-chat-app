/* ============================================================
   chat-engine.js — Streaming API call, no DOM knowledge
   ============================================================ */

import { getActiveConfig, getDefaultModel } from './config-manager.js';
import { addAiMessage, addAiVersion, createIncompleteAiMessage, updateAiMessageAt, removeAiMessageAt, addDiscussionMessage, updateDiscussionMessage, truncateDiscussionAfter, createConversation, getActiveConv, getActiveMessages, getDiscussionMessages } from './conversation-manager.js';
import { logEvent, updateLog } from './logger.js';

function toNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function getSamplingParams(chatParams = {}) {
  return {
    temperature: Math.max(0.01, Math.min(2, toNumber(chatParams.temperature, 0.7))),
    topP: Math.max(0.05, Math.min(1, toNumber(chatParams.topP, 1.0))),
    topK: Math.round(Math.max(1, Math.min(100, toNumber(chatParams.topK, 40)))),
    maxTokens: Math.round(Math.max(64, Math.min(32768, toNumber(chatParams.maxTokens, 4096))) / 64) * 64,
  };
}

/* ------------------------------------------------------------
   采样参数兼容处理
   ------------------------------------------------------------
   部分新模型（GPT-5/6/7 系列、o1/o3 等推理模型）不接受 temperature、
   top_p 等采样参数，命中时会直接返回
   `Unsupported parameter: 'temperature' is not supported with this model.`
   导致整个请求 400、模型完全不可用。

   处理分两层：
   1) 预先判断：按模型名识别出这类模型，直接不发送采样参数（省掉一次失败请求）；
   2) 反应式兜底：服务端仍报「参数不支持」时，自动把被点名的参数摘掉
      （max_tokens 优先改名为 max_completion_tokens）后重试，
      覆盖模型名识别不到的中转站与将来新出的模型。
   ------------------------------------------------------------ */

/** 服务端表示「该参数不受支持」时的识别模式 */
const UNSUPPORTED_PARAM_PATTERN = /(unsupported|not\s+supported|does\s*not\s+support|不支持|无法识别|unrecognized|unknown\s+parameter|invalid\s+parameter)/i;

/** 可按需摘除的参数，按摘除优先级排列（仅取请求体里真实存在的项） */
const SAMPLING_FALLBACK_ORDER = [
  'temperature',
  'top_p',
  'reasoning_effort',
  'max_completion_tokens',
  'max_tokens',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'stop',
];

/** 单次请求最多调整几次参数，防止与服务端来回拉锯 */
const MAX_SAMPLING_FALLBACK_STEPS = 6;

/**
 * 浏览器 / 代理层面的瞬时网络故障。这类失败与请求内容无关，
 * 稍后重试往往就能成功（海外中转站线路抖动时非常常见）。
 */
const TRANSIENT_NETWORK_PATTERN = /(failed\s+to\s+fetch|networkerror|network\s+error|load\s+failed|network\s+request\s+failed|err_(?:connection|network|empty_response|timed_out|name_not_resolved|internet_disconnected|address_unreachable)|connection\s+(?:refused|reset|closed|aborted)|socket\s+hang\s+up|proxy\s+error|econnreset|etimedout|econnrefused|enotfound|连接超时|连接失败|网络不可达)/i;

/** 瞬时网络故障的最大重试次数（不含首次请求） */
const MAX_NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAYS_MS = [800, 2000];

/** 默认不发送采样参数的模型名（GPT-5/6/7 与 o 系列推理模型） */
const SAMPLING_OMIT_MODEL_PATTERN = /^(?:gpt-(?:5|6|7)|o[1-9])(?:[.\-_]|$)/i;

/** 模型名是否属于「默认不发送采样参数」的家族 */
export function modelOmitsSamplingByDefault(model) {
  return SAMPLING_OMIT_MODEL_PATTERN.test(String(model || '').trim());
}

/** 结合配置项与该模型家族，判断本次请求是否省略采样参数 */
export function resolveOmitSampling(cfg, model) {
  const mode = cfg?.samplingMode;
  if (mode === 'never') return true;
  if (mode === 'always') return false;
  return modelOmitsSamplingByDefault(model);
}

/**
 * 根据服务端报错，决定下一步该如何调整请求体。
 * @returns {{action:'delete'|'rename', key?:string, from?:string, to?:string}|null}
 */
export function planSamplingFallback(body, message) {
  const text = String(message || '');
  if (!text || !UNSUPPORTED_PARAM_PATTERN.test(text)) return null;
  const lower = text.toLowerCase();
  const present = SAMPLING_FALLBACK_ORDER.filter(key => Object.prototype.hasOwnProperty.call(body || {}, key));
  if (!present.length) return null;
  // 服务端明确要求改用 max_completion_tokens 时，优先改名而不是直接丢弃长度限制
  if (present.includes('max_tokens') && !present.includes('max_completion_tokens')
      && lower.includes('max_completion_tokens')) {
    return { action: 'rename', from: 'max_tokens', to: 'max_completion_tokens' };
  }
  // 报错里点名的参数优先处理
  const named = present.find(key => lower.includes(key));
  if (named) return { action: 'delete', key: named };
  // 点名的是我们并没有发送的参数 → 不要乱删，原样抛错给上层
  if (SAMPLING_FALLBACK_ORDER.some(key => lower.includes(key))) return null;
  // 只是泛指「采样参数不受支持」→ 按既定顺序摘掉第一个
  return { action: 'delete', key: present[0] };
}

/** 应用一次参数调整；返回是否真的改动了请求体 */
export function applySamplingFallback(request, plan) {
  const body = request?.body || {};
  if (plan.action === 'rename') {
    if (!Object.prototype.hasOwnProperty.call(body, plan.from)) return false;
    body[plan.to] = body[plan.from];
    delete body[plan.from];
  } else {
    if (!Object.prototype.hasOwnProperty.call(body, plan.key)) return false;
    delete body[plan.key];
  }
  // 同步日志快照，避免日志里仍留着已被摘除的参数
  if (request.logRequest && typeof request.logRequest === 'object') {
    if (plan.action === 'rename') {
      if (Object.prototype.hasOwnProperty.call(request.logRequest, plan.from)) delete request.logRequest[plan.from];
      request.logRequest[plan.to] = body[plan.to];
    } else {
      delete request.logRequest[plan.key];
    }
  }
  return true;
}

/** 生成给用户看的中文说明，例如「temperature」「max_tokens → max_completion_tokens」 */
function describeSamplingFallback(plan) {
  return plan.action === 'rename' ? `${plan.from} → ${plan.to}` : String(plan.key);
}

/** 自动调整后仍然失败时，在原始报错后补一句可操作的中文提示 */
function decorateSamplingError(message, request) {
  const text = String(message || '');
  if (!UNSUPPORTED_PARAM_PATTERN.test(text)) return text;
  const remaining = SAMPLING_FALLBACK_ORDER.filter(key => Object.prototype.hasOwnProperty.call(request?.body || {}, key));
  const remainingHint = remaining.length ? `请求中仍有 ${remaining.join('、')}；` : '';
  return `${text}\n\n提示：该模型可能不接受采样参数。${remainingHint}可在「配置管理 → 采样参数发送方式」中选择「从不发送 Temperature / Top P」，或清空「推理强度」后重试。`;
}

/** 是否为「与请求内容无关」的瞬时网络故障 */
export function isTransientNetworkError(error) {
  const text = String(error?.message || error || '');
  return TRANSIENT_NETWORK_PATTERN.test(text);
}

/**
 * 把浏览器那句无从下手的 `Failed to fetch` 变成可操作的提示。
 * 只包装网络层错误，服务商返回的 HTTP 错误原样透传。
 */
function decorateNetworkError(error, request, useProxy) {
  if (!error || error.name === 'AbortError') return error;
  const raw = String(error.message || error);
  if (!/failed\s+to\s+fetch|networkerror|load\s+failed/i.test(raw)) return error;
  let host = String(request?.targetUrl || '');
  try { host = new URL(request.targetUrl).host; } catch { /* 保留原始字符串 */ }
  const hint = useProxy
    ? '本地代理没能连上目标站点。请确认网络能访问该地址，或稍后重试；长期如此请更换中转站。'
    : '浏览器直连目标站点失败：通常是网络不通 / DNS 解析失败 / 线路抖动，也可能是该站点不允许网页直连（跨域被拦）。建议在「配置管理」中勾选「使用 CORS 代理（网页版）」，并检查网络。';
  const wrapped = new Error(`无法连接到模型服务（${host}）：${raw}\n\n${hint}`);
  wrapped.code = 'network_error';
  wrapped.cause = error;
  return wrapped;
}

/** 可被中止打断的等待 */
function sleepWithAbort(ms, ac) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('请求已中止', 'AbortError'));
    };
    const timer = setTimeout(() => {
      ac?.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    ac?.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function buildGeminiSafetySettings(chatParams = {}) {
  const categories = {
    hateSpeech: 'HARM_CATEGORY_HATE_SPEECH',
    harassment: 'HARM_CATEGORY_HARASSMENT',
    dangerous: 'HARM_CATEGORY_DANGEROUS_CONTENT',
    sexual: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  };
  const thresholds = {
    block_low: 'BLOCK_LOW_AND_ABOVE',
    block_medium: 'BLOCK_MEDIUM_AND_ABOVE',
    block_only_high: 'BLOCK_ONLY_HIGH',
    off: 'OFF',
  };
  return Object.entries(categories)
    .map(([key, category]) => {
      const setting = chatParams.geminiSafety?.[key] || 'default';
      return setting === 'default' ? null : { category, threshold: thresholds[setting] };
    })
    .filter(Boolean);
}

function isGeminiConfig(cfg) {
  return cfg?.apiType === 'gemini';
}

function normalizeBaseUrl(url, fallback) {
  return (url || fallback).replace(/\/+$/, '');
}

function getSystemInstruction(messages) {
  return messages
    .filter(message => message.role === 'system')
    .map(message => String(message.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function buildGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = String(message.content || '');
    if (!text) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous?.role === role) previous.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return contents.length ? contents : [{ role: 'user', parts: [{ text: '请回答。' }] }];
}

export function buildRequest(cfg, currentModel, messages, chatParams = {}) {
  const model = currentModel || getDefaultModel();
  const sampling = getSamplingParams(chatParams);
  const systemInstruction = getSystemInstruction(messages);
  const baseUrl = normalizeBaseUrl(
    cfg.url,
    isGeminiConfig(cfg) ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1',
  );

  if (isGeminiConfig(cfg)) {
    const modelName = String(model).replace(/^models\//, '');
    const customPath = cfg.chatPath?.trim();
    const path = customPath || `/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse`;
    const targetUrl = baseUrl + (path.startsWith('/') ? path : `/${path}`);
    const body = {
      contents: buildGeminiContents(messages),
      generationConfig: {
        temperature: sampling.temperature,
        topP: sampling.topP,
        topK: sampling.topK,
        maxOutputTokens: sampling.maxTokens,
      },
    };
    const safetySettings = buildGeminiSafetySettings(chatParams);
    if (safetySettings.length) body.safetySettings = safetySettings;
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    return {
      provider: 'gemini',
      model,
      targetUrl,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
      body,
      logRequest: { model, contents: body.contents, systemInstruction: body.systemInstruction, safetySettings: body.safetySettings, stream: true, generationConfig: body.generationConfig },
    };
  }

  const omitSampling = resolveOmitSampling(cfg, model);
  const body = {
    model,
    messages,
    stream: true,
    max_tokens: sampling.maxTokens,
  };
  if (!omitSampling) {
    body.temperature = sampling.temperature;
    body.top_p = sampling.topP;
  }
  if (['low', 'medium', 'high', 'max'].includes(chatParams.reasoningEffort)) {
    body.reasoning_effort = chatParams.reasoningEffort;
  }
  const chatPath = cfg.chatPath || '/chat/completions';
  const targetUrl = baseUrl + (chatPath.startsWith('/') ? chatPath : `/${chatPath}`);
  return {
    provider: 'openai',
    model,
    targetUrl,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body,
    logRequest: { ...body },
    sampling,
    omitSampling,
  };
}

function getErrorMessage(status, text, provider) {
  try {
    const data = JSON.parse(text);
    return data.error?.message || data.message || data.error || `${provider} HTTP ${status}`;
  } catch {
    return `${provider} HTTP ${status}: ${text.substring(0, 200)}`;
  }
}

function textFromContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => (
    typeof item === 'string'
      ? item
      : typeof item?.text === 'string'
        ? item.text
        : ''
  )).join('');
}

function parseStreamPayload(payload, provider) {
  if (!payload || typeof payload !== 'object') {
    return { think: '', content: '', metadata: {} };
  }
  if (payload.error) {
    const providerMessage = payload.error?.message || payload.message || String(payload.error);
    const error = new Error(`服务商返回错误：${providerMessage}`);
    error.code = 'provider_error';
    error.diagnostics = {
      providerErrorCode: payload.error?.code || null,
      providerErrorStatus: payload.error?.status || payload.error?.type || null,
    };
    throw error;
  }
  if (provider === 'gemini') {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const candidate = candidates.find(item => Array.isArray(item?.content?.parts)) || candidates[0] || null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    let think = '';
    let content = '';
    const partTypes = [];
    let toolCallCount = 0;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') {
        const isThought = part.thought === true || part.type === 'thought';
        partTypes.push(isThought ? 'thought' : 'text');
        if (isThought) think += part.text;
        else content += part.text;
      } else if (part.functionCall) {
        partTypes.push('functionCall');
        toolCallCount += 1;
      } else if (part.functionResponse) partTypes.push('functionResponse');
      else if (part.executableCode) partTypes.push('executableCode');
      else if (part.codeExecutionResult) partTypes.push('codeExecutionResult');
      else if (part.inlineData) partTypes.push('inlineData');
      else partTypes.push('unknown');
    }
    return {
      think,
      content,
      metadata: {
        candidateCount: candidates.length,
        finishReasons: candidates.map(item => item?.finishReason).filter(Boolean),
        promptBlockReason: payload.promptFeedback?.blockReason || null,
        promptBlockMessage: payload.promptFeedback?.blockReasonMessage || null,
        partTypes,
        toolCallCount,
        modelVersion: payload.modelVersion || null,
        responseId: payload.responseId || null,
      },
    };
  }
  const choice = payload.choices?.[0] || {};
  const delta = choice.delta || {};
  const message = choice.message || {};
  const think = delta.reasoning_content
    || delta.reasoning
    || message.reasoning_content
    || message.reasoning
    || '';
  const content = textFromContent(delta.content) || textFromContent(message.content);
  const toolCallCount = Array.isArray(delta.tool_calls)
    ? delta.tool_calls.length
    : Array.isArray(message.tool_calls)
      ? message.tool_calls.length
      : delta.function_call || message.function_call
        ? 1
        : 0;
  return {
    think,
    content,
    metadata: {
      choiceCount: Array.isArray(payload.choices) ? payload.choices.length : 0,
      finishReasons: payload.choices?.map(item => item?.finish_reason).filter(Boolean) || [],
      toolCallCount,
      refusalPresent: Boolean(delta.refusal || message.refusal),
    },
  };
}

function readPath(source, path) {
  return path.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, source);
}

function firstTokenNumber(source, paths) {
  for (const path of paths) {
    const raw = readPath(source, path);
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

function normalizeUsage(payload, provider) {
  const source = provider === 'gemini' ? payload?.usageMetadata : payload?.usage;
  if (!source || typeof source !== 'object') return null;

  const inputPaths = provider === 'gemini'
    ? ['promptTokenCount', 'prompt_token_count', 'inputTokenCount', 'input_tokens']
    : ['prompt_tokens', 'input_tokens', 'promptTokenCount'];
  const outputPaths = provider === 'gemini'
    ? ['candidatesTokenCount', 'candidates_token_count', 'outputTokenCount', 'output_tokens']
    : ['completion_tokens', 'output_tokens', 'completionTokenCount'];
  const totalPaths = provider === 'gemini'
    ? ['totalTokenCount', 'total_token_count', 'total_tokens']
    : ['total_tokens', 'totalTokenCount'];
  const cachedReadPaths = provider === 'gemini'
    ? ['cachedContentTokenCount', 'cached_content_token_count', 'cacheReadInputTokens', 'cache_read_input_tokens']
    : ['prompt_tokens_details.cached_tokens', 'input_tokens_details.cached_tokens', 'cached_tokens', 'cache_read_input_tokens', 'cache_read_tokens', 'cache_read_input_tokens_details.cached_tokens'];
  const cacheWritePaths = provider === 'gemini'
    ? ['cacheWriteInputTokens', 'cache_write_input_tokens', 'cacheWriteTokens', 'cache_write_tokens']
    : ['cache_creation_input_tokens', 'cache_write_input_tokens', 'cache_write_tokens', 'prompt_tokens_details.cache_write_tokens', 'input_tokens_details.cache_write_tokens'];

  const cachedReadTokens = firstTokenNumber(source, cachedReadPaths);
  const cacheWriteTokens = firstTokenNumber(source, cacheWritePaths);
  return {
    provider,
    inputTokens: firstTokenNumber(source, inputPaths),
    outputTokens: firstTokenNumber(source, outputPaths),
    totalTokens: firstTokenNumber(source, totalPaths),
    cachedReadTokens,
    cacheWriteTokens,
    cacheStatus: cachedReadTokens === null ? 'unavailable' : cachedReadTokens > 0 ? 'hit' : 'miss',
  };
}

function mergeUsage(current, next) {
  if (!next) return current;
  if (!current) return next;
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  if (current.cacheStatus !== 'unavailable' && next.cacheStatus === 'unavailable') {
    merged.cacheStatus = current.cacheStatus;
    merged.cachedReadTokens = current.cachedReadTokens;
  }
  return merged;
}

function getProxyEndpoint() {
  if (location.hostname === 'appassets.androidplatform.net') {
    throw new Error('当前 Android 版本没有可用的原生网络通道，请更新 APK');
  }
  return '/api/proxy';
}

function hasNativeHttpBridge() {
  return !!window.AndroidHttp
    && typeof window.AndroidHttp.start === 'function'
    && typeof window.AndroidHttp.cancel === 'function';
}

const nativeHttpRequests = new Map();

function decodeBase64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function mergeResponseMetadata(current, next) {
  const merged = { ...current, ...next };
  merged.finishReasons = [...new Set([
    ...(current.finishReasons || []),
    ...(next.finishReasons || []),
  ])];
  merged.partTypes = [...new Set([
    ...(current.partTypes || []),
    ...(next.partTypes || []),
  ])];
  merged.toolCallCount = Math.max(
    Number(current.toolCallCount) || 0,
    Number(next.toolCallCount) || 0,
  );
  return merged;
}

function getHeaderValue(headers, targetName) {
  if (!headers || typeof headers !== 'object') return '';
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === targetName.toLowerCase());
  return entry ? String(entry[1] || '') : '';
}

function classifyEmptyResult(request, diagnostics) {
  const blockReason = diagnostics.promptBlockReason
    || diagnostics.finishReasons?.find(reason => [
      'SAFETY',
      'RECITATION',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
    ].includes(String(reason).toUpperCase()));
  if (blockReason) {
    return `模型未生成正文，请求被服务商阻止（${blockReason}）。可调整内容或安全设置后重试。`;
  }
  if (diagnostics.toolCallCount > 0) {
    return '模型只返回了工具调用，但当前应用不支持执行工具调用。请改用文本输出模型或关闭工具调用。';
  }
  if (diagnostics.responseBytes === 0) {
    return '模型接口返回了空响应，未收到任何数据。请重试或检查服务商状态。';
  }
  if (diagnostics.parsedPayloadCount === 0) {
    return `收到响应但无法解析（${diagnostics.contentType || '未知响应类型'}）。请检查 API 类型、地址和模型兼容性。`;
  }
  const finishReason = diagnostics.finishReasons?.[0];
  if (finishReason) {
    return `模型结束了请求，但没有返回可显示的正文（结束原因：${finishReason}）。`;
  }
  return `${request.provider === 'gemini' ? 'Gemini' : '模型'} 请求结束，但没有返回可显示的正文。请重试；若反复出现，请查看本次错误日志中的响应诊断。`;
}

function createStreamAccumulator(request, cb) {
  let thinkText = '';
  let contentText = '';
  let usage = null;
  let buffer = '';
  let rawBody = '';
  let eventData = [];
  let eventName = '';
  let responseMetadata = {};
  let contentType = '';
  let parserMode = 'auto';
  let responseBytes = 0;
  let chunkCount = 0;
  let sseEventCount = 0;
  let parsedPayloadCount = 0;
  let malformedEventCount = 0;
  let sawDoneMarker = false;
  let firstParseError = '';
  const decoder = new TextDecoder();

  const buildDiagnostics = () => ({
    parserMode,
    contentType: contentType || null,
    responseBytes,
    chunkCount,
    sseEventCount,
    parsedPayloadCount,
    malformedEventCount,
    sawDoneMarker,
    firstParseError: firstParseError || null,
    ...responseMetadata,
  });

  const enrichError = error => {
    error.diagnostics = {
      ...buildDiagnostics(),
      ...(error.diagnostics || {}),
    };
    error.partial = { thinkText, contentText, usage };
    return error;
  };

  const applyPayload = payload => {
    const payloads = Array.isArray(payload) ? payload : [payload];
    for (const item of payloads) {
      if (item?.type === 'error' || item?.object === 'error') {
        const error = new Error(item.error?.message || item.message || '服务商返回了错误响应');
        error.code = 'provider_error';
        throw enrichError(error);
      }
      const delta = parseStreamPayload(item, request.provider);
      parsedPayloadCount += 1;
      usage = mergeUsage(usage, normalizeUsage(item, request.provider));
      responseMetadata = mergeResponseMetadata(responseMetadata, delta.metadata || {});
      if (delta.think) {
        thinkText += delta.think;
        cb.onThink(thinkText);
      }
      if (delta.content) {
        contentText += delta.content;
        cb.onContent(contentText);
      }
    }
  };

  const processEvent = () => {
    if (!eventData.length) {
      eventName = '';
      return;
    }
    const data = eventData.join('\n').trim();
    eventData = [];
    sseEventCount += 1;
    if (!data) {
      eventName = '';
      return;
    }
    if (data === '[DONE]') {
      sawDoneMarker = true;
      eventName = '';
      return;
    }
    try {
      if (eventName === 'error') {
        let message = data;
        try {
          const payload = JSON.parse(data);
          message = payload.error?.message || payload.message || data;
        } catch {
          message = data;
        }
        const error = new Error(`服务商返回错误：${String(message).slice(0, 500)}`);
        error.code = 'provider_error';
        throw enrichError(error);
      }
      applyPayload(JSON.parse(data));
    } catch (error) {
      if (error?.code === 'provider_error') throw enrichError(error);
      malformedEventCount += 1;
      if (!firstParseError) firstParseError = String(error?.message || error).slice(0, 240);
    } finally {
      eventName = '';
    }
  };

  const processLine = line => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized) {
      processEvent();
      return;
    }
    if (normalized.startsWith('event:')) eventName = normalized.slice(6).trim();
    if (normalized.startsWith('data:')) eventData.push(normalized.slice(5).replace(/^ /, ''));
  };

  const processSseText = text => {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(processLine);
  };

  const setResponseInfo = (status, headers = {}) => {
    contentType = getHeaderValue(headers, 'content-type').toLowerCase();
    if (contentType.includes('text/event-stream')) parserMode = 'sse';
    else if (contentType.includes('json')) parserMode = 'json';
    return Number(status) || 0;
  };

  const append = bytes => {
    responseBytes += bytes.byteLength;
    chunkCount += 1;
    const text = decoder.decode(bytes, { stream: true });
    rawBody += text;
    if (parserMode === 'sse' || parserMode === 'sse-fallback') {
      processSseText(text);
    } else if (/^(?:data:|event:|id:|retry:)/m.test(rawBody.trimStart())) {
      parserMode = 'sse-fallback';
      buffer = '';
      eventData = [];
      eventName = '';
      processSseText(rawBody);
    }
  };

  const finish = () => {
    const tail = decoder.decode();
    rawBody += tail;
    if (parserMode === 'sse' || parserMode === 'sse-fallback') processSseText(tail);
    const trimmedBody = rawBody.trim();
    if (parserMode === 'auto') {
      parserMode = /^(?:data:|event:|id:|retry:)/m.test(trimmedBody) ? 'sse' : 'json';
      if (parserMode === 'sse') processSseText(rawBody);
    }
    if (parserMode === 'sse' || parserMode === 'sse-fallback') {
      if (buffer) processLine(buffer);
      processEvent();
      if (parsedPayloadCount === 0 && /^[\[{]/.test(trimmedBody)) {
        try {
          parserMode = 'json-fallback';
          applyPayload(JSON.parse(trimmedBody));
        } catch (error) {
          if (error?.code === 'provider_error') throw enrichError(error);
          malformedEventCount += 1;
          if (!firstParseError) firstParseError = String(error?.message || error).slice(0, 240);
        }
      }
    } else if (trimmedBody) {
      try {
        applyPayload(JSON.parse(trimmedBody));
      } catch (error) {
        if (error?.code === 'provider_error') throw enrichError(error);
        if (/^(?:data:|event:|id:|retry:)/m.test(trimmedBody)) {
          parserMode = 'sse-fallback';
          buffer = '';
          eventData = [];
          eventName = '';
          processSseText(rawBody);
          if (buffer) processLine(buffer);
          processEvent();
        } else {
          malformedEventCount += 1;
          if (!firstParseError) firstParseError = String(error?.message || error).slice(0, 240);
        }
      }
    }
    const diagnostics = buildDiagnostics();
    if (!contentText.trim()) {
      const error = new Error(classifyEmptyResult(request, diagnostics));
      error.code = 'empty_model_response';
      throw enrichError(error);
    }
    return { thinkText, contentText, usage, diagnostics };
  };

  const partial = () => ({ thinkText, contentText, usage });
  return { append, finish, partial, setResponseInfo };
}

function installNativeHttpCallbacks() {
  if (window.__aiChatNativeHttpCallbacksInstalled) return;
  window.__aiChatNativeHttpCallbacksInstalled = true;
  window.__aiChatNativeHttpStart = (requestId, status, headersJson) => {
    const pending = nativeHttpRequests.get(requestId);
    if (!pending) return;
    pending.status = Number(status) || 0;
    pending.headersJson = headersJson || '{}';
    let headers = {};
    try {
      const parsed = JSON.parse(pending.headersJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) headers = parsed;
    } catch {
      headers = {};
    }
    pending.accumulator.setResponseInfo(pending.status, headers);
  };
  window.__aiChatNativeHttpChunk = (requestId, base64Chunk) => {
    const pending = nativeHttpRequests.get(requestId);
    if (!pending) return;
    try {
      pending.accumulator.append(decodeBase64Bytes(base64Chunk));
    } catch (error) {
      try { window.AndroidHttp.cancel(requestId); } catch { /* Bridge may already be detached. */ }
      pending.reject(error);
    }
  };
  window.__aiChatNativeHttpComplete = requestId => {
    const pending = nativeHttpRequests.get(requestId);
    if (!pending) return;
    try {
      pending.resolve(pending.accumulator.finish());
    } catch (error) {
      pending.reject(error);
    }
  };
  window.__aiChatNativeHttpError = (requestId, message, status, responseBody) => {
    const pending = nativeHttpRequests.get(requestId);
    if (!pending) return;
    const statusCode = Number(status) || pending.status || 0;
    const providerName = pending.request.provider === 'gemini' ? 'Gemini API' : 'API';
    const detail = statusCode && responseBody
      ? getErrorMessage(statusCode, responseBody, providerName)
      : String(message || 'Android 原生网络请求失败');
    pending.reject(new Error(detail));
  };
  window.__aiChatNativeHttpCancelled = requestId => {
    const pending = nativeHttpRequests.get(requestId);
    if (!pending) return;
    const error = new DOMException('请求已中止', 'AbortError');
    error.partial = pending.accumulator.partial();
    pending.reject(error);
  };
}

function requestNativeStreaming(request, ac, cb) {
  installNativeHttpCallbacks();
  const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const accumulator = createStreamAccumulator(request, cb);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      ac.signal.removeEventListener('abort', handleAbort);
      nativeHttpRequests.delete(requestId);
    };
    const settle = callback => value => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const complete = settle(resolve);
    const fail = settle(reject);
    const handleAbort = () => {
      try { window.AndroidHttp.cancel(requestId); } catch { /* Bridge may already be detached. */ }
      const error = new DOMException('请求已中止', 'AbortError');
      error.partial = accumulator.partial();
      fail(error);
    };
    nativeHttpRequests.set(requestId, {
      request,
      accumulator,
      status: 0,
      headersJson: '{}',
      resolve: complete,
      reject: fail,
    });
    ac.signal.addEventListener('abort', handleAbort, { once: true });
    if (ac.signal.aborted) {
      handleAbort();
      return;
    }
    try {
      window.AndroidHttp.start(requestId, JSON.stringify({
        url: request.targetUrl,
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        connectTimeoutMs: 30000,
        readTimeoutMs: 600000,
      }));
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * 流式请求 + 自动重试。两类「可恢复失败」会自动重试：
 *   1. 服务端报「参数不支持」→ 摘下被点名的参数（max_tokens 优先改名为
 *      max_completion_tokens），覆盖模型名识别不到的中转站与将来新模型；
 *   2. 瞬时网络故障（Failed to fetch / 连接超时 / 代理 502）→ 退避后重试，
 *      海外中转站线路抖动时这一类非常常见。
 *
 * 两种重试都只在「一个字都没流出来」时进行，避免把上一次的半截内容重复写进会话。
 *
 * @param {Object} request  buildRequest 的产物（body 会被就地修改）
 * @param {Object} options  { adjustments, hasStreamed, requestId, requestKind, channel }
 * @returns {Promise<Object>} 与 requestStreaming 相同的返回值
 */
export async function requestStreamingWithRetry(request, cfg, ac, cb, options = {}) {
  const adjustments = Array.isArray(options.adjustments) ? options.adjustments : [];
  const hasStreamed = typeof options.hasStreamed === 'function' ? options.hasStreamed : () => false;
  let networkRetries = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestStreaming(request, cfg, ac, cb);
    } catch (error) {
      if (error?.name === 'AbortError' || ac?.signal?.aborted) throw error;
      const partial = error.partial || {};
      if (String(partial.contentText || '').trim() || String(partial.thinkText || '').trim()) throw error;
      if (hasStreamed()) throw error;

      const plan = attempt < MAX_SAMPLING_FALLBACK_STEPS ? planSamplingFallback(request.body, error.message) : null;
      if (plan && applySamplingFallback(request, plan)) {
        const label = describeSamplingFallback(plan);
        adjustments.push(label);
        logEvent('request', 'chat_sampling_param_adjusted', {
          requestId: options.requestId, requestKind: options.requestKind, channel: options.channel,
          model: request.model, action: plan.action, parameter: label, attempt: attempt + 1,
          reason: String(error.message || '').slice(0, 300),
        }, `模型不支持 ${label}，已自动调整后重试`, {
          direction: 'outbound', provider: request.provider, request: request.logRequest,
        });
        continue;
      }

      if (networkRetries < MAX_NETWORK_RETRIES && isTransientNetworkError(error)) {
        const delay = NETWORK_RETRY_DELAYS_MS[networkRetries] ?? NETWORK_RETRY_DELAYS_MS[NETWORK_RETRY_DELAYS_MS.length - 1];
        networkRetries += 1;
        logEvent('request', 'chat_network_retry', {
          requestId: options.requestId, requestKind: options.requestKind, channel: options.channel,
          model: request.model, retry: networkRetries, delayMs: delay,
          reason: String(error.message || '').slice(0, 300),
        }, `网络请求失败，${delay}ms 后自动重试（第 ${networkRetries} 次）`, {
          direction: 'outbound', provider: request.provider,
        });
        await sleepWithAbort(delay, ac);
        continue;
      }

      throw error;
    }
  }
}

async function requestStreaming(request, cfg, ac, cb) {
  if (hasNativeHttpBridge()) return requestNativeStreaming(request, ac, cb);
  const useProxy = !!cfg.useProxy;
  const fetchOptions = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: request.targetUrl,
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    }),
    signal: ac.signal,
  };
  const directOptions = {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: ac.signal,
  };
  let resp;
  try {
    resp = await fetch(useProxy ? getProxyEndpoint(cfg) : request.targetUrl, useProxy ? fetchOptions : directOptions);
  } catch (error) {
    // 浏览器只会给出 "Failed to fetch"，这里补上目标地址与可操作建议
    throw decorateNetworkError(error, request, useProxy);
  }
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(getErrorMessage(resp.status, errorText, request.provider === 'gemini' ? 'Gemini API' : 'API'));
  }

  if (!resp.body) throw new Error('API 没有返回可读取的流式内容');
  const accumulator = createStreamAccumulator(request, cb);
  const responseHeaders = {};
  resp.headers.forEach((value, name) => { responseHeaders[name] = value; });
  accumulator.setResponseInfo(resp.status, responseHeaders);
  try {
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulator.append(value);
    }
    return accumulator.finish();
  } catch (error) {
    if (error.name === 'AbortError') error.partial = accumulator.partial();
    throw error;
  }
}

function validateConfig(cfg, cb) {
  if (!cfg || !cfg.key) {
    cb.onError('请先在设置中配置 API Key');
    return false;
  }
  if (!cfg.url && !isGeminiConfig(cfg)) {
    cb.onError('请先在设置中配置 API 地址');
    return false;
  }
  return true;
}

/**
 * Stream a main chat or creative-workbench request.
 * @param {string} currentModel
 * @param {AbortController} ac
 * @param {Object} cb
 */
export async function sendMessage(currentModel, ac, cb, chatParams = {}, options = {}) {
  const cfg = getActiveConfig();
  if (!validateConfig(cfg, cb)) return { status: 'invalid-config', contentText: '', thinkText: '' };
  const logChannel = options.logChannel || 'main';
  const logLabel = options.logLabel || (logChannel === 'agent' ? '创作工作台模型请求' : '正文模型请求');
  const requestKind = options.requestKind || (logChannel === 'agent' ? 'agent' : 'send');
  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const requestStartedAt = Date.now();

  let conv = getActiveConv();
  if (!conv) conv = createConversation(true);
  const sourceMessages = Array.isArray(options.requestMessages) ? options.requestMessages : getActiveMessages();
  const apiMessages = sourceMessages.map(message => ({
    role: message.role === 'ai' ? 'assistant' : message.role,
    content: message.content,
  }));
  const systemMessages = [];
  if (options.includeSystemPrompt !== false && chatParams.systemPromptEnabled && chatParams.systemPrompt?.trim()) {
    systemMessages.push(chatParams.systemPrompt.trim());
  }
  const additionalSystemInstructions = Array.isArray(options.additionalSystemInstruction)
    ? options.additionalSystemInstruction
    : [options.additionalSystemInstruction];
  additionalSystemInstructions
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .forEach(content => systemMessages.push(content));
  if (systemMessages.length) {
    apiMessages.unshift(...systemMessages.map(content => ({ role: 'system', content })));
  }
  if (options.instruction) apiMessages.push({ role: 'user', content: options.instruction });

  const request = buildRequest(cfg, currentModel, apiMessages, chatParams);
  const shouldPersistMainResult = options.persistResult !== false && !Number.isInteger(options.reviseIndex);
  const conversationId = options.conversationId || conv.id;
  const streamMessageIndex = shouldPersistMainResult
    ? createIncompleteAiMessage(conversationId)
    : -1;
  let streamedContentText = '';
  let streamedThinkText = '';
  const persistStream = (incomplete, skipNormalize = false) => {
    if (streamMessageIndex < 0) return;
    updateAiMessageAt(streamMessageIndex, streamedContentText, streamedThinkText || null, {
      conversationId,
      incomplete,
      clearReasoning: !streamedThinkText,
      skipNormalize,
    });
  };
  const streamCallbacks = {
    ...cb,
    onThink(thinkText) {
      streamedThinkText = String(thinkText || '');
      cb.onThink?.(thinkText);
      persistStream(true, true);
    },
    onContent(contentText) {
      streamedContentText = String(contentText || '');
      cb.onContent?.(contentText);
      persistStream(true, true);
    },
    onDone(...args) {
      cb.onDone?.(...args);
    },
    onAbort(...args) {
      cb.onAbort?.(...args);
    },
    onError(...args) {
      cb.onError?.(...args);
    },
  };
  const useNativeHttp = hasNativeHttpBridge();
  const useProxy = !useNativeHttp && !!cfg.useProxy;
  const startedLog = logEvent('request', 'chat_completion_started', {
    requestId, requestKind, channel: logChannel, provider: request.provider, model: request.model,
    messageCount: apiMessages.length, useProxy, useNativeHttp,
    temperature: (request.provider === 'gemini' ? request.body.generationConfig.temperature : request.body.temperature) ?? null,
    topP: (request.provider === 'gemini' ? request.body.generationConfig.topP : request.body.top_p) ?? null,
    samplingOmitted: request.omitSampling === true,
    requestMessageCount: sourceMessages.length,
  }, `开始${logLabel}` + (useNativeHttp ? ' (Android 原生网络)' : useProxy ? ' (通过代理)' : ''), {
    direction: 'outbound', provider: request.provider, request: request.logRequest,
  });

  // 本次请求中因服务端不接受而被摘除/改名的参数
  const samplingFallbacks = [];
  try {
    const result = await requestStreamingWithRetry(request, cfg, ac, streamCallbacks, {
      requestId, requestKind, channel: logChannel,
      adjustments: samplingFallbacks,
      hasStreamed: () => !!String(streamedContentText).trim() || !!String(streamedThinkText).trim(),
    });
    if (Number.isInteger(options.reviseIndex)) {
      addAiVersion(options.reviseIndex, result.contentText, result.thinkText || null);
    } else if (shouldPersistMainResult && streamMessageIndex >= 0) {
      streamedContentText = result.contentText;
      streamedThinkText = result.thinkText || '';
      persistStream(false);
    } else if (options.persistResult !== false) {
      addAiMessage(result.contentText, result.thinkText || null, { conversationId });
    }
    const finishedLog = await updateLog(startedLog.id, {
      event: 'chat_completion_finished',
      message: `${logLabel}完成`,
      details: {
        requestId, requestKind, channel: logChannel, provider: request.provider, model: request.model,
        outputLength: result.contentText.length, reasoningLength: result.thinkText.length,
        durationMs: Date.now() - requestStartedAt,
        usage: result.usage,
        diagnostics: result.diagnostics,
        samplingFallbacks: samplingFallbacks.length ? samplingFallbacks : undefined,
        persistence: options.persistResult === false ? 'caller-managed' : 'conversation-message',
      },
      payload: {
        response: { content: result.contentText, reasoning: result.thinkText || null, completionState: 'completed', finishReasons: result.diagnostics?.finishReasons || [], usage: result.usage },
      },
    });
    if (!finishedLog) {
      logEvent('request', 'chat_completion_finished', {
        requestId, requestKind, channel: logChannel, provider: request.provider, model: request.model,
        outputLength: result.contentText.length, reasoningLength: result.thinkText.length,
        durationMs: Date.now() - requestStartedAt, usage: result.usage, diagnostics: result.diagnostics,
      }, `${logLabel}完成`, { direction: 'inbound', provider: request.provider, response: { content: result.contentText, reasoning: result.thinkText || null, completionState: 'completed', usage: result.usage } });
    }
    cb.onDone(result.thinkText, result.contentText);
    return { status: 'success', ...result };
  } catch (err) {
    if (err.name === 'AbortError') {
      if (shouldPersistMainResult && streamMessageIndex >= 0) {
        streamedContentText = err.partial?.contentText || streamedContentText;
        streamedThinkText = err.partial?.thinkText || streamedThinkText;
        persistStream(true);
      } else if (options.persistResult !== false) {
        addAiMessage(err.partial?.contentText || '', err.partial?.thinkText || null, {
          conversationId,
          incomplete: true,
        });
      }
      const partial = err.partial || { contentText: streamedContentText, thinkText: streamedThinkText };
      const abortedLog = await updateLog(startedLog.id, {
        event: 'chat_completion_aborted',
        message: `${logLabel}已中止`,
        details: {
          requestId, requestKind, channel: logChannel, provider: request.provider, model: request.model,
          outputLength: String(partial.contentText || '').length,
          reasoningLength: String(partial.thinkText || '').length,
          durationMs: Date.now() - requestStartedAt,
          diagnostics: err.diagnostics || null,
        },
        payload: { response: { content: partial.contentText || '', reasoning: partial.thinkText || null, completionState: 'aborted', error: err.message } },
      });
      if (!abortedLog) logEvent('request', 'chat_completion_aborted', { requestId, requestKind, channel: logChannel, outputLength: String(partial.contentText || '').length }, `${logLabel}已中止`, { response: { content: partial.contentText || '', completionState: 'aborted' } });
      cb.onAbort();
      return { status: 'aborted', contentText: partial.contentText || '', thinkText: partial.thinkText || '' };
    }
    if (streamMessageIndex >= 0 && !streamedContentText.trim()) {
      removeAiMessageAt(streamMessageIndex, conversationId);
    }
    const partial = err.partial || { contentText: streamedContentText, thinkText: streamedThinkText };
    const failureMessage = decorateSamplingError(err.message, request);
    const errorLog = await updateLog(startedLog.id, {
      event: 'chat_completion_error',
      message: failureMessage,
      details: {
        requestId, requestKind, channel: logChannel, provider: request.provider, model: request.model,
        code: err.code || 'request_error', durationMs: Date.now() - requestStartedAt,
        outputLength: String(partial.contentText || '').length,
        reasoningLength: String(partial.thinkText || '').length,
        diagnostics: err.diagnostics || null,
        samplingFallbacks: samplingFallbacks.length ? samplingFallbacks : undefined,
      },
      payload: { response: { content: partial.contentText || '', reasoning: partial.thinkText || null, completionState: 'error', error: failureMessage } },
    });
    if (!errorLog) logEvent('error', 'chat_completion_error', { requestId, requestKind, channel: logChannel, code: err.code || 'request_error' }, failureMessage, { response: { content: partial.contentText || '', completionState: 'error', error: failureMessage } });
    cb.onError(failureMessage);
    return { status: 'error', error: failureMessage, contentText: '', thinkText: '' };
  }
}

/**
 * Stream a side discussion about the current conversation without writing it
 * into the story chat.
 */
export async function sendDiscussionMessage(currentModel, ac, cb, chatParams = {}, options = {}) {
  const cfg = getActiveConfig();
  if (!validateConfig(cfg, cb)) return;

  const conversationId = options.conversationId || getActiveConv()?.id;
  const storyMessages = getActiveMessages(conversationId).map(message => ({
    role: message.role === 'ai' ? 'assistant' : message.role,
    content: message.content,
  }));
  const discussionMessages = getDiscussionMessages(conversationId).map(message => ({
    role: message.role === 'ai' ? 'assistant' : message.role,
    content: message.content,
  }));
  if (Number.isInteger(options.regenerateIndex)) {
    const target = discussionMessages[options.regenerateIndex];
    if (target?.role === 'assistant') discussionMessages.splice(options.regenerateIndex);
  }

  const discussionSystemPrompt = '你是小说创作讨论伙伴。请基于下面的小说对话内容，与用户讨论剧情、人物、设定、情绪、逻辑或阅读感受。不要把讨论内容当作小说正文续写，除非用户明确要求。小说对话内容如下：\n\n' + (storyMessages.length ? storyMessages.map(message => `${message.role === 'assistant' ? 'AI' : '用户'}：${message.content}`).join('\n\n') : '（当前小说对话还没有内容）');
  const apiMessages = [{
    role: 'system',
    content: chatParams.systemPromptEnabled && chatParams.systemPrompt?.trim()
      ? chatParams.systemPrompt.trim() + '\n\n' + discussionSystemPrompt
      : discussionSystemPrompt,
  }, ...discussionMessages];
  const request = buildRequest(cfg, currentModel, apiMessages, chatParams);

  const useNativeHttp = hasNativeHttpBridge();
  const useProxy = !useNativeHttp && !!cfg.useProxy;
  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedLog = logEvent('request', 'chat_completion_started', {
    requestId, requestKind: 'discussion', channel: 'discussion', provider: request.provider, model: request.model,
    messageCount: apiMessages.length, useProxy, useNativeHttp,
  }, '开始讨论模型请求' + (useNativeHttp ? ' (Android 原生网络)' : useProxy ? ' (通过代理)' : ''), {
    direction: 'outbound', provider: request.provider, request: request.logRequest,
  });

  // 讨论链路同样需要采样参数降级；用包装后的回调跟踪是否已经流出内容
  let discussionStreamed = false;
  const discussionCb = {
    ...cb,
    onThink(think) { if (String(think || '').trim()) discussionStreamed = true; cb.onThink?.(think); },
    onContent(content) { if (String(content || '').trim()) discussionStreamed = true; cb.onContent?.(content); },
  };
  const samplingFallbacks = [];
  try {
    const result = await requestStreamingWithRetry(request, cfg, ac, discussionCb, {
      requestId, requestKind: 'discussion', channel: 'discussion',
      adjustments: samplingFallbacks,
      hasStreamed: () => discussionStreamed,
    });
    if (Number.isInteger(options.regenerateIndex)) {
      const updated = updateDiscussionMessage(options.regenerateIndex, result.contentText, result.thinkText || null, conversationId);
      if (updated) truncateDiscussionAfter(options.regenerateIndex + 1, conversationId);
    } else addDiscussionMessage('ai', result.contentText, result.thinkText || null, conversationId);
    await updateLog(startedLog.id, {
      event: 'chat_completion_finished',
      message: '讨论模型请求完成',
      details: {
        requestId, requestKind: 'discussion', channel: 'discussion', provider: request.provider, model: request.model,
        outputLength: result.contentText.length, usage: result.usage, diagnostics: result.diagnostics,
      },
      payload: { response: { content: result.contentText, reasoning: result.thinkText || null, completionState: 'completed', finishReasons: result.diagnostics?.finishReasons || [], usage: result.usage } },
    });
    cb.onDone(result.thinkText, result.contentText);
  } catch (err) {
    if (err.name === 'AbortError') {
      const partial = err.partial || { contentText: '', thinkText: '' };
      if (partial.contentText?.trim()) {
        if (Number.isInteger(options.regenerateIndex)) {
          const updated = updateDiscussionMessage(options.regenerateIndex, partial.contentText + '\n\n[已停止生成]', partial.thinkText || null, conversationId);
          if (updated) truncateDiscussionAfter(options.regenerateIndex + 1, conversationId);
        } else addDiscussionMessage('ai', partial.contentText + '\n\n[已停止生成]', partial.thinkText || null, conversationId);
      }
      await updateLog(startedLog.id, {
        event: 'chat_completion_aborted',
        message: '讨论模型请求已中止',
        details: { requestId, requestKind: 'discussion', channel: 'discussion', provider: request.provider, model: request.model, outputLength: String(partial.contentText || '').length, diagnostics: err.diagnostics || null },
        payload: { response: { content: partial.contentText || '', reasoning: partial.thinkText || null, completionState: 'aborted', error: err.message } },
      });
      cb.onAbort();
    } else {
      const partial = err.partial || { contentText: '', thinkText: '' };
      const failureMessage = decorateSamplingError(err.message, request);
      await updateLog(startedLog.id, {
        event: 'chat_completion_error',
        message: failureMessage,
        details: { requestId, requestKind: 'discussion', channel: 'discussion', provider: request.provider, model: request.model, code: err.code || 'request_error', diagnostics: err.diagnostics || null, samplingFallbacks: samplingFallbacks.length ? samplingFallbacks : undefined },
        payload: { response: { content: partial.contentText || '', reasoning: partial.thinkText || null, completionState: 'error', error: failureMessage } },
      });
      cb.onError(failureMessage);
    }
  }
}
