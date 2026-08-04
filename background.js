/**
 * 视觉长度计算：去掉前后空格，汉字/全角算2，ASCII算1
 */
function visualLength(str) {
  const clean = (str || "").trim();
  let len = 0;
  for (const ch of clean) {
    const code = ch.charCodeAt(0);
    len += (code <= 0x7F) ? 1 : 2;
  }
  return len;
}

/**
 * 发送系统通知
 */
function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: title,
    message: message,
    priority: 1
  });
}

/**
 * 任务互斥锁：防止排序/恢复并发执行互相干扰
 */
let busy = false;

/**
 * 获取根目录节点（书签栏、其他书签、移动设备书签）
 */
async function getRootNodes() {
  const [root] = await chrome.bookmarks.getTree();
  return (root && root.children) || [];
}

/**
 * 按关键词解析根目录节点，找不到时回退到固定 ID
 */
async function resolveRootNode(keywords, fallbackId) {
  const nodes = await getRootNodes();
  const found = nodes.find(node => node.title && keywords.some(keyword => node.title.includes(keyword)));
  if (found) return found;
  try {
    const [node] = await chrome.bookmarks.get(fallbackId);
    return node;
  } catch {
    return null;
  }
}

/**
 * 将单个文件夹内的节点重排为目标顺序（仅调整 index，不改变父文件夹）。
 * 每次 move 前实时读取当前位置，避免前序 move 造成 index 偏移导致的误判。
 */
async function reorderFolder(folderId, orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    const id = orderedIds[i];
    let currentIndex;
    try {
      const [node] = await chrome.bookmarks.get(id);
      currentIndex = node.index;
    } catch {
      continue;
    }
    if (currentIndex !== i) {
      await moveWithRetry(id, { index: i });
    }
  }
}

/**
 * 带重试的 move 操作
 */
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
 * 递归排序单个文件夹
 */
async function sortFolderRecursive(folderId, folderName, depth = 0) {
  const indent = "  ".repeat(depth);
  const children = await chrome.bookmarks.getChildren(folderId);

  if (!children || children.length === 0) return;

  console.log(`${indent}[SORT] 正在整理: ${folderName} (${children.length} 个项目)`);

  const bookmarks = [];
  const folders = [];

  for (const node of children) {
    if (node.url) {
      const title = (node.title || node.url || "").trim();
      bookmarks.push({ ...node, title, vlen: visualLength(title) });
    } else {
      folders.push({ ...node, title: (node.title || "").trim() });
    }
  }

  bookmarks.sort((a, b) => {
    if (a.vlen !== b.vlen) return a.vlen - b.vlen;
    return a.title.localeCompare(b.title, "zh-CN");
  });

  folders.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));

  const sortedList = [...bookmarks, ...folders];

  await reorderFolder(folderId, sortedList.map(item => item.id));

  for (const f of folders) {
    await sortFolderRecursive(f.id, f.title, depth + 1);
  }
}

/**
 * 排序前保存整棵树各文件夹的子节点顺序快照，供"恢复"使用
 */
async function createSnapshot() {
  const folders = {};
  const [root] = await chrome.bookmarks.getTree();

  async function walk(node) {
    if (node.children) {
      folders[node.id] = node.children.map(child => child.id);
      for (const child of node.children) {
        await walk(child);
      }
    }
  }

  for (const child of root.children || []) {
    await walk(child);
  }

  await chrome.storage.local.set({
    snapshot: { version: 1, timestamp: Date.now(), folders }
  });
}

/**
 * 入口：排序指定的根目录或全部根目录
 * @param {object|null} rootNode - null 表示全部根目录，否则为单个根目录节点
 */
async function startSorting(rootNode = null) {
  if (busy) {
    notify("正在处理", "已有排序/恢复任务进行中，请稍候。");
    return;
  }
  busy = true;
  try {
    await createSnapshot();

    if (rootNode) {
      await sortFolderRecursive(rootNode.id, rootNode.title || "根目录");
    } else {
      const rootNodes = await getRootNodes();
      for (const node of rootNodes) {
        await sortFolderRecursive(node.id, node.title);
      }
    }

    notify("排序完成", "所有书签已按视觉长度排列。");
  } catch (err) {
    console.error("排序出错:", err);
    notify("排序失败", err.message);
  } finally {
    busy = false;
  }
}

/**
 * 右键菜单点击时的单根目录排序入口
 */
async function handleRootSort(keywords, fallbackId) {
  const node = await resolveRootNode(keywords, fallbackId);
  if (!node) {
    notify("排序失败", "未找到对应的书签根目录。");
    return;
  }
  startSorting(node);
}

/**
 * 恢复：按快照把各文件夹恢复到排序前的顺序
 */
async function restoreSorting() {
  if (busy) {
    notify("正在处理", "已有排序/恢复任务进行中，请稍候。");
    return;
  }
  busy = true;
  try {
    const { snapshot } = await chrome.storage.local.get("snapshot");
    if (!snapshot || !snapshot.folders) {
      notify("无可恢复", "没有找到排序前的快照，请先执行一次排序。");
      return;
    }

    const entries = Object.entries(snapshot.folders);
    for (const [folderId, orderedIds] of entries) {
      await reorderFolder(folderId, orderedIds);
    }

    await chrome.storage.local.remove("snapshot");
    notify("恢复完成", "书签已恢复到上次排序前的顺序。");
  } catch (err) {
    console.error("恢复出错:", err);
    notify("恢复失败", err.message);
  } finally {
    busy = false;
  }
}

// --- 事件监听 ---

// 1. 安装时创建右键菜单（先清空，避免重复创建报错）
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const menus = [
      { id: "sort_all", title: "[全部] 递归排序所有书签" },
      { id: "sort_bar", title: "[书签栏] 递归排序" },
      { id: "sort_other", title: "[其他] 递归排序" },
      { id: "restore", title: "[恢复] 撤销上次排序" }
    ];

    menus.forEach(menu => {
      chrome.contextMenus.create({
        id: menu.id,
        title: menu.title,
        contexts: ["all"]
      });
    });
  });
});

// 2. 处理右键菜单点击
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "sort_all") {
    startSorting();
  } else if (info.menuItemId === "sort_bar") {
    handleRootSort(["书签栏", "Bookmarks bar"], "1");
  } else if (info.menuItemId === "sort_other") {
    handleRootSort(["其他书签", "Other bookmarks"], "2");
  } else if (info.menuItemId === "restore") {
    restoreSorting();
  }
});

// 3. 处理扩展图标点击
chrome.action.onClicked.addListener(() => {
  startSorting();
});
