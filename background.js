/**
 * 视觉长度计算：去掉前后空格，汉字/全角算2，ASCII算1
 */
function visualLength(str) {
  const clean = (str || "").trim();
  let len = 0;
  for (const ch of clean) {
    // 简单判断：非单字节字符逻辑
    len += (ch.charCodeAt(0) <= 0x007f) ? 1 : 2;
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
 * 递归排序单个文件夹
 */
async function sortFolderRecursive(folderId, folderName, depth = 0) {
  const indent = "  ".repeat(depth);
  const children = await chrome.bookmarks.getChildren(folderId);

  if (!children || children.length === 0) return;

  console.log(`${indent}📂 正在整理: ${folderName} (${children.length} 个项目)`);

  const bookmarks = [];
  const folders = [];

  // 1. 分类
  for (const node of children) {
    if (node.url) {
      const title = (node.title || node.url || "").trim();
      bookmarks.push({ ...node, title, vlen: visualLength(title) });
    } else {
      folders.push({ ...node, title: (node.title || "").trim() });
    }
  }

  // 2. 排序逻辑
  // 书签：视觉长度从小到大，相同长度按字母序
  bookmarks.sort((a, b) => {
    if (a.vlen !== b.vlen) return a.vlen - b.vlen;
    return a.title.localeCompare(b.title, 'zh-CN');
  });

  // 文件夹：按字母序
  folders.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));

  // 3. 最终期望顺序：书签在前，文件夹在后
  const sortedList = [...bookmarks, ...folders];

  // 4. 执行移动 (优化：如果位置没变，不调用 API)
  for (let i = 0; i < sortedList.length; i++) {
    const item = sortedList[i];
    // 注意：这里的 index 比较是关键，减少不必要的 move 操作
    // 因为 move 是异步的，且会改变兄弟节点的 index，所以顺序执行是安全的
    if (item.index !== i) {
      await chrome.bookmarks.move(item.id, { index: i });
    }
  }

  // 5. 递归处理子文件夹
  for (const f of folders) {
    await sortFolderRecursive(f.id, f.title, depth + 1);
  }
}

/**
 * 入口：排序指定的根目录
 * @param {string} rootId - "1": 书签栏, "2": 其他书签, "3": 移动设备书签
 */
async function startSorting(rootId = null) {
  try {
    if (rootId) {
      // 排序特定文件夹
      const [root] = await chrome.bookmarks.get(rootId);
      await sortFolderRecursive(root.id, root.title || "根目录");
    } else {
      // 排序所有根目录
      const rootNodes = await chrome.bookmarks.getTree();
      const mainNodes = rootNodes[0].children; // 通常包含 书签栏、其他书签、移动书签
      for (const node of mainNodes) {
        await sortFolderRecursive(node.id, node.title);
      }
    }
    notify("排序完成", "所有书签已按视觉长度排列。");
  } catch (err) {
    console.error("排序出错:", err);
    notify("排序失败", err.message);
  }
}

// --- 事件监听 ---

// 1. 安装时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  const menus = [
    { id: "sort_all", title: "🌍 递归排序：所有书签" },
    { id: "sort_bar", title: "📋 递归排序：书签栏" },
    { id: "sort_other", title: "📂 递归排序：其他书签" }
  ];

  menus.forEach(menu => {
    chrome.contextMenus.create({
      id: menu.id,
      title: menu.title,
      contexts: ["all"]
    });
  });
});

// 2. 处理右键菜单点击
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "sort_all") startSorting();
  else if (info.menuItemId === "sort_bar") startSorting("1");
  else if (info.menuItemId === "sort_other") startSorting("2");
});

// 3. 处理扩展图标点击
chrome.action.onClicked.addListener(() => {
  startSorting();
});
