import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const serverPath = fileURLToPath(new URL("../../server.js", import.meta.url));

async function waitForServer(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status !== 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("server did not start");
}

test("Node server persists favorites independently of browser storage", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "location-picker-favorites-"));
  const favoritesFile = path.join(dataDir, "favorites.json");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = "test-token";
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(port),
      TOKEN: token,
      DATA_FILE: path.join(dataDir, "loc.json"),
      FAVORITES_FILE: favoritesFile,
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  });

  const endpoint = `http://127.0.0.1:${port}/favorites?token=${token}`;
  await waitForServer(`http://127.0.0.1:${port}/loc.json?token=${token}`);

  const favorite = {
    name: "公司",
    lat: 31.2304,
    lng: 121.4737,
    alt: 12,
    hacc: 39,
    vacc: 1000,
    ts: 123456789,
  };
  const saved = await fetch(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([favorite]),
  });
  assert.equal(saved.status, 200);

  // A fresh GET represents reopening the page after all browser data was cleared.
  const loaded = await fetch(endpoint);
  assert.equal(loaded.status, 200);
  assert.deepEqual(await loaded.json(), [favorite]);
  assert.deepEqual(JSON.parse(await readFile(favoritesFile, "utf8")), [favorite]);
});
