/**
 * BookmarkSorter - 视觉书签排序器
 *
 * 排序策略全部由 options 驱动（见 DEFAULT_OPTIONS），默认行为与原 2.1 版一致：
 * 视觉长度升序、书签在前文件夹在后、递归处理子文件夹。
 */

/* ------------------------------------------------------------------ *
 * 默认配置
 * ------------------------------------------------------------------ */

const DEFAULT_OPTIONS = {
  // 排序键：visual=视觉长度 / title=标题字典序 / domain=域名 / date=添加时间
  mode: "visual",
  // 排序方向：asc=短在前 / desc=长在前
  direction: "asc",
  // 分组：separate=书签与文件夹分成两块 / inline=混排
  groupStrategy: "separate",
  // 仅 separate 生效：true=文件夹在前，false=书签在前
  folderFirst: false,
  // 是否递归处理子文件夹
  recursive: true
};

const SNAPSHOT_LIMIT = 5; // 保留最近 N 份快照，避免连续排序后回不去
const LOCK_TTL = 5 * 60 * 1000; // 任务锁过期时间
const LOCK_KEY = "busyLock";

let inMemoryLock = false; // storage.session 不可用时的兜底

/* ------------------------------------------------------------------ *
 * 配置读写
 * ------------------------------------------------------------------ */

