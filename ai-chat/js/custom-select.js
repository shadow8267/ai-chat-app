/**
 * 自定义下拉：接管原生 <select> 展开后的列表 UI。
 *
 * 为什么需要：原生 <select> 展开时用的是浏览器 / 系统的列表界面
 * （安卓 WebView 上直接是系统弹窗），与应用的视觉风格不一致 ——
 * 尤其是「API 类型」「数据中心顶部选择」这类显眼位置。
 *
 * 设计取舍：**不改动 DOM 结构与布局，只接管「弹出」这一个行为**。
 *   - 取消原生弹出：在 mousedown / touchstart 上 preventDefault
 *   - 弹层：一个挂在 <body> 末尾的 fixed 面板，应用风格渲染 options
 *   - value / change 语义完全保持原生（选中后设置 selectedIndex 并派发 change）
 *
 * 因此 select 的尺寸、样式、以及所有既有代码（renderConfigSelect、
 * renderDataCenter 等直接读写 select.value / selectedIndex 的地方）都无需改动。
 * 万一某个环境没能拦下原生弹出，行为退化为原样，不会比现在更糟。
 */
import { escapeHtml } from './constants.js';

let panel = null;
let activeSelect = null;
let lastTriggerAt = 0;

/** 面板挂在 body 末尾，只创建一次 */
function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement('div');
  panel.className = 'cs-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  // 阻止面板内的交互冒泡出去（否则会被外层弹窗的「点背景关闭」逻辑吃掉）
  panel.addEventListener('pointerdown', event => event.stopPropagation());
  panel.addEventListener('mousedown', event => event.stopPropagation());
  panel.addEventListener('click', event => {
    event.stopPropagation();
    const item = event.target.closest('.cs-option');
    if (item) selectOption(Number(item.dataset.index));
  });
  document.body.appendChild(panel);
  return panel;
}

function isEnhanceable(select) {
  return select
    && select.tagName === 'SELECT'
    && !select.multiple
    && Number(select.size || 0) <= 1
    && select.dataset.customSelect !== '1';
}

function openPanel(select) {
  const options = Array.from(select.options);
  if (!options.length) return;
  const target = ensurePanel();
  activeSelect = select;
  const selectedIndex = select.selectedIndex;
  target.innerHTML = options.map((option, index) => {
    const classes = ['cs-option'];
    if (index === selectedIndex) classes.push('is-selected');
    if (option.disabled) classes.push('is-disabled');
    // 选中项只用文字颜色 + 底色区分，不再在右侧画对勾
    return `<button type="button" class="${classes.join(' ')}" data-index="${index}" role="option" aria-selected="${index === selectedIndex}">`
      + `<span class="cs-option-text">${escapeHtml(option.label || option.textContent || '')}</span></button>`;
  }).join('');
  target.hidden = false;
  positionPanel(select);
  const current = target.querySelector('.is-selected');
  if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
}

function positionPanel(select) {
  const el = panel;
  const rect = select.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 6;
  const margin = 8;

  el.style.minWidth = `${Math.round(Math.min(Math.max(rect.width, 150), vw - margin * 2))}px`;
  el.style.maxWidth = `${Math.round(Math.min(vw - margin * 2, 460))}px`;

  const spaceBelow = vh - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
  const available = Math.max(120, openUp ? spaceAbove : spaceBelow);
  el.style.maxHeight = `${Math.round(Math.min(320, available))}px`;

  // 先归零再量尺寸，避免受上一次的位置影响
  el.style.top = '0px';
  el.style.left = '0px';
  const h = el.offsetHeight;
  const w = el.offsetWidth;
  // 上下都钳制进视口：触发器若贴在视口边缘（或本身已滚出可视区），
  // 也不能把面板丢到屏幕外。
  const rawTop = openUp ? rect.top - gap - h : rect.bottom + gap;
  const top = Math.max(margin, Math.min(vh - margin - h, rawTop));
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(Math.max(margin, Math.min(rect.left, vw - margin - w)))}px`;
}

function closePanel() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  panel.innerHTML = '';
  activeSelect = null;
}

function selectOption(index) {
  const select = activeSelect;
  if (!select) return;
  const option = select.options[index];
  if (!option || option.disabled) return;
  const changed = select.selectedIndex !== index;
  closePanel();
  if (!changed) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function toggle(select) {
  if (select.disabled) return;
  if (activeSelect === select && panel && !panel.hidden) {
    closePanel();
    return;
  }
  openPanel(select);
}

function onTrigger(event) {
  const select = event.currentTarget;
  // preventDefault 拦掉原生弹出：mousedown 是桌面/移动端真正触发下拉的默认动作，
  // touchstart 上拦则能顺带阻止后续合成的 mousedown。
  event.preventDefault();
  const now = Date.now();
  if (now - lastTriggerAt < 200) return;   // touchstart + 合成 mousedown 去重
  lastTriggerAt = now;
  toggle(select);
}

/** 安装到页面上所有单值 select */
export function installCustomSelects(root = document) {
  root.querySelectorAll('select').forEach(select => {
    if (!isEnhanceable(select)) return;
    select.dataset.customSelect = '1';
    select.classList.add('cs-select');
    select.addEventListener('mousedown', onTrigger);
    select.addEventListener('touchstart', onTrigger, { passive: false });
  });
}

/** 页面级监听：只挂一次 */
export function installCustomSelectDismissers() {
  document.addEventListener('pointerdown', event => {
    if (!panel || panel.hidden) return;
    if (panel.contains(event.target)) return;
    if (activeSelect && activeSelect.contains(event.target)) return;
    closePanel();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !panel || panel.hidden) return;
    event.preventDefault();
    closePanel();
  }, true);
  window.addEventListener('resize', closePanel);
  window.addEventListener('scroll', event => {
    if (panel && !panel.hidden && panel.contains(event.target)) return;   // 面板自己滚动时不要关
    closePanel();
  }, true);
}
