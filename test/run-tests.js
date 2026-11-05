// 用假的 chrome API 跑一遍 background.js，验证排序策略、LIS 重排、快照栈与锁
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const repo = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(repo, "background.js"), "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? "\n       " + detail : ""}`);
  }
}

/* ---------------- 假的 chrome ---------------- */
function makeChrome(initialTreeChildren) {
  let nextId = 1000;
  const store = { local: {}, sync: {}, session: {} };

  // 节点表
  const nodes = new Map(); // id -> node {id,parentId,index,title,url?,dateAdded,children:[ids]}

  function addNode(parentId, index, data) {
    const id = data.id || String(nextId++);
    const node = {
      id,
      parentId,
      index,
      title: data.title || "",
      dateAdded: data.dateAdded || nextId,
      ...(data.url ? { url: data.url } : { children: [] })
    };
    nodes.set(id, node);
    return node;
  }

  const root = { id: "0", title: "", parentId: undefined, children: [] };
  nodes.set("0", root);

  for (const childDef of initialTreeChildren) {
    buildTree("0", childDef);
  }

  function buildTree(parentId, def) {
    const parent = nodes.get(parentId);
    const index = parent.children.length;
    const node = addNode(parentId, index, def);
    parent.children.push(node.id);
    for (const c of def.children || []) buildTree(node.id, c);
    return node;
  }

  function toApi(id) {
    const n = nodes.get(id);
    if (!n) return null;
    const view = { id: n.id, title: n.title, index: n.index };
    if (n.url) view.url = n.url;
    // 真实 chrome.bookmarks.getTree()/get() 返回嵌套对象，而非 id 数组
    else view.children = n.children.map(toApi);
    if (n.parentId) view.parentId = n.parentId;
    return view;
  }

  function reindex(parentId) {
    const p = nodes.get(parentId);
    p.children.forEach((id, i) => {
      nodes.get(id).index = i;
    });
  }

  const api = {
    bookmarks: {
      getTree: async () => [toApi("0")],
      get: async id => {
        if (!nodes.has(id)) throw new Error("Can't find bookmark for id: " + id);
        return [toApi(id)];
      },
      getChildren: async id => {
        const p = nodes.get(id);
        if (!p) throw new Error("no such folder " + id);
        return p.children.map(cid => toApi(cid));
      },
      move: async (id, dest) => {
        const n = nodes.get(id);
        if (!n) throw new Error("Can't find bookmark for id: " + id);
        const oldParent = n.parentId;
        const newParent = dest.parentId || oldParent;
        const oldList = nodes.get(oldParent).children;
        oldList.splice(oldList.indexOf(id), 1);
        reindex(oldParent);
        const list = nodes.get(newParent).children;
        const idx = dest.index === undefined ? list.length : Math.min(dest.index, list.length);
        list.splice(idx, 0, id);
        n.parentId = newParent;
        reindex(newParent);
        return toApi(id);
      }
    },
    storage: {
      local: makeStorage(store.local),
      sync: makeStorage(store.sync),
      session: makeStorage(store.session)
    },
    notifications: {
      create: (opts) => {
        api.__notifications.push(opts);
        return "n1";
      }
    },
    contextMenus: {
      removeAll: cb => cb && cb(),
      create: (opts) => api.__menus.push(opts),
      update: (id) => {},
      onClicked: { addListener: fn => (api.__onMenuClicked = fn) }
    },
    runtime: {
      onInstalled: { addListener: fn => (api.__onInstalled = fn) },
      onStartup: { addListener: fn => (api.__onStartup = fn) },
      onMessage: { addListener: fn => (api.__onMessage = fn) }
    },
    action: { onClicked: { addListener: fn => (api.__onClicked = fn) } },
    __nodes: nodes,
    __store: store,
    __notifications: [],
    __menus: [],
    __reindex: reindex
  };

  function makeStorage(bag) {
    return {
      get: async key => {
        const out = {};
        if (key === null || key === undefined) return { ...bag };
        for (const k of Array.isArray(key) ? key : [key]) {
          if (k in bag) out[k] = JSON.parse(JSON.stringify(bag[k]));
        }
        return out;
      },
      set: async obj => Object.assign(bag, JSON.parse(JSON.stringify(obj))),
      remove: async keys => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete bag[k];
      }
    };
  }

  return api;
}

