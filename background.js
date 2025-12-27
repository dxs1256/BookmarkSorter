// 视觉长度计算：去掉前后空格，汉字/全角算2，ASCII算1
function visualLength(str) {
  const clean = (str || "").trim();
  let len = 0;
  for (const ch of clean) {
    if (ch.charCodeAt(0) <= 0x007f) {
      len += 1;
    } else {
      len += 2;
    }
  }
  return len;
}

// 递归排序整个根目录（书签 + 子文件夹）
async function sortFolderRecursive(folderId, folderName, depth = 0) {
  const indent = "  ".repeat(depth);
  const children = await chrome.bookmarks.getChildren(folderId);

  console.log(`${indent}📂 ${folderName}: ${children.length} 个项目`);

  if (!children || children.length === 0) return;

  const bookmarks = [];
  const folders = [];

  for (const node of children) {
    if (node.url) {
      const title = (node.title || node.url || "").trim();
      bookmarks.push({
        id: node.id,
        title,
        vlen: visualLength(title)
      });
    } else {
      folders.push(node);
    }
  }

  console.log(
    `${indent}   📑 书签 ${bookmarks.length} 个，📁 文件夹 ${folders.length} 个`
  );

  // 书签：视觉长度从小到大，相同长度按去空格后的标题排序
  bookmarks.sort((a, b) => {
    if (a.vlen !== b.vlen) return a.vlen - b.vlen;
    return a.title.localeCompare(b.title);
  });

  // 文件夹：名称按字典序
  folders.sort((a, b) => {
    const ta = (a.title || "").trim();
    const tb = (b.title || "").trim();
    return ta.localeCompare(tb);
  });

  // 重排：书签在前，文件夹在后
  let index = 0;
  for (const bm of bookmarks) {
    await chrome.bookmarks.move(bm.id, {
      parentId: folderId,
      index: index++
    });
  }
  for (const folder of folders) {
    await chrome.bookmarks.move(folder.id, {
      parentId: folderId,
      index: index++
    });
  }

  console.log(`${indent}✅ 当前层完成: ${folderName}`);

  // 递归子文件夹
  for (const folder of folders) {
    await sortFolderRecursive(folder.id, folder.title || "未命名", depth + 1);
  }
}

// 一键全局排序入口：书签栏 + 其他书签
async function sortAllRootFolders() {
  console.log("🔥 开始全局递归排序...");
  // 书签栏 (1)
  await sortFolderRecursive("1", "书签栏");
  // 其他书签 (2)
  await sortFolderRecursive("2", "其他书签");
  console.log("🎉 全局递归排序完成！");
}

// 安装时创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: "sort_all",
    title: "🌍 全部书签递归排序（短的在前）",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "sort_bar",
    title: "📋 仅排序书签栏（递归）",
    contexts: ["page"]
  });

  chrome.contextMenus.create({
    id: "sort_other",
    title: "📂 仅排序其他书签（递归）",
    contexts: ["page"]
  });

  console.log("✅ 递归排序菜单已创建");
});

// 右键菜单事件
chrome.contextMenus.onClicked.addListener(async (info) => {
  try {
    if (info.menuItemId === "sort_all") {
      await sortAllRootFolders();
    } else if (info.menuItemId === "sort_bar") {
      await sortFolderRecursive("1", "书签栏");
    } else if (info.menuItemId === "sort_other") {
      await sortFolderRecursive("2", "其他书签");
    }
  } catch (e) {
    console.error("❌ 排序失败:", e);
  }
});

// （可选）点击扩展图标也执行全局递归排序
chrome.action.onClicked.addListener(async () => {
  try {
    await sortAllRootFolders();
  } catch (e) {
    console.error("❌ 图标点击排序失败:", e);
  }
});
