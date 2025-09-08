/*
 NodeSeek 一体化脚本 (Surge)
 - HTTP 阶段：从请求 Cookie 或响应 Set-Cookie 抓取并合并到 NODESEEK_COOKIE（& 分隔多账号）
 - Cron 阶段：多账号签到（随机延迟/倒计时/收益统计/通知）
 - 可选开关（持久化写入即可，无需 $argument）：
    ONLY_SIGNIN=true/false     默认 false（true=仅签到，不统计）
    RANDOM_SIGNIN=true/false   默认 true
    MAX_RANDOM_DELAY=秒       默认 3600（会被自动裁剪）
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

// ==================== Cron 签到逻辑 ====================
function readConf(k, d = "") {
  const v = $persistentStore.read(k);
  return (v !== null && v !== undefined && v !== "") ? v : d;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const ONLY_SIGNIN   = String(readConf("ONLY_SIGNIN",   "false")).toLowerCase() === "true";
const NS_RANDOM     = String(readConf("NS_RANDOM",     "true" )).toLowerCase() === "true";
const RANDOM_SIGNIN = String(readConf("RANDOM_SIGNIN", "true" )).toLowerCase() === "true";
const MAX_RANDOM_DELAY = parseInt(readConf("MAX_RANDOM_DELAY", "3600"), 10) || 0;
const STATS_DAYS       = Math.max(1, parseInt(readConf("STATS_DAYS", "30"), 10) || 30);

// —— 固定限幅，防止脚本超时（Surge timeout=600 时建议 580）——
const SAFE_DELAY_CAP = 580; // 秒，写死不暴露为配置

const rawCookies = (readConf("NODESEEK_COOKIE", "") || "").trim();
const cookieList = rawCookies.split("&").map(s => s.trim()).filter(Boolean);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmt(sec) {
  if (sec <= 0) return "立即执行";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}小时${m}分${s}秒` : (m ? `${m}分${s}秒` : `${s}秒`);
}

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

  // —— 生成计划：随机延迟并自动裁剪到 ≤ SAFE_DELAY_CAP ——
  const plan = cookieList
    .map((ck, i) => {
      const rawDelay = RANDOM_SIGNIN ? Math.floor(Math.random() * (MAX_RANDOM_DELAY + 1)) : 0;
      const delay = Math.min(rawDelay, SAFE_DELAY_CAP);
      if (rawDelay !== delay) {
        console.log(`账号${i + 1} 随机延迟 ${rawDelay}s 超阈值，已裁剪为 ${delay}s`);
      }
      return { idx: i + 1, ck, delay };
    })
    .sort((a, b) => a.delay - b.delay);

  if (RANDOM_SIGNIN) {
    console.log("==== 签到时间表（随机，已限幅） ====");
    plan.forEach(p => console.log(`账号${p.idx}: 延迟 ${fmt(p.delay)}`));
  }

  // —— 执行 —— 
  for (const p of plan) {
    if (p.delay > 0) {
      let remain = p.delay;
      console.log(`账号${p.idx} 需要等待 ${fmt(remain)}`);
      while (remain > 0) {
        const step = remain <= 10 ? 1 : Math.min(10, remain);
        await sleep(step * 1000);
        remain -= step;
        if (remain <= 10 || remain % 10 === 0) console.log(`账号${p.idx} 倒计时: ${fmt(remain)}`);
      }
    }

    const ret = await doSign(p.ck);
    if (ret.status === "success" || ret.status === "already") {
      if (ONLY_SIGNIN) {
        $notification.post("NodeSeek ✅", `账号${p.idx}`, ret.msg || "OK");
      } else {
        const s = await getStats(p.ck, STATS_DAYS);
        $notification.post("NodeSeek ✅", `账号${p.idx}`, `${ret.msg}\n${s.period}已签到${s.count}天，共${s.total}个鸡腿，平均${s.avg}/天`);
      }
    } else {
      $notification.post("NodeSeek ❌", `账号${p.idx}`, ret.msg || "未知原因");
    }

    await sleep(600); // 账号间隔
  }

  console.log("==== 所有账号签到完成 ====");
  $done();
})();