// 视觉长度计算：汉字/全角算2，ASCII算1
function visualLength(str) {
  let len = 0;
  for (const ch of str) {
    if (ch.charCodeAt(0) <= 0x007f) {
      len += 1;
    } else {
      len += 2;
    }
  }
  return len;
}

// 排序指定文件夹
async function sortFolderByVisualLength(folderId, folderName) {
  console.log(`开始排序文件夹: ${folderName} (${folderId})`);
  
  const children = await chrome.bookmarks.getChildren(folderId);
  
  const bookmarks = [];
  const folders = [];

  for (const node of children) {
    if (node.url) {
      const title = node.title || node.url || "";
      bookmarks.push({
        id: node.id,
        title,
        vlen: visualLength(title)
      });
    } else if (node.children) {
      folders.push(node);
    }
  }

  bookmarks.sort((a, b) => {
    if (a.vlen !== b.vlen) return a.vlen - b.vlen;
    return a.title.localeCompare(b.title);
  });

  folders.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

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
  
  console.log(`完成！书签${bookmarks.length}个，文件夹${folders.length}个`);
}

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll();
  
  chrome.contextMenus.create({
    id: "sort_bookmarks_bar",
    title: "📋 排序书签栏（短的在前）",
    contexts: ["page"]
  });
  
  chrome.contextMenus.create({
    id: "sort_other_bookmarks",
    title: "📂 排序其他书签（短的在前）",
    contexts: ["page"]
  });
  
  console.log("书签排序菜单已创建");
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info) => {
  try {
    if (info.menuItemId === "sort_bookmarks_bar") {
      await sortFolderByVisualLength("1", "书签栏");
    } else if (info.menuItemId === "sort_other_bookmarks") {
      await sortFolderByVisualLength("2", "其他书签");
    }
  } catch (error) {
    console.error("排序失败:", error);
  }
});
