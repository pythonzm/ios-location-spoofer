import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const serverPath = fileURLToPath(new URL("../../server.js", import.meta.url));

test("Node server page searches through its authenticated proxy and handles result datums", async () => {
  const source = await readFile(serverPath, "utf8");
  assert.match(source, /id="city"[^>]*placeholder="城市（可选）"/);
  assert.match(source, /fetch\("\/search\?token="\+encodeURIComponent\(token\)/);
  assert.match(source, /city="\+encodeURIComponent\(\$\("city"\)\.value\.trim\(\)\)/);
  assert.match(source, /function searchResultPos\(it\)/);
  assert.match(source, /it\.datum==="gcj"\)return datum==="gcj"\?\[lat,lng\]:GCJ\.gcj2wgs/);
  assert.match(source, /name\.textContent=it\.name/);
  assert.match(source, /address\.textContent=it\.address/);
});

async function waitForServer(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(url);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("server did not start");
}

test("Node server returns normalized Amap place results without exposing the API key", async (t) => {
  let upstreamQuery;
  const upstream = http.createServer((req, res) => {
    upstreamQuery = new URL(req.url, "http://localhost").searchParams;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "1",
      pois: [{
        name: "上海市第一百货商店",
        address: "南京东路830号",
        pname: "上海市",
        cityname: "上海市",
        adname: "黄浦区",
        location: "121.480123,31.236456",
      }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const upstreamPort = upstream.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = "test-token";
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      TOKEN: token,
      AMAP_KEY: "secret-amap-key",
      AMAP_SEARCH_URL: `http://127.0.0.1:${upstreamPort}/v5/place/text`,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/loc.json?token=${token}`);
  const response = await fetch(`${base}/search?token=${token}&q=${encodeURIComponent("第一百货")}&city=${encodeURIComponent("上海")}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    name: "上海市第一百货商店",
    address: "上海市黄浦区南京东路830号",
    lat: 31.236456,
    lng: 121.480123,
    datum: "gcj",
    source: "amap",
  }]);
  assert.equal(upstreamQuery.get("keywords"), "第一百货");
  assert.equal(upstreamQuery.get("city"), "上海");
  assert.equal(upstreamQuery.get("key"), "secret-amap-key");
  assert.equal(response.headers.get("x-amap-key"), null);
});

test("Node server falls back to OpenStreetMap search when Amap is not configured", async (t) => {
  let upstreamQuery;
  const upstream = http.createServer((req, res) => {
    upstreamQuery = new URL(req.url, "http://localhost").searchParams;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{
      display_name: "人民广场, 黄浦区, 上海市, 中国",
      lat: "31.23234",
      lon: "121.47512",
    }]));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const upstreamPort = upstream.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = "test-token";
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      TOKEN: token,
      AMAP_KEY: "",
      NOMINATIM_SEARCH_URL: `http://127.0.0.1:${upstreamPort}/search`,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/loc.json?token=${token}`);
  const response = await fetch(`${base}/search?token=${token}&q=${encodeURIComponent("人民广场")}&city=${encodeURIComponent("上海")}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    name: "人民广场, 黄浦区, 上海市, 中国",
    address: "人民广场, 黄浦区, 上海市, 中国",
    lat: 31.23234,
    lng: 121.47512,
    datum: "wgs",
    source: "osm",
  }]);
  assert.equal(upstreamQuery.get("q"), "上海 人民广场");
  assert.equal(upstreamQuery.get("limit"), "10");
});

test("Node server falls back when Amap returns no places", async (t) => {
  const requestedPaths = [];
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requestedPaths.push(url.pathname);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (url.pathname === "/amap") {
      res.end(JSON.stringify({ status: "1", pois: [] }));
      return;
    }
    res.end(JSON.stringify([{
      display_name: "备用搜索结果",
      lat: "30.1",
      lon: "120.2",
    }]));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const upstreamPort = upstream.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = "test-token";
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      TOKEN: token,
      AMAP_KEY: "secret-amap-key",
      AMAP_SEARCH_URL: `http://127.0.0.1:${upstreamPort}/amap`,
      NOMINATIM_SEARCH_URL: `http://127.0.0.1:${upstreamPort}/osm`,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/loc.json?token=${token}`);
  const response = await fetch(`${base}/search?token=${token}&q=${encodeURIComponent("冷门地址")}`);

  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].name, "备用搜索结果");
  assert.deepEqual(requestedPaths, ["/amap", "/osm"]);
});
