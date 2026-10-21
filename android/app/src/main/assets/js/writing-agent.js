import { getActiveConv, getActiveMessages, getWritingAgentState, updateWritingAgentState } from './conversation-manager.js';
import { sendMessage } from './chat-engine.js?v=6';

const EXTRACTION_CATEGORIES = [
  { key: 'facts', label: '人物与事实' },
  { key: 'plot', label: '剧情事件' },
  { key: 'foreshadowing', label: '伏笔' },
  { key: 'plans', label: '后续计划' },
  { key: 'conflicts', label: '疑似冲突 / 待核对' },
];

function visibleMessages(limit = 24) {
  const messages = getActiveMessages();
  const normalizedLimit = Number(limit);
  return normalizedLimit === 0 ? messages : messages.slice(-normalizedLimit);
}

function writingContextMessages() {
  return visibleMessages(getWritingAgentState().contextMessageLimit);
}

const WORLDVIEW_USAGE_RULES = '使用原则：以上资料只作为背景参考与一致性约束，不要擅自改变其中的明确规则和事实。不要在正文中刻意罗列、介绍、解释或展示设定，也不要复述作品记忆里的事实；只有当前剧情直接涉及相关内容时才自然引用。每个段落（尤其文章和章节的开头）直接从具体场景、动作、人物对话或心理活动切入，不要先铺垫设定背景。';

function makeWorldviewPrompt(worldview) {
  return worldview?.trim()
    ? `世界观设定（背景参考与一致性约束）：\n${worldview.trim()}\n\n${WORLDVIEW_USAGE_RULES}`
    : '当前没有已确认的独立世界观设定。';
}

function makeMemoryPrompt(memory) {
  return memory?.trim() ? `作品记忆（只把其中明确内容当作事实）：\n${memory.trim()}` : '当前没有已确认的作品记忆。';
}

function makeDirectivesPrompt(directives) {
  const active = (Array.isArray(directives) ? directives : []).filter(item => item && item.active !== false && item.text?.trim());
  if (!active.length) return '';
  return `作者启用的长期写作规则。以下规则用于约束本次创作的整体行文、结构与细节，属于明确要求：\n${active.map((item, index) => `${index + 1}. ${item.text.trim()}`).join('\n')}`;
}

function customPrompt(key) {
  const state = getWritingAgentState();
  return String(state.promptAdditions?.[key] || '').trim();
}

function makeAdvancedSystemPrompt(key) {
  const addition = customPrompt(key);
  return addition
    ? `作者为当前环节设置的高级系统提示词。执行本环节时必须遵守：\n${addition}`
    : '';
}

function makeStyleTemplatesSystemPrompt() {
  const templates = (getWritingAgentState().promptTemplates || [])
    .filter(item => item.active !== false && item.text?.trim())
    .map((item, index) => `${index + 1}. ${item.text.trim()}`);
  return templates.length
    ? `作者启用的正文风格范例。以下片段仅用于学习作者的写作风格（句式、节奏、用词、叙事视角与描写习惯），据此模仿其文风创作全新内容。不要延续片段中的剧情、人物或场景，不要直接引用或改写片段原文，不要复述片段内容。\n\n${templates.join('\n\n')}`
    : '';
}

function joinPromptSections(...sections) {
  return sections.map(value => String(value || '').trim()).filter(Boolean).join('\n\n');
}

export function getAgentPromptSettings() {
  const state = getWritingAgentState();
  return { additions: { ...(state.promptAdditions || {}) }, templates: Array.isArray(state.promptTemplates) ? [...state.promptTemplates] : [] };
}

export function updateAgentPrompt(key, text) {
  const state = getWritingAgentState();
  const additions = { ...(state.promptAdditions || {}) };
  if (String(text || '').trim()) additions[key] = String(text).trim();
  else delete additions[key];
  return updateWritingAgentState({ promptAdditions: additions });
}

export function addPromptTemplate(name, text) {
  const value = String(text || '').trim();
  if (!value) return getWritingAgentState();
  const state = getWritingAgentState();
  const templates = [...(state.promptTemplates || []), { id: `prompt-${Date.now().toString(36)}`, name: String(name || '未命名模板').trim().slice(0, 80), text: value, active: true, createdAt: Date.now() }];
  return updateWritingAgentState({ promptTemplates: templates });
}

export function removePromptTemplate(id) {
  const state = getWritingAgentState();
  return updateWritingAgentState({ promptTemplates: (state.promptTemplates || []).filter(item => item.id !== id) });
}

export function togglePromptTemplate(id, active) {
  const state = getWritingAgentState();
  return updateWritingAgentState({ promptTemplates: (state.promptTemplates || []).map(item => item.id === id ? { ...item, active } : item) });
}