async function loadOptions() {
  try {
    const { options } = await chrome.storage.sync.get("options");
    return { ...DEFAULT_OPTIONS, ...(options || {}) };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

async function saveOptions(patch) {
  const next = { ...(await loadOptions()), ...(patch || {}) };
  await chrome.storage.sync.set({ options: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * 视觉长度
 * ------------------------------------------------------------------ */

let segmenter = null;
try {
  // 按字素簇切分，正确处理 emoji / 组合字符（Chrome 87+）
  segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
} catch {
  segmenter = null;
}

function toGraphemes(str) {
  if (!segmenter) return Array.from(str);
  return Array.from(segmenter.segment(str), s => s.segment);
}

/**
 * 视觉长度：去掉前后空格，汉字/全角算 2，ASCII 算 1
 */
function visualLength(str) {
  const clean = (str || "").trim();
  let len = 0;
  for (const ch of toGraphemes(clean)) {
    const code = ch.codePointAt(0);
    len += code <= 0x7f ? 1 : 2;
  }
  return len;
}

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: title,
    message: message,
    priority: 1
  });
}

function compareText(a, b) {
  // numeric: 让 "第2章" 排在 "第10章" 前面
  return String(a).localeCompare(String(b), "zh-CN", { numeric: true });
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * 比较器
 * ------------------------------------------------------------------ */

/**
 * 按模式生成主键
 */
function primaryKey(node, mode) {
  const title = (node.title || "").trim();
  switch (mode) {
    case "title":
      return title || node.url || "";
    case "domain":
      return node.url ? hostnameOf(node.url) : title;
    case "date":
      return node.dateAdded || 0;
    case "visual":
    default:
      return visualLength(title || node.url || "");
  }
}

function compareNodes(a, b, mode, direction) {
  const ka = primaryKey(a, mode);
  const kb = primaryKey(b, mode);

  let diff = 0;
  if (typeof ka === "number" && typeof kb === "number") {
    diff = ka - kb;
  } else {
    diff = compareText(ka, kb);
  }

  if (diff !== 0) return direction === "desc" ? -diff : diff;

  // 主键相同：短标题优先，再按标题字典序，保证结果稳定
  const va = visualLength(a.title);
  const vb = visualLength(b.title);
  if (va !== vb) return va - vb;

  const ta = compareText((a.title || "").trim(), (b.title || "").trim());
  if (ta !== 0) return ta;

  return compareText(a.id, b.id);
}

/**
 * 计算目标顺序：返回按策略排好的节点数组
 */
function buildOrderedList(nodes, options) {
  const { mode, direction, groupStrategy, folderFirst } = options;

  const cmp = (a, b) => compareNodes(a, b, mode, direction);

  if (groupStrategy === "inline") {
    return [...nodes].sort(cmp);
  }

  // separate：书签与文件夹各自成块
  const bookmarks = nodes.filter(n => n.url).sort(cmp);
  // 文件夹没有 URL，域名模式退化为标题序；其余模式用同一比较器
  const folders = nodes
    .filter(n => !n.url)
    .sort((a, b) => compareNodes(a, b, mode === "domain" ? "title" : mode, direction));

  return folderFirst ? [...folders, ...bookmarks] : [...bookmarks, ...folders];
}

/* ------------------------------------------------------------------ *
 * 任务锁（MV3 Service Worker 会被回收，锁不能只放内存）
 * ------------------------------------------------------------------ */

async function acquireLock() {
  if (inMemoryLock) return false;
  inMemoryLock = true;
  try {
    const { [LOCK_KEY]: lock } = await chrome.storage.session.get(LOCK_KEY);
    if (lock && Date.now() - lock < LOCK_TTL) {
      inMemoryLock = false;
      return false;
    }
    await chrome.storage.session.set({ [LOCK_KEY]: Date.now() });
    return true;
  } catch {
    // storage.session 不可用时退化为内存锁（至少挡住同一实例内的并发）
    return true;
  }
}

async function releaseLock() {
  inMemoryLock = false;
  try {
    await chrome.storage.session.remove(LOCK_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * 书签移动
 * ------------------------------------------------------------------ */

async function moveWithRetry(id, destination, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await chrome.bookmarks.move(id, destination);
      return;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(resolve => setTimeout(resolve, 100 * attempt));
    }
  }
}

/**
 * 求最长严格递增子序列的元素下标（这些元素相对顺序已正确，无需移动）
 */
function longestIncreasingSubsequence(values) {
  const tails = []; // tails[k] = 长度 k+1 的递增子序列末尾下标
  const prev = new Array(values.length).fill(-1);

  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }

  const result = new Set();
  let idx = tails.length ? tails[tails.length - 1] : -1;
  while (idx !== -1) {
    result.add(idx);
    idx = prev[idx];
  }
  return result;
}

/**
 * 将文件夹内节点重排为目标顺序。
 * 先用 LIS 找出已经相对有序的元素跳过，再从后往前插入其余元素，
 * 把 move 次数从 O(n) 降到 O(n - LIS)。已是目标顺序时 0 次移动。
 */
async function reorderFolder(folderId, orderedIds) {
  const children = await chrome.bookmarks.getChildren(folderId);
  const currentIds = children.map(n => n.id);
  const present = new Set(currentIds);

  // 只处理仍然存在的节点，忽略已被删除的
  const target = orderedIds.filter(id => present.has(id));
  if (target.length < 2) return;

  const posOf = new Map(currentIds.map((id, index) => [id, index]));
  const seq = target.map(id => posOf.get(id));
  const keep = longestIncreasingSubsequence(seq);

  // 从后往前移动，保证「i 之后已是最终顺序」的不变式
  for (let i = target.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    const id = target[i];

    let currentIndex;
    try {
      const [node] = await chrome.bookmarks.get(id);
      currentIndex = node.index;
    } catch {
      continue; // 并发删除，跳过
    }

    if (currentIndex !== i) {
      await moveWithRetry(id, { index: i });
    }
  }

  // 兜底校验：LIS 跳过在极端交错下理论上可能留下偏差
  const after = (await chrome.bookmarks.getChildren(folderId)).map(n => n.id);
  const expected = target.join(",");
  const actual = after.filter(id => target.includes(id)).join(",");
  if (expected !== actual) {
    console.warn("[SORT] LIS 重排存在偏差，回退到全量顺序移动");
    for (let i = 0; i < target.length; i++) {
      const [node] = await chrome.bookmarks.get(target[i]);
      if (node.index !== i) await moveWithRetry(target[i], { index: i });
    }
  }
}

/* ------------------------------------------------------------------ *
 * 递归排序
 * ------------------------------------------------------------------ */

async function sortFolderRecursive(folderId, folderName, options, depth = 0) {
  const children = await chrome.bookmarks.getChildren(folderId);
  if (!children || children.length === 0) return;

  console.log(`${"  ".repeat(depth)}[SORT] 正在整理: ${folderName} (${children.length} 个项目)`);

  const ordered = buildOrderedList(children, options);
  await reorderFolder(folderId, ordered.map(item => item.id));

  if (!options.recursive) return;

  for (const node of ordered) {
    if (!node.url) {
      await sortFolderRecursive(node.id, (node.title || "").trim(), options, depth + 1);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 快照（保留最近 N 份，可连续撤销）
 * ------------------------------------------------------------------ */

async function createSnapshot() {
  const folders = {};
  const [root] = await chrome.bookmarks.getTree();

  const walk = node => {
    if (!node.children) return;
    folders[node.id] = node.children.map(child => child.id);
    node.children.forEach(walk);
  };

  (root.children || []).forEach(walk);

  const { history = [] } = await chrome.storage.local.get("history");
  const next = [...history, { version: 1, timestamp: Date.now(), folders }];

  await chrome.storage.local.set({
    history: next.slice(-SNAPSHOT_LIMIT),
    // 兼容 2.1 的读取路径
    snapshot: next[next.length - 1]
  });

  await syncRestoreMenu();
  return next.length;
}

async function readSnapshot() {
  const { history } = await chrome.storage.local.get("history");
  if (Array.isArray(history) && history.length) {
    return history[history.length - 1];
  }
  // 从 2.1 升级上来的用户
  const { snapshot } = await chrome.storage.local.get("snapshot");
  return snapshot && snapshot.folders ? snapshot : null;
}

async function countSnapshots() {
  const { history } = await chrome.storage.local.get("history");
  if (Array.isArray(history) && history.length) return history.length;
  const snapshot = await readSnapshot();
  return snapshot ? 1 : 0;
}

async function popSnapshot() {
  const { history = [] } = await chrome.storage.local.get("history");
  if (!Array.isArray(history) || !history.length) return null;
  const snapshot = history[history.length - 1];
  const rest = history.slice(0, -1);
  await chrome.storage.local.set({ history: rest });
  await chrome.storage.local.remove("snapshot");
  await syncRestoreMenu();
  return snapshot;
}

/* ------------------------------------------------------------------ *
 * 根目录解析
 * ------------------------------------------------------------------ */

async function getRootNodes() {
  const [root] = await chrome.bookmarks.getTree();
  return (root && root.children) || [];
}

async function resolveRootNode(keywords, fallbackId) {
  const nodes = await getRootNodes();
  const found = nodes.find(node => node.title && keywords.some(k => node.title.includes(k)));
  if (found) return found;
  try {
    const [node] = await chrome.bookmarks.get(fallbackId);
    return node;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 入口：排序
 * ------------------------------------------------------------------ */

async function startSorting(rootNode = null) {
  if (!(await acquireLock())) {
    notify("正在处理", "已有排序/恢复任务进行中，请稍候。");
    return { ok: false, reason: "busy" };
  }

  try {
    const options = await loadOptions();
    await createSnapshot();

    if (rootNode) {
      await sortFolderRecursive(rootNode.id, (rootNode.title || "").trim(), options);
    } else {
      for (const node of await getRootNodes()) {
        await sortFolderRecursive(node.id, (node.title || "").trim(), options);
      }
    }

    const label = {
      visual: "视觉长度",
      title: "标题",
      domain: "域名",
      date: "添加时间"
    }[options.mode] || options.mode;

    notify("排序完成", `已按${label}${rootNode ? `整理「${rootNode.title}」` : "整理全部书签"}。`);
    return { ok: true };
  } catch (err) {
    console.error("排序出错:", err);
    notify("排序失败", err.message);
    return { ok: false, reason: err.message };
  } finally {
    await releaseLock();
  }
}

async function handleRootSort(keywords, fallbackId) {
  const node = await resolveRootNode(keywords, fallbackId);
  if (!node) {
    notify("排序失败", "未找到对应的书签根目录。");
    return;
  }
  await startSorting(node);
}

/* ------------------------------------------------------------------ *
 * 入口：恢复
 * ------------------------------------------------------------------ */

async function restoreSorting() {
  if (!(await acquireLock())) {
    notify("正在处理", "已有排序/恢复任务进行中，请稍候。");
    return { ok: false, reason: "busy" };
  }

  try {
    const snapshot = await readSnapshot();
    if (!snapshot || !snapshot.folders) {
      notify("无可恢复", "没有找到排序前的快照，请先执行一次排序。");
      return { ok: false, reason: "no-snapshot" };
    }

    let restored = 0;
    let skipped = 0;

    // 单个文件夹失败（已删除等）不应中断整个恢复流程
    for (const [folderId, orderedIds] of Object.entries(snapshot.folders)) {
      try {
        await reorderFolder(folderId, orderedIds);
        restored++;
      } catch (err) {
        console.warn(`[RESTORE] 跳过 ${folderId}: ${err.message}`);
        skipped++;
      }
    }

    await popSnapshot();

    const suffix = skipped ? `（跳过 ${skipped} 个失效文件夹）` : "";
    notify("恢复完成", `已恢复 ${restored} 个文件夹的顺序${suffix}。`);
    return { ok: true, restored, skipped };
  } catch (err) {
    console.error("恢复出错:", err);
    notify("恢复失败", err.message);
    return { ok: false, reason: err.message };
  } finally {
    await releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

const MENUS = [
  { id: "sort_all", title: "[全部] 递归排序所有书签" },
  { id: "sort_bar", title: "[书签栏] 递归排序" },
  { id: "sort_other", title: "[其他] 递归排序" },
  { id: "sep", type: "separator" },
  { id: "restore", title: "[恢复] 撤销上次排序" }
];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    MENUS.forEach(menu => {
      chrome.contextMenus.create({
        id: menu.id,
        title: menu.title,
        type: menu.type || "normal",
        // "all" 会让菜单出现在输入框、图片、链接上，干扰太大
        contexts: ["page"],
        documentUrlPatterns: undefined
      });
    });
    syncRestoreMenu();
  });
}

async function syncRestoreMenu() {
  try {
    const count = await countSnapshots();
    chrome.contextMenus.update("restore", {
      title: count ? `[恢复] 撤销上次排序（可撤销 ${count} 次）` : "[恢复] 撤销上次排序（暂无快照）",
      enabled: count > 0
    });
  } catch {
    /* 菜单尚未创建时忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener(info => {
  switch (info.menuItemId) {
    case "sort_all":
      startSorting();
      break;
    case "sort_bar":
      handleRootSort(["书签栏", "Bookmarks bar", "Bookmarks Bar"], "1");
      break;
    case "sort_other":
      handleRootSort(["其他书签", "Other bookmarks", "Other Bookmarks"], "2");
      break;
    case "restore":
      restoreSorting();
      break;
  }
});

chrome.action.onClicked.addListener(() => {
  startSorting();
});

// 设置页 / 快捷操作消息通道
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "get_state":
          sendResponse({
            ok: true,
            options: await loadOptions(),
            snapshotCount: await countSnapshots()
          });
          break;
        case "save_options":
          sendResponse({ ok: true, options: await saveOptions(msg.options) });
          break;
        case "sort_all":
          sendResponse(await startSorting());
          break;
        case "restore":
          sendResponse(await restoreSorting());
          break;
        case "clear_history":
          await chrome.storage.local.remove(["history", "snapshot"]);
          await syncRestoreMenu();
          sendResponse({ ok: true, snapshotCount: 0 });
          break;
        default:
          sendResponse({ ok: false, reason: "unknown-message" });
      }
    } catch (err) {
      sendResponse({ ok: false, reason: err.message });
    }
  })();
  return true; // 异步 sendResponse
});
