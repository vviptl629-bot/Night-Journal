/**
 * 上线前冒烟测试：验证 SQLite 后端的注册 → 建碎片 → 读碎片 全链路。
 * 用 Node 内置 fetch，避免本机代理/PowerShell 响应体吞噬的干扰。
 *
 * 用法：node scripts/smoke-test.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3000";

let cookie = "";

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  return { status: res.status, text };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: res.status, text: await res.text() };
}

const lines = [];
function check(label, res, expect) {
  const ok = Array.isArray(expect) ? expect.includes(res.status) : res.status === expect;
  lines.push(`[${ok ? "OK" : "FAIL"}] ${label} -> ${res.status}`);
  const preview = res.text.length > 400 ? `${res.text.slice(0, 400)}...` : res.text;
  lines.push(`      ${preview}`);
  return ok;
}

try {
  const username = `smoke${Date.now().toString().slice(-6)}`;
  let pass = true;

  pass = check("register", await post("/api/auth/register", {
    username,
    password: "smoketest12345",
    name: "Smoke User",
  }), 201) && pass;

  pass = check("auth.me", await get(
    `/api/trpc/auth.me?batch=1&input=${encodeURIComponent('{"0":{"json":{}}}')}`,
  ), 200) && pass;

  const date = new Date().toISOString().slice(0, 10);
  pass = check("entries.create", await post(
    "/api/trpc/entries.create?batch=1",
    { 0: { json: { contentText: "smoke fragment", moodLabel: "calm", entryDate: date } } },
  ), 200) && pass;

  pass = check("entries.list", await get(
    `/api/trpc/entries.list?batch=1&input=${encodeURIComponent(
      JSON.stringify({ 0: { json: { date } } }),
    )}`,
  ), 200) && pass;

  pass = check("sw.js", await get("/sw.js"), 200) && pass;
  pass = check("manifest.json", await get("/manifest.json"), 200) && pass;

  lines.unshift(pass ? "SMOKE_RESULT=PASS" : "SMOKE_RESULT=FAIL");
} catch (err) {
  lines.unshift("SMOKE_RESULT=ERROR");
  lines.push(String(err));
}

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("../smoke-result.txt", import.meta.url), lines.join("\n"), "utf8");
console.log(lines.join("\n"));