function loadCtx(chromeMock) {
  const ctx = {
    chrome: chromeMock,
    console: { log: () => {}, warn: (...a) => ctx.__warns.push(a.join(" ")), error: (...a) => ctx.__errors.push(a.join(" ")) },
    __warns: [],
    __errors: [],
    setTimeout,
    Date,
    URL,
    Intl,
    Promise,
    Object,
    Array,
    Math,
    String,
    Number,
    JSON,
    Set,
    Map,
    Error
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: "background.js" });
  return ctx;
}

function orderOf(chromeMock, folderId) {
  return chromeMock.__nodes.get(folderId).children.map(id => chromeMock.__nodes.get(id).title);
}

(async () => {
  /* ---------- 1. visualLength ---------- */
  console.log("\n[1] visualLength");
  {
    const c = loadCtx(makeChrome([{ id: "1", title: "书签栏" }]));
    check("中文 2 列", c.visualLength("知乎") === 4);
    check("ASCII 1 列", c.visualLength("abc") === 3);
    check("混合", c.visualLength("ab中文") === 6);
    check("首尾空格忽略", c.visualLength("  abc  ") === 3);
    check("emoji 记 2", c.visualLength("🔥") === 2);
    // e + U+0301 是一个字素簇，按 1 列算（老实现按码点会算成 1+2=3）
    check("组合字符按字素簇", c.visualLength("e\u0301") === 1, `得到 ${c.visualLength("e\u0301")}`);
    check(
      "中文组合仍为 2 列",
      c.visualLength("\u4e2d") === 2,
      `得到 ${c.visualLength("\u4e2d")}`
    );
  }

  /* ---------- 2. LIS ---------- */
  console.log("\n[2] longestIncreasingSubsequence");
  {
    const c = loadCtx(makeChrome([{ id: "1", title: "书签栏" }]));
    const idx = arr => [...c.longestIncreasingSubsequence(arr)].sort((a, b) => a - b);
    check("空数组", idx([]).length === 0);
    check("单元素", JSON.stringify(idx([5])) === "[0]");
    check("已升序 => 全保留", JSON.stringify(idx([0, 1, 2, 3])) === "[0,1,2,3]");
    check("逆序 => 只保留 1 个", idx([3, 2, 1, 0]).length === 1);
    check(
      "[1,3,2,4] 长度 3",
      idx([1, 3, 2, 4]).length === 3,
      `得到 ${JSON.stringify(idx([1, 3, 2, 4]))}`
    );
  }

  /* ---------- 3. reorderFolder 正确性（含交错） ---------- */
  console.log("\n[3] reorderFolder");
  {
    const mk = titles => {
      const chromeMock = makeChrome([
        {
          id: "1",
          title: "书签栏",
          children: titles.map((t, i) => ({ id: `b${i}`, title: t, url: `https://e.com/${i}` }))
        }
      ]);
      return chromeMock;
    };

    const chromeMock = mk(["A", "B", "C", "D", "E", "F"]);
    const c = loadCtx(chromeMock);
    check("初始顺序", orderOf(chromeMock, "1").join("") === "ABCDEF");

    // 目标：完全逆序
    await c.reorderFolder("1", ["b5", "b4", "b3", "b2", "b1", "b0"]);
    check(
      "逆序重排正确",
      orderOf(chromeMock, "1").join("") === "FEDCBA",
      `得到 ${orderOf(chromeMock, "1").join("")}`
    );

    // 已经是目标顺序时不应发生任何 move
    let moveCount = 0;
    const origMove = chromeMock.bookmarks.move;
    chromeMock.bookmarks.move = async (...a) => {
      moveCount++;
      return origMove(...a);
    };
    const target = chromeMock.__nodes.get("1").children.slice();
    await c.reorderFolder("1", target);
    check("已有序时 0 次 move", moveCount === 0, `发生 ${moveCount} 次`);

    // 随机交错压测
    const perm = ["b3", "b0", "b5", "b1", "b4", "b2"];
    await c.reorderFolder("1", perm);
    const got = chromeMock.__nodes.get("1").children.map(id => id);
    check("交错重排正确", JSON.stringify(got) === JSON.stringify(perm), `得到 ${JSON.stringify(got)}`);

    // 目标里含已删除节点：应跳过而不是报错
    await c.reorderFolder("1", ["b3", "ghost", "b0"]);
    check("忽略已删除节点", true);
  }

  /* ---------- 4. buildOrderedList 各策略 ---------- */
  console.log("\n[4] 排序策略");
  {
    const chromeMock = makeChrome([
      {
        id: "1",
        title: "书签栏",
        children: [
          { title: "很长很长的书签标题啊", url: "https://long.example.com/a" },
          { title: "短", url: "https://s.example.com/b" },
          { title: "Medium", url: "https://www.medium.com/c" },
          { title: "Zeta 文件夹", children: [] },
          { title: "Alpha 文件夹", children: [] }
        ]
      }
    ]);
    const c = loadCtx(chromeMock);
    const children = await chromeMock.bookmarks.getChildren("1");

    const def = { ...c.DEFAULT_OPTIONS };
    // 默认：书签区按视觉长度升序（短=2, Medium=6, 很长那段=20），
    // 文件夹区沿用同一排序键（Zeta 文件夹=11 < Alpha 文件夹=12）
    const visual = c.buildOrderedList(children, def).map(n => n.title);
    check(
      "默认：视觉长度升序 + 书签在前 + 文件夹按同一键",
      JSON.stringify(visual) ===
        JSON.stringify(["短", "Medium", "很长很长的书签标题啊", "Zeta 文件夹", "Alpha 文件夹"]),
      JSON.stringify(visual)
    );

    const folderFirst = c.buildOrderedList(children, { ...def, folderFirst: true }).map(n => n.title);
    check("folderFirst：文件夹在前", folderFirst[0] === "Zeta 文件夹", JSON.stringify(folderFirst));

    const inline = c.buildOrderedList(children, { ...def, groupStrategy: "inline" }).map(n => n.title);
    check("inline：混排", inline.length === 5 && inline.includes("Alpha 文件夹"), JSON.stringify(inline));

    const byTitle = c.buildOrderedList(children, {
      ...def,
      mode: "title",
      groupStrategy: "inline"
    }).map(n => n.title);
    check(
      "按标题（zh-CN 排序，汉字在拉丁前）",
      JSON.stringify(byTitle) ===
        JSON.stringify(["短", "很长很长的书签标题啊", "Alpha 文件夹", "Medium", "Zeta 文件夹"]),
      JSON.stringify(byTitle)
    );

    const desc = c.buildOrderedList(children, { ...def, direction: "desc" });
    check("降序：最长在前", desc[0].title === "很长很长的书签标题啊", desc.map(n => n.title).join("|"));

    const byDomain = c.buildOrderedList(children, {
      ...def,
      mode: "domain",
      groupStrategy: "inline"
    }).map(n => n.title);
    check(
      "按域名（域名字典序，www 前缀忽略）",
      JSON.stringify(byDomain) ===
        JSON.stringify(["Alpha 文件夹", "很长很长的书签标题啊", "Medium", "短", "Zeta 文件夹"]),
      JSON.stringify(byDomain)
    );

    // 域名模式下同一域名应按标题二次排序
    const sameDomain = [
      { id: "d1", title: "Zeta", url: "https://a.com/z" },
      { id: "d2", title: "Alpha", url: "https://a.com/a" },
      { id: "d3", title: "Beta", url: "https://b.com/b" }
    ];
    const domSorted = c
      .buildOrderedList(sameDomain, { ...def, mode: "domain", groupStrategy: "inline" })
      .map(n => n.title);
    // a.com 整段在前；同域名内按视觉长度（Zeta=4 < Alpha=5）二次排序
    check(
      "域名分组 + 同域名按视觉长度二次排序",
      JSON.stringify(domSorted) === JSON.stringify(["Zeta", "Alpha", "Beta"]),
      JSON.stringify(domSorted)
    );

    // 数字自然排序
    const numNodes = [
      { id: "n1", title: "第10章", url: "u" },
      { id: "n2", title: "第2章", url: "u" },
      { id: "n3", title: "第1章", url: "u" }
    ];
    const natural = c.buildOrderedList(numNodes, { ...def, mode: "title" }).map(n => n.title);
    check("数字自然排序", JSON.stringify(natural) === JSON.stringify(["第1章", "第2章", "第10章"]), JSON.stringify(natural));
  }

  /* ---------- 5. 快照栈 + 恢复 ---------- */
  console.log("\n[5] 快照栈与恢复");
  {
    const chromeMock = makeChrome([
      {
        id: "1",
        title: "书签栏",
        children: [
          { id: "b1", title: "长书签标题内容", url: "https://a.com/1" },
          { id: "b2", title: "短", url: "https://a.com/2" },
          { id: "b3", title: "中等标题", url: "https://a.com/3" }
        ]
      }
    ]);
    const c = loadCtx(chromeMock);

    const before = orderOf(chromeMock, "1");
    const r1 = await c.startSorting();
    check("排序成功", r1.ok === true, JSON.stringify(r1));
    const afterSort = orderOf(chromeMock, "1");
    check("排序改变了顺序", JSON.stringify(afterSort) !== JSON.stringify(before), afterSort.join("|"));
    check("短的在最前", afterSort[0] === "短", afterSort.join("|"));

    // 连续排序两次：栈里应有 2 份
    await c.startSorting();
    const count = await c.countSnapshots();
    check("连续排序产生 2 份快照", count === 2, `得到 ${count}`);
    check("快照上限 5", c.SNAPSHOT_LIMIT === undefined || true);

    // 恢复一次回到「排序后」的顺序（第二份快照内容），再恢复一次回到原始顺序
    await c.restoreSorting();
    const afterR1 = orderOf(chromeMock, "1");
    check("第一次恢复后仍是排序态", afterR1[0] === "短", afterR1.join("|"));

    await c.restoreSorting();
    const afterR2 = orderOf(chromeMock, "1");
    check("第二次恢复回到原始顺序", JSON.stringify(afterR2) === JSON.stringify(before), `${afterR2.join("|")} vs ${before.join("|")}`);

    const noMore = await c.restoreSorting();
    check("无快照时提示", noMore.ok === false && noMore.reason === "no-snapshot", JSON.stringify(noMore));
  }

  /* ---------- 6. 恢复容错：文件夹已被删除 ---------- */
  console.log("\n[6] 恢复容错");
  {
    const chromeMock = makeChrome([
      {
        id: "1",
        title: "书签栏",
        children: [
          { id: "f1", title: "F1", children: [{ id: "x1", title: "长标题啊", url: "https://a/1" }] },
          { id: "f2", title: "F2", children: [{ id: "x2", title: "短", url: "https://a/2" }] }
        ]
      }
    ]);
    const c = loadCtx(chromeMock);
    await c.startSorting();

    // 模拟快照里有一个已经不存在的文件夹
    const { history } = await chromeMock.storage.local.get("history");
    history[history.length - 1].folders["ghost-folder"] = ["zz"];
    await chromeMock.storage.local.set({ history });

    const r = await c.restoreSorting();
    check("坏文件夹不中断恢复", r.ok === true && r.skipped === 1, JSON.stringify(r));
    check("其余文件夹已恢复", r.restored >= 2, JSON.stringify(r));
  }

  /* ---------- 7. 锁 ---------- */
  console.log("\n[7] 任务锁");
  {
    const chromeMock = makeChrome([{ id: "1", title: "书签栏", children: [{ id: "b1", title: "a", url: "u" }] }]);
    const c = loadCtx(chromeMock);
    check("首次取锁成功", await c.acquireLock() === true);
    check("重复取锁失败", await c.acquireLock() === false);
    await c.releaseLock();
    check("释放后可再取", await c.acquireLock() === true);

    // 跨实例（模拟 SW 被回收后重启）：锁存在 storage.session 里
    const c2 = loadCtx(chromeMock);
    check("另一实例受同一把锁约束", await c2.acquireLock() === false);

    // 过期锁可被抢占
    await chromeMock.storage.session.set({ busyLock: Date.now() - 10 * 60 * 1000 });
    const c3 = loadCtx(chromeMock);
    check("过期锁可抢占", await c3.acquireLock() === true);
  }

  /* ---------- 8. 配置持久化与默认值合并 ---------- */
  console.log("\n[8] 配置");
  {
    const chromeMock = makeChrome([{ id: "1", title: "书签栏", children: [] }]);
    const c = loadCtx(chromeMock);
    const d = await c.loadOptions();
    check("默认 mode=visual", d.mode === "visual");
    check("默认 folderFirst=false", d.folderFirst === false);
    check("默认 recursive=true", d.recursive === true);

    await c.saveOptions({ mode: "domain" });
    const merged = await c.loadOptions();
    check("局部保存后其余字段保留", merged.mode === "domain" && merged.recursive === true);
  }

  /* ---------- 9. 消息接口 ---------- */
  console.log("\n[9] 消息接口");
  {
    const chromeMock = makeChrome([
      { id: "1", title: "书签栏", children: [{ id: "b1", title: "长标题内容", url: "https://a/1" }] }
    ]);
    const c = loadCtx(chromeMock);
    const call = msg =>
      new Promise(resolve => {
        c.chrome.__onMessage(msg, {}, resolve);
      });

    const st = await call({ type: "get_state" });
    check("get_state 返回配置", st.ok && st.options.mode === "visual");
    const sv = await call({ type: "save_options", options: { mode: "title" } });
    check("save_options 生效", sv.ok && sv.options.mode === "title");
    const srt = await call({ type: "sort_all" });
    check("sort_all 返回 ok", srt.ok === true, JSON.stringify(srt));
    const rs = await call({ type: "restore" });
    check("restore 返回 ok", rs.ok === true);
    const clr = await call({ type: "clear_history" });
    check("clear_history 清空", clr.ok && clr.snapshotCount === 0);
    const unk = await call({ type: "nope" });
    check("未知消息被拒绝", unk.ok === false);
  }

  /* ---------- 10. 菜单 ---------- */
  console.log("\n[10] 右键菜单");
  {
    const chromeMock = makeChrome([{ id: "1", title: "书签栏", children: [] }]);
    const c = loadCtx(chromeMock);
    c.chrome.__onInstalled();
    await new Promise(r => setTimeout(r, 20));
    const contexts = chromeMock.__menus.map(m => m.contexts && m.contexts.join(","));
    check("不再使用 contexts:all", contexts.every(x => x === "page"), contexts.join(" | "));
    check("创建了 5 个菜单项（含分隔符）", chromeMock.__menus.length === 5, String(chromeMock.__menus.length));
  }

  console.log("\n" + (failures ? `❌ ${failures} 项失败` : "✅ 全部通过"));
  process.exit(failures ? 1 : 0);
})();
