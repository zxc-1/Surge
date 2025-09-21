/**
 * GLaDOS 自动签到（Surge 版）
 * 原项目思路：POST /api/user/checkin + GET /api/user/status，Body: {"token":"glados.one"}
 * 参考： https://glados.rocks 以及 kingkare/GLaDOS（Python 实现）。 
 */

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; zh-CN; SM-G9750) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.1 Safari/605.1.15",
];

const API_BASE = "https://glados.rocks";
const CHECKIN_URL = `${API_BASE}/api/user/checkin`;
const STATUS_URL  = `${API_BASE}/api/user/status`;

// ------- 偏好项（到 Surge -> Scripts -> glados.surge.js 的 Arguments / 或用持久化键写入）-------
// 支持三种写法（二选一即可）：
// 1) 单账号：GLADOS_COOKIE
// 2) 多账号成对：GLADOS_EMAIL_1 / GLADOS_COOKIE_1，GLADOS_EMAIL_2 / GLADOS_COOKIE_2...
// 3) 批量：GLADOS_EMAILS（逗号分隔），GLADOS_COOKIES（逗号分隔）
//
// 可选 Telegram 推送（如果不填就只用 Surge 本地通知）：
// TG_BOT_TOKEN, TG_CHAT_ID
// ---------------------------------------------------------------------------------------------

const $prefs = {
  read: (k) => $persistentStore.read(k),
  write: (v, k) => $persistentStore.write(v, k),
};

function pickUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

function headers(cookie) {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    // 仓库里有一个占位 Authorization，这里不需要带；保持最小必需头
    "Content-Type": "application/json;charset=UTF-8",
    "Cookie": cookie,
    "Origin": API_BASE,
    "User-Agent": pickUA(),
  };
}

function httpPost(url, body, hdrs) {
  return new Promise((resolve, reject) => {
    $httpClient.post({ url, headers: hdrs, body: JSON.stringify(body) }, (err, resp, data) => {
      if (err) return reject(err);
      resolve({ status: resp?.status || resp?.statusCode, headers: resp?.headers, body: data });
    });
  });
}

function httpGet(url, hdrs) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, headers: hdrs }, (err, resp, data) => {
      if (err) return reject(err);
      resolve({ status: resp?.status || resp?.statusCode, headers: resp?.headers, body: data });
    });
  });
}

function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function translateMessage(raw) {
  if (raw === "Please Try Tomorrow") return "签到失败，请明天再试";
  if (typeof raw === "string" && raw.includes("Checkin! Got")) {
    const m = raw.match(/Got\s+(\d+(?:\.\d+)?)\s+Points/i);
    return m ? `签到成功，获得 ${m[1]} 积分` : "签到成功";
  }
  if (raw === "Checkin Repeats! Please Try Tomorrow") return "重复签到，请明天再试";
  return `未知的签到结果: ${raw ?? ""}`;
}

async function signOnce(email, cookie) {
  const hdrs = headers(cookie);
  try {
    const r1 = await httpPost(CHECKIN_URL, { token: "glados.one" }, hdrs);
    const j1 = JSON.parse(r1.body || "{}");
    const msg = translateMessage(j1.message);

    const r2 = await httpGet(STATUS_URL, hdrs);
    const j2 = JSON.parse(r2.body || "{}");
    const leftDaysRaw = j2?.data?.leftDays;
    const left = typeof leftDaysRaw === "number" ? leftDaysRaw.toString() : String(leftDaysRaw || "未知");

    return {
      ok: true,
      email: email || j2?.data?.email || "(未提供邮箱)",
      message: msg,
      leftDays: left,
    };
  } catch (e) {
    return { ok: false, email: email || "(未提供邮箱)", message: `请求异常：${e}`, leftDays: "error" };
  }
}

function parseAccounts() {
  // 单账号
  const single = $prefs.read("GLADOS_COOKIE");
  if (single) return [{ email: $prefs.read("GLADOS_EMAIL") || "", cookie: single }];

  // 批量（逗号）
  const emailsBulk = ($prefs.read("GLADOS_EMAILS") || "").split(",").map(s => s.trim()).filter(Boolean);
  const cookiesBulk = ($prefs.read("GLADOS_COOKIES") || "").split(",").map(s => s.trim()).filter(Boolean);
  if (emailsBulk.length && emailsBulk.length === cookiesBulk.length) {
    return emailsBulk.map((e, i) => ({ email: e, cookie: cookiesBulk[i] }));
  }

  // 编号键
  const acc = [];
  for (let i = 1; i <= 20; i++) {
    const e = $prefs.read(`GLADOS_EMAIL_${i}`);
    const c = $prefs.read(`GLADOS_COOKIE_${i}`);
    if (!c) break;
    acc.push({ email: e || "", cookie: c });
  }
  return acc;
}

async function sendTelegram(summaryText) {
  const token = $prefs.read("TG_BOT_TOKEN");
  const chatId = $prefs.read("TG_CHAT_ID");
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: summaryText,
    parse_mode: "HTML"
  };

  return new Promise((resolve) => {
    $httpClient.post(
      {
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      (_e, _r, _d) => resolve()
    );
  });
}

(async () => {
  const accounts = parseAccounts();
  if (!accounts.length) {
    $notification.post("GLaDOS 签到", "未配置 Cookie", "请在持久化存储写入 GLADOS_COOKIE 或 GLADOS_COOKIE_1 等键");
    return $done();
  }

  const results = [];
  for (const { email, cookie } of accounts) {
    // 防止过快，轻微随机延时（0~2s），避免风控
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000)));
    results.push(await signOnce(email, cookie));
  }

  const success = results.filter(r => r.ok && r.message.includes("成功")).length;
  const repeats = results.filter(r => r.ok && r.message.includes("重复")).length;
  const failed  = results.filter(r => !r.ok || r.message.includes("失败")).length;

  // 本地通知
  const lines = results.map(r => `• ${r.email} | ${r.message} | 剩余: ${r.leftDays} 天`);
  const title = `GLaDOS 签到（${nowStr()}）`;
  const subtitle = `成功 ${success}，重复 ${repeats}，失败 ${failed}`;
  $notification.post(title, subtitle, lines.join("\n"));

  // 可选：Telegram 推送
  const tgText = [
    `当前时间: ${nowStr()}`,
    "",
    "GLaDOS 签到结果：",
    ...results.map(r => `- ${r.email}: ${r.message}`),
    "",
    "账号状态：",
    ...results.map(r => `- ${r.email}: 剩余 ${r.leftDays} 天`)
  ].join("\n");
  await sendTelegram(tgText);

  $done();
})();