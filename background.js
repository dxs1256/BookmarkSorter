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
  
  // 分离书签和文件夹
  const bookmarks = [];
  const folders = [];

  for (const node of children) {
    if (node.url) {
      // 书签
      const title = node.title || node.url || "";
      bookmarks.push({
        id: node.id,
        title,
        vlen: visualLength(title)
      });
    } else if (node.children) {
      // 文件夹
      folders.push(node);
    }
  }

  // 书签按视觉长度排序（短的在前）
  bookmarks.sort((a, b) => {
    if (a.vlen !== b.vlen) return a.vlen - b.vlen;
    return a.title.localeCompare(b.title);
  });

  // 文件夹按名称排序
  folders.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

  // 执行移动：书签在前，文件夹在后
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

// 常用文件夹ID
const FOLDERS = {
  "书签栏": "1",
  "其他书签": "2"
};

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

// 扩展图标点击：显示常用文件夹列表
chrome.action.onClicked.addListener(async () => {
  chrome.action.setPopup({
    popup: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="width:200px;padding:10px;">
        <h3>选择排序文件夹</h3>
        <button id="sort1" style="width:100%;margin:5px 0;">📋 书签栏</button>
        <button id="sort2" style="width:100%;margin:5px 0;">📂 其他书签</button>
        <script>
          document.getElementById('sort1').onclick = () => {
            chrome.runtime.sendMessage({action: 'sort', folder: '1'});
            window.close();
          };
          document.getElementById('sort2').onclick = () => {
            chrome.runtime.sendMessage({action: 'sort', folder: '2'});
            window.close();
          };
        </script>
      </body>
      </html>
    `
  });
});

// 处理popup消息
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'sort') {
    sortFolderByVisualLength(request.folder, request.folder === '1' ? '书签栏' : '其他书签');
  }
});
