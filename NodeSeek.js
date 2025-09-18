/*
 NodeSeek 一体化脚本 (Surge) —— 单账号版
 - 获取 CK：单账号、2 分钟间隔限制
 - 签到：支持“随机延迟”但**非阻塞**（避免 Surge Script Timeout）
   机制：在持久化中记录 NEXT_TS；未到时间就直接退出，由 Cron 下次再触发。
*/

// ========== HTTP-REQUEST：获取 Cookie（单账号 + 2分钟间隔） ==========
if (typeof $request !== "undefined") {
  try {
    const raw = $request.headers?.Cookie || $request.headers?.cookie || "";
    if (raw) {
      const KEY = "NODESEEK_COOKIE";
      const TIME_KEY = "NODESEEK_COOKIE_TIME";
      const now = Date.now();
      const lastTime = parseInt($persistentStore.read(TIME_KEY) || "0", 10);
      if (lastTime && now - lastTime < 120 * 1000) {
        console.log("获取Cookie请求过于频繁，距离上次不足2分钟，已忽略。");
        // 可注释掉通知
        // $notification.post("NodeSeek", "⚠️ 获取Cookie过于频繁", "距离上次不足 2 分钟，已忽略");
      } else {
        const parts = raw.split(/;\s*/).map(s => s.trim()).filter(Boolean);
        const pick = parts.find(p => /^nodeseek/i.test(p)) || parts.find(p => /session/i.test(p));
        const newCk = (pick || raw).trim();

        const old = $persistentStore.read(KEY) || "";
        if (newCk !== old) {
          $persistentStore.write(newCk, KEY);
          $persistentStore.write(String(now), TIME_KEY);
          const title = old ? "✅ 获取Cookie成功（已更新）" : "✅ 获取Cookie成功（已保存）";
          $notification.post("NodeSeek", title, "已保存 1 个账号");
          console.log("Saved NODESEEK_COOKIE:", newCk);
        } else {
          console.log("Cookie unchanged.");
        }
      }
    } else {
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

// 如果手动运行希望不延迟，可设置此变量为 true
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
    $httpClient.get({url,headers,timeout:30},(err,resp,data)=>resolve({err,data}));
  });
}
function httpPost(url, headers = {}, body="") {
  return new Promise(resolve=>{
    $httpClient.post({url,headers,body,timeout:30},(err,resp,data)=>resolve({err,data}));
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
    const j = JSON.parse(data || "{}");
    if (!j.success || !Array.isArray(j.data) || j.data.length===0) break;
    all = all.concat(j.data);
    await sleep(300);
  }
  const signin = all.filter(r=>{
    const [amount,,desc,ts] = r;
    const t = Date.parse(ts) + 8*3600*1000;
    return t >= queryStart && desc && desc.includes("签到收益") && desc.includes("鸡腿");
  });
  const total = signin.reduce((s,r)=>s + Number(r[0]||0), 0);
  const count = signin.length;
  const avg = count ? Math.round((total/count)*100)/100 : 0;
  return { total, count, avg, period: days===1 ? "今天" : `近${days}天` };
}

// ========== 主流程（Cron，单账号） ==========
(async () => {
  // 非阻塞随机延迟：通过持久化时间戳控制
  const NEXT_KEY = "NODESEEK_NEXT_TS";
  const now = Date.now();
  let nextTs = parseInt($persistentStore.read(NEXT_KEY) || "0", 10);
  if (RANDOM_SIGNIN && MAX_RANDOM_DELAY > 0) {
    // 手动运行时可跳过延迟
    if (!MANUAL_NO_DELAY) {
      // 保守：若未设定 nextTs，则设定
      if (!nextTs || now > nextTs + 24*3600*1000) {
        nextTs = now + Math.floor(Math.random() * (MAX_RANDOM_DELAY + 1)) * 1000;
        $persistentStore.write(String(nextTs), NEXT_KEY);
        console.log("已设置随机延迟，计划时间:", new Date(nextTs).toLocaleString());
        $notification.post("NodeSeek", "⏳ 已设置随机延迟", "计划执行时间：" + new Date(nextTs).toLocaleString());
        $done();
      } else if (now < nextTs) {
        console.log("未到计划时间，跳过。本次不阻塞。计划时间:", new Date(nextTs).toLocaleString());
        $done();
      } else {
        // 到点了，清掉标记继续执行
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
        `${ret.msg}\n${s.period}已签到${s.count}天，共${s.total}个鸡腿，平均${s.avg}/天`
      );
    }
  } else {
    $notification.post("NodeSeek 签到 ❌", "账号1", ret.msg || "未知原因");
  }

  console.log("==== 签到完成 ====");
  $done();
})();