export function getAgentContext() {
  const state = getWritingAgentState();
  return `${makeWorldviewPrompt(state.worldview)}\n\n${makeMemoryPrompt(state.memory)}`;
}

export function buildMainCreationSystemInstruction() {
  const state = getWritingAgentState();
  const sections = [];
  if (state.applyWorldviewToMain && state.worldview?.trim()) sections.push(makeWorldviewPrompt(state.worldview));
  if (state.applyMemoryToMain && state.memory?.trim()) sections.push(makeMemoryPrompt(state.memory));
  if (!sections.length) return '';
  return `以下是作者为当前作品确认的创作资料，只作为背景参考与一致性约束。生成、重新生成、修订或继续小说正文时不得擅自改变其中的明确规则和事实，也不得在正文中刻意罗列或介绍这些设定；只有当前剧情直接涉及相关内容时才自然引用。若当前用户要求与资料存在无法消解的冲突，优先遵守用户本次明确要求，但不要默默篡改资料。\n\n${sections.join('\n\n')}`;
}

export function buildWritingSystemInstruction() {
  return joinPromptSections(
    '你是小说写作协作助手。创作时必须遵守作者提供的世界观、作品记忆、当前环节高级系统提示词和已启用的风格系统模板，不要擅自改写其中的明确规则与事实。作者本次任务与高级系统提示词属于明确要求，优先级高于通用输出习惯。通常只输出可直接用于作品的内容，不要自行添加标题、前言、解释或分析过程；但如果作者本次任务、高级系统提示词或风格系统模板明确要求标题、总结、附录或其他结构，必须按要求输出，不得用“只输出正文”等通用限制忽略它。',
    getAgentContext(),
    makeAdvancedSystemPrompt('generate'),
    makeStyleTemplatesSystemPrompt(),
  );
}

export function buildWritingInstruction(userText = '') {
  const state = getWritingAgentState();
  const task = userText.trim() || '请自然承接当前正文继续创作。';
  return joinPromptSections(
    `本次写作任务：\n${task}`,
    makeDirectivesPrompt(state.directives),
  );
}

export function buildWritingContextInstruction() {
  return buildWritingSystemInstruction();
}

export function buildDraftReviewSystemInstruction() {
  return joinPromptSections(
    '你是小说草稿校对助手。请依据现有正文和下面的创作资料检查草稿，尤其核对人物身份与关系、世界观规则、时间线、叙事视角、已埋伏笔、作者提供的长期写作规则，以及草稿是否真正完成本次任务。只输出简洁、可执行的检查结论；没有明显问题时直接说明“未发现明确冲突”。不要改写草稿，不要创作新正文，不要修改作品记忆。',
    getAgentContext(),
    makeAdvancedSystemPrompt('preflight'),
  );
}

export function buildDraftReviewPrompt(draftText, userText = '') {
  const state = getWritingAgentState();
  const task = userText.trim() || '自然承接当前正文继续创作。';
  return joinPromptSections(
    `本次续写任务：\n${task}`,
    makeDirectivesPrompt(state.directives),
    `当前续写草稿：\n${String(draftText || '').trim()}`,
  );
}

// Keep the old export name for compatibility with older imports and prompt settings.
export const buildPreflightPrompt = (userText = '') => buildDraftReviewPrompt('', userText);

export function buildExtractionPrompt(generatedText) {
  const state = getWritingAgentState();
  const base = `你是小说作品记忆整理助手。请仅从“当前续写草稿”中整理待作者确认的高价值记忆候选。只保留会影响后续创作的明确新信息：新人物或关键关系变化、不可逆剧情转折、明确伏笔、明确长期计划、与已有资料的疑似冲突。稳定世界规则、地理、历史背景、势力设定和力量体系应归入世界观，不要重复写入作品记忆；如果草稿出现新的稳定规则，请放入 conflicts 并标注“建议更新世界观”。不要提取普通动作、气氛描写、临时对话和无后续影响的细节，不要推测草稿未明确表达的内容。每类最多 3 条，没有内容就返回空数组。只输出 JSON，不要输出说明、Markdown 或正文。JSON 格式：{"facts":["..."],"plot":["..."],"foreshadowing":["..."],"plans":["..."],"conflicts":["..."]}。\n\n${makeWorldviewPrompt(state.worldview)}\n\n${makeMemoryPrompt(state.memory)}\n\n当前续写草稿：\n${generatedText}`;
  return base;
}

