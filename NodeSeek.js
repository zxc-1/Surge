/*
 NodeSeek 一体化脚本 (Surge) —— 单账号版（非阻塞随机延迟 + CK 可见 + 无频率限制）
 - HTTP-Request：抓取并显示 Cookie（完整展示），只保存一个账号，不做 2 分钟频率限制
 - Cron：非阻塞随机延迟（通过持久化 NEXT_TS 计划时间），到点再真正执行；避免 Script Timeout
 - 变量：
   ONLY_SIGNIN=true/false   默认 false；true 时仅签到，不做统计
   RANDOM_SIGNIN=true/false 默认 true
   MAX_RANDOM_DELAY=秒     默认 3600
   STATS_DAYS=天数         默认 30
   NS_RANDOM=true/false    默认 true
   MANUAL_NO_DELAY=true/false 默认 true（手动运行不等待）
*/



// ========== HTTP-REQUEST：获取 Cookie（可见，无频率限制） ==========
if (typeof $request !== "undefined") {
  try {
    const raw = $request.headers?.Cookie || $request.headers?.cookie || "";
    if (raw) {
      const KEY = "NODESEEK_COOKIE";
      const trimmed = String(raw).trim();
      const old = $persistentStore.read(KEY) || "";
      if (trimmed !== old) {
        $persistentStore.write(trimmed, KEY);
        $notification.post("NodeSeek", "✅ 获取Cookie成功（已保存/更新）", trimmed);
      } else {
        $notification.post("NodeSeek", "ℹ️ Cookie 未变化（已存在）", trimmed);
      }
      console.log("Captured Cookie:", trimmed);
    } else {
      $notification.post("NodeSeek", "❌ 无 Cookie", "本次请求未携带 Cookie");
      console.log("No Cookie header.");
    }
  } catch (e) {
    console.log("GetCookie error:", String(e));
  }
  $done({});
}

// ========== 配置读取 ==========
function readConf(key, defVal="") {
  const v = $persistentStore.read(key);
  return (v !== null && v !== undefined && v !== "") ? v : defVal;
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const ONLY_SIGNIN = String(readConf("ONLY_SIGNIN", "false")).toLowerCase() === "true";
const NS_RANDOM = String(readConf("NS_RANDOM", "true")).toLowerCase() === "true";
const RANDOM_SIGNIN = String(readConf("RANDOM_SIGNIN", "true")).toLowerCase() === "true";
const MAX_RANDOM_DELAY = parseInt(readConf("MAX_RANDOM_DELAY", "3600"), 10) || 0;
const STATS_DAYS = Math.max(1, parseInt(readConf("STATS_DAYS", "30"), 10) || 30);
const MANUAL_NO_DELAY = String(readConf("MANUAL_NO_DELAY", "true")).toLowerCase() === "true";

const cookie = (readConf("NODESEEK_COOKIE", "") || "").trim();
if (!cookie) {
  $notification.post("NodeSeek 签到","❌ 未找到Cookie","请先访问网站以获取 Cookie");
  $done();
}

// ========== 工具 ==========
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function httpGet(url, headers = {}) {
  return new Promise(resolve=>{
    $httpClient.get({url,headers,timeout:30},(err,resp,data)=>resolve({err,resp,data}));
  });
}
function httpPost(url, headers = {}, body="") {
  return new Promise(resolve=>{
    $httpClient.post({url,headers,body,timeout:30},(err,resp,data)=>resolve({err,resp,data}));
  });
}

// ========== 签到 ==========
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
    const { err, resp, data } = await httpPost(url, headers, "");
    if (err) return { status: "error", msg: String(err) };
    // 非 JSON 保护：被验证或未登录会返回 HTML（以 "<" 开头）
    if (!data || typeof data !== "string" || data.trim().charAt(0) !== "{") {
      const code = (resp && resp.status) ? `HTTP ${resp.status}` : "";
      return { status: "error", msg: `返回非 JSON，可能 CK 失效/需人机验证 ${code}` };
    }
    const j = JSON.parse(data || "{}");
    const msg = j.message || "";
    if (j.success || msg.indexOf("鸡腿") >= 0) return { status: "success", msg };
    if (msg.indexOf("已完成签到") >= 0) return { status: "already", msg };
    if (j.status === 404) return { status: "invalid", msg };
    return { status: "fail", msg: msg || "未知错误" };
  } catch (e) {
    return { status: "error", msg: String(e) };
  }
}

