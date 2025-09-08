/*
 NodeSeek 一体化脚本 (Surge) — 无延迟版
 - HTTP 阶段：从请求 Cookie 或响应 Set-Cookie 抓取并合并到 NODESEEK_COOKIE（& 分隔多账号）
 - Cron 阶段：多账号立即签到（无随机等待；账号间 600ms 间隔）
 - 可选开关（写入 $persistentStore 即可）：
    ONLY_SIGNIN=true/false     默认 false（true=仅签到，不统计）
    STATS_DAYS=天             默认 30
    NS_RANDOM=true/false      默认 true
*/

// ==================== 抓 Cookie（HTTP 请求/响应触发） ====================
if (typeof $request !== "undefined" || typeof $response !== "undefined") {
  try {
    const KEY = "NODESEEK_COOKIE";
    const url = ($request && $request.url) || "";

    // 请求头 Cookie
    const reqCK = ($request && ($request.headers?.Cookie || $request.headers?.cookie)) || "";

    // 响应头 Set-Cookie -> 拼接成 "k1=v1; k2=v2"
    let respCK = "";
    const setCookie = $response?.headers?.["Set-Cookie"] || $response?.headers?.["set-cookie"];
    if (setCookie) {
      const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
      respCK = arr.map(s => String(s).split(";")[0].trim()).filter(Boolean).join("; ");
    }

    const got = (reqCK && reqCK.trim()) || (respCK && respCK.trim()) || "";
    if (got) {
      const old = $persistentStore.read(KEY) || "";
      const set = new Set(old.split("&").map(s => s.trim()).filter(Boolean));
      set.add(got);
      const merged = Array.from(set).join("&");
      if (merged !== old) {
        $persistentStore.write(merged, KEY);
        const n = merged.split("&").filter(Boolean).length;
        $notification.post("NodeSeek", "✅ 获取Cookie成功", `已保存 ${n} 个账号${url ? "\nURL: " + url : ""}`);
        console.log("Saved NODESEEK_COOKIE:", merged);
      } else {
        console.log("Cookie unchanged.", url);
      }
    } else {
      console.log("No Cookie/Set-Cookie captured.", url);
    }
  } catch (e) {
    console.log("Cookie capture error:", String(e));
  }
  $done({});
}

// ==================== Cron 签到逻辑（无随机等待） ====================
function readConf(k, d = "") {
  const v = $persistentStore.read(k);
  return (v !== null && v !== undefined && v !== "") ? v : d;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const ONLY_SIGNIN   = String(readConf("ONLY_SIGNIN", "false")).toLowerCase() === "true";
const NS_RANDOM     = String(readConf("NS_RANDOM",   "true")).toLowerCase() === "true";
const STATS_DAYS    = Math.max(1, parseInt(readConf("STATS_DAYS", "30"), 10) || 30);

const rawCookies = (readConf("NODESEEK_COOKIE", "") || "").trim();
const cookieList = rawCookies.split("&").map(s => s.trim()).filter(Boolean);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url, headers = {}) {
  return new Promise(resolve => {
    $httpClient.get({ url, headers, timeout: 30 }, (err, resp, data) => resolve({ err, data }));
  });
}
function httpPost(url, headers = {}, body = "") {
  return new Promise(resolve => {
    $httpClient.post({ url, headers, body, timeout: 30 }, (err, resp, data) => resolve({ err, data }));
  });
}

async function doSign(cookie) {
  const headers = {
    "User-Agent": UA,
    "origin": "https://www.nodeseek.com",
    "referer": "https://www.nodeseek.com/board",
    "Content-Type": "application/json",
    "Cookie": cookie
  };
  const url = `https://www.nodeseek.com/api/attendance?random=${NS_RANDOM ? "true" : "false"}`;
  try {
    const { err, data } = await httpPost(url, headers, "");
    if (err) return { status: "error", msg: String(err) };
    const j = JSON.parse(data || "{}");
    const msg = j.message || "";
    if (j.success || msg.includes("鸡腿")) return { status: "success", msg };
    if (msg.includes("已完成签到")) return { status: "already", msg };
    if (j.status === 404) return { status: "invalid", msg };
    return { status: "fail", msg: msg || "未知错误" };
  } catch (e) {
    return { status: "error", msg: String(e) };
  }
}

async function getStats(cookie, days = 30) {
  const headers = {
    "User-Agent": UA,
    "origin": "https://www.nodeseek.com",
    "referer": "https://www.nodeseek.com/board",
    "Cookie": cookie
  };
  const start = Date.now() - days * 24 * 3600 * 1000;
  let all = [];
  for (let p = 1; p <= 10; p++) {
    const url = `https://www.nodeseek.com/api/account/credit/page-${p}`;
    const { err, data } = await httpGet(url, headers);
    if (err) break;
    const j = JSON.parse(data || "{}");
    if (!j.success || !Array.isArray(j.data) || j.data.length === 0) break;
    all = all.concat(j.data);
    await sleep(250);
  }
  const rec = all.filter(r => {
    const [amount, , desc, ts] = r;
    const t = Date.parse(ts) + 8 * 3600 * 1000; // UTC+8
    return t >= start && desc && desc.includes("签到收益") && desc.includes("鸡腿");
  });
  const total = rec.reduce((s, r) => s + Number(r[0] || 0), 0);
  const count = rec.length;
  const avg = count ? Math.round((total / count) * 100) / 100 : 0;
  return { total, count, avg, period: days === 1 ? "今天" : `近${days}天` };
}

(async () => {
  if (cookieList.length === 0) {
    $notification.post("NodeSeek 签到", "❌ 未找到Cookie", "请先用 Safari 登录 nodeseek.com 获取 Cookie");
    console.log("No cookies.");
    $done();
    return;
  }

  // —— 无延迟：按顺序直接签到（账号间 600ms 间隔） ——
  for (let i = 0; i < cookieList.length; i++) {
    const idx = i + 1;
    const ck  = cookieList[i];

    const ret = await doSign(ck);
    if (ret.status === "success" || ret.status === "already") {
      if (ONLY_SIGNIN) {
        $notification.post("NodeSeek ✅", `账号${idx}`, ret.msg || "OK");
      } else {
        const s = await getStats(ck, STATS_DAYS);
        $notification.post("NodeSeek ✅", `账号${idx}`, `${ret.msg}\n${s.period}已签到${s.count}天，共${s.total}个鸡腿，平均${s.avg}/天`);
      }
    } else {
      $notification.post("NodeSeek ❌", `账号${idx}`, ret.msg || "未知原因");
    }

    // 账号之间稍作间隔，避免过于密集
    await sleep(600);
  }

  console.log("==== 所有账号签到完成 ====");
  $done();
})();