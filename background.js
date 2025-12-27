// 一个简单的“视觉长度”估算函数：
// 汉字、全角字符算 2，ASCII 字符算 1
function visualLength(str) {
  let len = 0;
  for (const ch of str) {
    // 简单判断：ASCII 范围
    if (ch.charCodeAt(0) <= 0x007f) {
      len += 1;
    } else {
      len += 2;
    }
  }
  return len;
}

// 排序当前文件夹：书签先按视觉长度升序，文件夹在后按名称排序
async function sortFolderByVisualLength(folderId) {
  // 获取该文件夹的子节点
  const children = await chrome.bookmarks.getChildren(folderId);

  // 分成书签和文件夹
  const bookmarks = [];
  const folders = [];

  for (const node of children) {
    if (node.url) {
      // 这是书签
      const title = node.title || node.url || "";
      bookmarks.push({
        id: node.id,
        title,
        vlen: visualLength(title)
      });
    } else {
      // 这是文件夹
      folders.push(node);
    }
  }

  // 书签按视觉长度排序，长度相同再按标题字典序
  bookmarks.sort((a, b) => {
    if (a.vlen !== b.vlen) {
      return a.vlen - b.vlen;
    }
    return a.title.localeCompare(b.title);
  });

  // 文件夹按标题排序
  folders.sort((a, b) => {
    const ta = a.title || "";
    const tb = b.title || "";
    return ta.localeCompare(tb);
  });

  // 根据排序结果重新设置顺序：
  // 先放所有书签，再放所有文件夹
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
}

// 创建右键菜单：在书签管理器/书签栏文件夹上右键使用
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "sort_by_visual_length",
    title: "按视觉长度排序当前文件夹",
    contexts: ["bookmark"]
  });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "sort_by_visual_length") return;

  const bookmarkId = info.bookmarkId;
  if (!bookmarkId) return;

  // 找到这个节点，确定要排序的“父文件夹”
  const [node] = await chrome.bookmarks.get(bookmarkId);

  let folderId = null;

  if (node.url) {
    // 如果点的是某个书签，就对它所在文件夹排序
    folderId = node.parentId;
  } else {
    // 如果点的是文件夹，就对该文件夹排序
    folderId = node.id;
  }

  if (!folderId) return;

  await sortFolderByVisualLength(folderId);
  console.log("Folder sorted by visual length:", folderId);
});
