const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("本机口令在首次运行生成并在之后保持不变", async () => {
  const { loadOrCreateAccessToken, pairResponseHeaders } = await import("../server/local-token.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytds-token-"));
  const file = path.join(dir, ".local-token");
  const first = loadOrCreateAccessToken(file);
  const second = loadOrCreateAccessToken(file);
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(second, first);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.writeFileSync(file, "not-a-token\n");
  const replaced = loadOrCreateAccessToken(file);
  assert.match(replaced, /^[0-9a-f]{48}$/);
  assert.notEqual(replaced, "not-a-token");
  assert.equal(loadOrCreateAccessToken(file), replaced);

  const extension = pairResponseHeaders("chrome-extension://abcdefghijklmnop");
  assert.equal(extension.status, 200);
  assert.equal(extension.headers["Access-Control-Allow-Origin"], "chrome-extension://abcdefghijklmnop");

  const localClient = pairResponseHeaders("");
  assert.equal(localClient.status, 200);
  assert.equal(localClient.headers["Access-Control-Allow-Origin"], undefined);

  for (const origin of ["https://www.youtube.com", "https://evil.example"]) {
    const blocked = pairResponseHeaders(origin);
    assert.equal(blocked.status, 403, origin);
    assert.equal(blocked.headers["Access-Control-Allow-Origin"], undefined, origin);
    assert.equal(JSON.stringify(blocked).includes("token"), false);
  }
});

test("服务端不再内嵌固定口令，配对响应只在允许时带口令", () => {
  const server = fs.readFileSync(path.join(root, "server", "server.mjs"), "utf8");
  assert.doesNotMatch(server, /ACCESS_TOKEN\s*=\s*["'][0-9a-fA-F]{16,}["']/);
  assert.match(server, /loadOrCreateAccessToken/);
  assert.match(server, /pairResponseHeaders/);
  assert.match(server, /decision\.status === 200/);
  assert.match(server, /x-ytds-token/);
  assert.match(server, /\.local-token/);
});