// ========== 统计（可选） ==========
async function getStats(cookie, days=30) {
  const headers = {
    "User-Agent": UA,
    "origin": "https://www.nodeseek.com",
    "referer": "https://www.nodeseek.com/board",
    "Cookie": cookie
  };
  const now = Date.now();
  const queryStart = now - days*24*3600*1000;
  let all = [];
  for (let p=1; p<=10; p++) {
    const url = `https://www.nodeseek.com/api/account/credit/page-${p}`;
    const { err, data } = await httpGet(url, headers);
    if (err) break;
    if (!data || typeof data !== "string" || data.trim().charAt(0) !== "{") break;
    const j = JSON.parse(data || "{}");
    if (!j.success || !Array.isArray(j.data) || j.data.length===0) break;
    all = all.concat(j.data);
    await sleep(300);
  }
  const signin = all.filter(r=>{
    const desc = r && r[2];
    const ts = r && r[3];
    const t = Date.parse(ts || "") + 8*3600*1000; // UTC+8
    return t >= queryStart && desc && desc.indexOf("签到收益") >= 0 && desc.indexOf("鸡腿") >= 0;
  });
  const total = signin.reduce((s,r)=>s + Number(r && r[0] || 0), 0);
  const count = signin.length;
  const avg = count ? Math.round((total/count)*100)/100 : 0;
  return { total, count, avg, period: days===1 ? "今天" : `近${days}天` };
}

// ========== 主流程（Cron，非阻塞随机延迟，单账号） ==========
(async () => {
  const NEXT_KEY = "NODESEEK_NEXT_TS";
  const now = Date.now();
  let nextTs = parseInt($persistentStore.read(NEXT_KEY) || "0", 10);

  if (RANDOM_SIGNIN && MAX_RANDOM_DELAY > 0) {
    if (!MANUAL_NO_DELAY) {
      if (!nextTs || now > nextTs + 24*3600*1000) {
        nextTs = now + Math.floor(Math.random() * (MAX_RANDOM_DELAY + 1)) * 1000;
        $persistentStore.write(String(nextTs), NEXT_KEY);
        console.log("已设置随机延迟，计划时间:", new Date(nextTs).toLocaleString());
        $notification.post("NodeSeek", "⏳ 已设置随机延迟", "计划执行时间：" + new Date(nextTs).toLocaleString());
        return $done();
      } else if (now < nextTs) {
        console.log("未到计划时间，跳过。本次不阻塞。计划时间:", new Date(nextTs).toLocaleString());
        return $done();
      } else {
        $persistentStore.write("", NEXT_KEY);
      }
    }
  }

  const ret = await doSign(cookie);
  if (ret.status === "success" || ret.status === "already") {
    if (ONLY_SIGNIN) {
      $notification.post("NodeSeek 签到 ✅", "账号1", ret.msg || "OK");
    } else {
      const s = await getStats(cookie, STATS_DAYS);
      $notification.post(
        "NodeSeek 签到 ✅",
        "账号1",
        (ret.msg || "OK") + "\\n" + (s.period + "已签到" + s.count + "天，共" + s.total + "个鸡腿，平均" + s.avg + "/天")
      );
    }
  } else {
    $notification.post("NodeSeek 签到 ❌", "账号1", ret.msg || "未知原因");
  }

  console.log("==== 签到完成 ====");
  $done();
})();