export function buildMemoryRevisionPrompt(userText, operation = '补充指定内容') {
  const state = getWritingAgentState();
  const base = `你是小说作品记忆编辑助手。请严格按照作者本次要求，对“当前作品记忆”进行${operation}，并输出一份可直接替换原内容的完整作品记忆 Markdown。作者没有指明的内容必须原样保留，不要自行扩写、推测、概括或顺手修改。若作者要求补充，就只补充其明确指定的信息；若要求修改或删除，就只处理指定项目。稳定世界规则、地理、历史背景、势力设定和力量体系原则上属于世界观：如果作者要求添加的内容明显属于世界观，不要擅自写入作品记忆，请在对应位置保留一句“待核对：此项更适合加入世界观”，但仍尊重作者明确要求。不要输出分析过程、说明或代码围栏，只输出完整修改稿。\n\n${makeWorldviewPrompt(state.worldview)}\n\n当前作品记忆：\n${state.memory?.trim() || '# 作品记忆\n'}\n\n作者本次要求：\n${String(userText || '').trim()}`;
  return base;
}

// Compatibility alias retained for old prompt settings and imports.
export const buildManualMemoryPrompt = buildMemoryRevisionPrompt;

export function buildWorldviewPrompt(userText, operation = '整理') {
  const state = getWritingAgentState();
  const base = `你是小说世界观资料整理助手。请根据作者的要求，对下面的世界观资料进行${operation}。可以在明确合理的范围内重新分类、合并重复内容、改写表达、删除作者要求删除的内容、补充有助于自洽的设定；但不要把推测内容伪装成作者已确认的事实。对新增或推测内容必须标记为“建议补充”，对无法确认或可能冲突的内容标记为“待核对”。请用中文，输出适合作者直接查看和继续编辑的 Markdown，不要输出分析过程。\n\n当前世界观资料：\n${makeWorldviewPrompt(state.worldview)}\n\n作者本次整理要求：\n${String(userText || '').trim() || '请整理当前世界观，合并重复内容，补充明显缺失的基础规则，并标记所有建议补充和待核对内容。'}`;
  return base;
}

export function addDirective(text) {
  const value = String(text || '').trim();
  if (!value) return getWritingAgentState();
  const state = getWritingAgentState();
  return updateWritingAgentState({ directives: [...state.directives, { id: `directive-${Date.now().toString(36)}`, text: value, active: true, createdAt: Date.now() }] });
}

export function toggleDirective(id, active) {
  const state = getWritingAgentState();
  return updateWritingAgentState({ directives: state.directives.map(item => item.id === id ? { ...item, active } : item) });
}

export function removeDirective(id) {
  const state = getWritingAgentState();
  return updateWritingAgentState({ directives: state.directives.filter(item => item.id !== id) });
}

export function replaceMemory(memory) {
  return updateWritingAgentState({ memory: String(memory || '') });
}

export function addSuggestions(suggestions) {
  const state = getWritingAgentState();
  return updateWritingAgentState({ suggestions: [...state.suggestions, { id: `suggestion-${Date.now().toString(36)}`, createdAt: Date.now(), ...suggestions }] });
}

export function parseExtractionResult(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\\s*([\\s\\S]*?)\\s*```/i);
  const candidates = [fenced?.[1], raw].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const result = {};
      for (const { key } of EXTRACTION_CATEGORIES) {
        result[key] = Array.isArray(parsed?.[key])
          ? parsed[key].map(item => String(item || '').trim()).filter(Boolean)
          : [];
      }
      return result;
    } catch {
      // Some gateways add a short preamble. Try the outermost JSON object.
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start < 0 || end <= start) continue;
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        const result = {};
        for (const { key } of EXTRACTION_CATEGORIES) {
          result[key] = Array.isArray(parsed?.[key])
            ? parsed[key].map(item => String(item || '').trim()).filter(Boolean)
            : [];
        }
        return result;
      } catch {
        // Continue to the next candidate.
      }
    }
  }
  return null;
}

export function extractionCategories() {
  return EXTRACTION_CATEGORIES.map(item => ({ ...item }));
}

function normalizeMemoryItem(value) {
  return String(value || '')
    // 兼容模型输出的字面量 /n、\\n，以及不同平台的换行符。
    .replace(/(?:\\\\n|\/n|\r\n?|\n)+/g, '\n')
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function mergeExtractionIntoMemory(memory, extraction, selected = {}) {
  const base = String(memory || '').trimEnd();
  const sections = [];
  for (const { key, label } of EXTRACTION_CATEGORIES) {
    const values = (extraction?.[key] || [])
      .filter((_, index) => selected[`${key}:${index}`] !== false)
      .flatMap(normalizeMemoryItem);
    if (values.length) sections.push(`## ${label}\n${values.map(value => `- ${value}`).join('\n')}`);
  }
  if (!sections.length) return base;
  const stamp = new Date().toLocaleDateString('zh-CN');
  return `${base}${base ? '\n\n' : ''}# 作品记忆更新记录（${stamp}）\n\n${sections.join('\n\n')}`;
}

