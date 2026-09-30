#!/usr/bin/env node
/**
 * 用本机 Edge / Chrome（headless + CDP）给页面截图，方便在没有微信开发者工具时目视验收。
 *
 * 为什么不直接用 `msedge --headless --screenshot`：
 * 1) 那个模式没法在截图前执行脚本，只能拍首屏 —— 轮播的第 2、3 张根本看不到；
 * 2) Windows 上窗口有最小宽度（约 500px），`--window-size=390` 会被夹宽到 ~520 再按 390 裁切，
 *    看起来像页面横向溢出，其实是假象。CDP 的 setDeviceMetricsOverride 才是真正的窄视口。
 *
 * 用法：
 *   node scripts/screenshot.js --url http://127.0.0.1:3000/preview/ --out shot.png
 *   node scripts/screenshot.js --url <URL> --out shot.png --slide 2        # 截图前把轮播滑到第 2 张
 *   node scripts/screenshot.js --url <URL> --out shot.png --width 390 --height 900 --full
 *   node scripts/screenshot.js --url http://127.0.0.1:3000/admin/ --out shot.png \
 *     --wait-for "#adminLogin" --script '...'                              # 截非首页（管理后台等）
 *   EDGE_PATH=/path/to/chrome node scripts/screenshot.js ...               # 指定浏览器
 *
 * --wait-for 默认 #heroTrack（预览页首页的轮播容器）。截管理后台这类没有轮播的页面时
 * 必须改掉，否则会一直等不到元素、20 秒后超时退出。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function parseArgs(argv) {
  const args = {
    width: 390,
    height: 900,
    scale: 2,
    wait: 1200,
    slide: 1,
    port: 9333,
    full: false,
    waitFor: "#heroTrack",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    if (name === "full") {
      args.full = true;
      continue;
    }
    const value = argv[i + 1];
    i += 1;
    if (name === "url") args.url = value;
    else if (name === "out") args.out = value;
    else if (name === "script") args.script = value;
    else if (name === "wait-for") args.waitFor = value;
    else if (name in args) args[name] = Number(value);
  }
  return args;
}

function findBrowser() {
  const found = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("没找到 Edge/Chrome，用 EDGE_PATH 环境变量指定浏览器路径");
  }
  return found;
}

async function waitFor(check, { timeout = 20000, interval = 150, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // 浏览器刚启动时端口还没监听，连不上是正常的，继续等
    }
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// 最小可用的 CDP 客户端：够发命令、够等一次事件即可，不引第三方依赖。
function createClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const waiting = new Map();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const slot = pending.get(message.id);
        if (!slot) return;
        pending.delete(message.id);
        if (message.error) slot.reject(new Error(message.error.message));
        else slot.resolve(message.result);
        return;
      }
      const handlers = waiting.get(message.method) || [];
      waiting.delete(message.method);
      handlers.forEach((handler) => handler(message.params));
    });
    socket.addEventListener("error", () => reject(new Error("无法连接浏览器调试端口")));
    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const id = nextId;
          nextId += 1;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        once(method) {
          return new Promise((res) => {
            const handlers = waiting.get(method) || [];
            handlers.push(res);
            waiting.set(method, handlers);
          });
        },
        close: () => socket.close(),
      }),
    );
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.out) {
    console.error(
      "用法: node scripts/screenshot.js --url <URL> --out <PNG> [--slide N] [--wait-for <选择器>] [--script <JS>] [--width 390] [--height 900] [--full]",
    );
    process.exit(1);
  }

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shot-profile-"));
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let client;
  try {
    await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${args.port}/json/version`);
        return response.ok;
      },
      { label: "浏览器调试端口" },
    );

    const targets = await (await fetch(`http://127.0.0.1:${args.port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("没有可用的页面目标");

    client = await createClient(page.webSocketDebuggerUrl);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor: args.scale,
      mobile: true,
    });

    const loaded = client.once("Page.loadEventFired");
    await client.send("Page.navigate", { url: args.url });
    await loaded;

    // 等业务内容真的渲染出来，否则可能截到"正在进入阳光社区"的过渡页。
    // 等哪个元素由 --wait-for 决定，默认是预览页首页的轮播容器。
    await waitFor(
      async () => {
        const { result } = await client.send("Runtime.evaluate", {
          expression: `Boolean(document.querySelector(${JSON.stringify(args.waitFor)}))`,
          returnByValue: true,
        });
        return result.value;
      },
      { label: `元素 ${args.waitFor} 出现` },
    );

    if (args.slide > 1) {
      // 直接按"一屏宽度 × 页码"滚动，比等自动播放稳定：
      // 自动播放要等 5.2 秒，而且 CDP 截图的时机很难卡在滚动动画结束之后。
      await client.send("Runtime.evaluate", {
        expression: `(() => {
          const track = document.getElementById("heroTrack");
          track.scrollTo({ left: track.clientWidth * ${args.slide - 1}, behavior: "auto" });
        })()`,
      });
      // 圆点是 scroll 事件里用 rAF 更新的，等两帧再截，否则会拍到上一页的高亮
      await client.send("Runtime.evaluate", {
        expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
        awaitPromise: true,
      });
    }

    if (args.script) {
      await client.send("Runtime.evaluate", { expression: args.script, awaitPromise: true });
    }

    await new Promise((resolve) => setTimeout(resolve, args.wait));

    // 打出真实状态，避免"截图看着对但其实没滑过去"这类误判。
    // 非首页（没有 heroTrack）时给一句说明就行，不要因为读不到轮播而整条命令失败。
    const { result: probe } = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => {
        const track = document.getElementById("heroTrack");
        if (!track) return { note: "当前页面没有轮播" };
        return {
          scrollLeft: Math.round(track.scrollLeft),
          pageWidth: track.clientWidth,
          activeDot: [...document.querySelectorAll(".hero-dot")].findIndex((d) => d.classList.contains("active")) + 1,
          dots: document.querySelectorAll(".hero-dot").length,
        };
      })())`,
      returnByValue: true,
    });

    const shot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: args.full,
    });
    fs.writeFileSync(args.out, Buffer.from(shot.data, "base64"));
    console.log(`已生成 ${args.out}`);
    console.log(`视口 ${args.width}x${args.height}，轮播状态 ${probe.value}`);
  } finally {
    if (client) client.close();
    child.kill();
    // Edge 退出后还会攥着 profile 里的文件一小会儿，删不掉不影响截图结果，忽略即可
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* 临时目录里的残留可以接受 */
    }
  }
}

main().catch((error) => {
  console.error("截图失败:", error.message);
  process.exit(1);
});