export async function generateAgentText(model, ac, callbacks, chatParams, userText = '') {
  const requestMessages = writingContextMessages();
  return sendMessage(model, ac, callbacks, chatParams, {
    requestMessages,
    additionalSystemInstruction: buildWritingSystemInstruction(),
    instruction: buildWritingInstruction(userText),
    persistResult: false,
    includeSystemPrompt: false,
    logChannel: 'agent',
    logLabel: '创作工作台草稿生成请求',
  });
}

export async function reviewAgentDraft(model, ac, callbacks, chatParams, draftText, userText = '') {
  return sendMessage(model, ac, callbacks, chatParams, {
    requestMessages: writingContextMessages(),
    additionalSystemInstruction: buildDraftReviewSystemInstruction(),
    instruction: buildDraftReviewPrompt(draftText, userText),
    persistResult: false,
    includeSystemPrompt: false,
    logChannel: 'agent',
    logLabel: '创作工作台草稿一致性检查请求',
  });
}

// Compatibility alias: old callers can still invoke runPreflight during migration.
export async function runPreflight(model, ac, callbacks, chatParams) {
  return reviewAgentDraft(model, ac, callbacks, chatParams, '', chatParams?.agentTask || '');
}

export function buildInitialMemoryPrompt() {
  const state = getWritingAgentState();
  const base = `请用中文回答。根据下面这部小说目前已经写出的正文，整理一份“待确认的初始作品记忆”。稳定的世界规则、地理、历史背景、势力设定和力量体系不要混入作品记忆；如果识别到这类内容，请在 conflicts 中标记“建议移入世界观”。不要创作新正文，不要把推测当成事实；无法确认的内容放入 conflicts。严格输出 JSON，格式为：{"facts":[],"plot":[],"foreshadowing":[],"plans":[],"conflicts":[]}。facts 只包含明确的人物、关系、身份、物品状态和持续事实；plot 包含已发生且影响后续的剧情；foreshadowing 包含明确埋下但未揭示的线索；plans 只填写正文中明确出现的后续计划；conflicts 填写不确定、可能矛盾、需作者核对或建议移入世界观的内容。\n\n${makeWorldviewPrompt(state.worldview)}\n\n${makeMemoryPrompt(state.memory)}\n\n现有正文：\n${visibleMessages(80).map(message => `${message.role === 'user' ? '作者' : '正文'}：\n${message.content || ''}`).join('\n\n')}`;
  return base;
}

export async function extractInitialMemory(model, ac, callbacks, chatParams) {
  return sendMessage(model, ac, callbacks, chatParams, {
    requestMessages: [],
    additionalSystemInstruction: makeAdvancedSystemPrompt('initial-memory'),
    instruction: buildInitialMemoryPrompt(),
    persistResult: false,
    includeSystemPrompt: false,
    logChannel: 'agent',
    logLabel: '创作工作台初始记忆整理请求',
  });
}

export async function reviseMemory(model, ac, callbacks, chatParams, userText, operation = '补充指定内容') {
  return sendMessage(model, ac, callbacks, chatParams, {
    requestMessages: [],
    additionalSystemInstruction: makeAdvancedSystemPrompt('manual-memory'),
    instruction: buildMemoryRevisionPrompt(userText, operation),
    persistResult: false,
    includeSystemPrompt: false,
    logChannel: 'agent',
    logLabel: '创作工作台定向修改作品记忆请求',
  });
}

// Compatibility alias retained for older callers.
export async function extractManualMemory(model, ac, callbacks, chatParams, userText) {
  return reviseMemory(model, ac, callbacks, chatParams, userText);
}

export async function organizeWorldview(model, ac, callbacks, chatParams, userText, operation = '整理') {
  return sendMessage(model, ac, callbacks, chatParams, {
    requestMessages: [],
    additionalSystemInstruction: makeAdvancedSystemPrompt('worldview'),
    instruction: buildWorldviewPrompt(userText, operation),
    persistResult: false,
    includeSystemPrompt: false,
    logChannel: 'agent',
    logLabel: '创作工作台世界观整理请求',
  });
}

export async function extractMemory(model, ac, callbacks, chatParams, generatedText) {
  return sendMessage(model, ac, callbacks, chatParams, {
    requestMessages: [],
    additionalSystemInstruction: makeAdvancedSystemPrompt('extract'),
    instruction: buildExtractionPrompt(generatedText),
    persistResult: false,
    includeSystemPrompt: false,
    logChannel: 'agent',
    logLabel: '创作工作台草稿记忆提取请求',
  });
}
