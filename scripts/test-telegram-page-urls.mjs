import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const reader = await readFile(new URL("../reader.js", import.meta.url), "utf8");

function declaration(name) {
  const start = reader.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const open = reader.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < reader.length; i += 1) {
    if (reader[i] === "{") depth += 1;
    if (reader[i] === "}") {
      depth -= 1;
      if (depth === 0) return reader.slice(start, i + 1);
    }
  }
  assert.fail(`Unclosed function ${name}`);
}

const context = {};
vm.runInNewContext(
  `${declaration("isTelegramPostUrl")}\n${declaration("usableTelegramImageUrl")}\nglobalThis.helpers = { isTelegramPostUrl, usableTelegramImageUrl };`,
  context
);
const { isTelegramPostUrl, usableTelegramImageUrl } = context.helpers;

for (const url of [
  "https://t.me/example_comic/123",
  "https://www.t.me/example_comic/123",
  "https://telegram.me/example_comic/123",
  "https://t.me/c/4424843914/123"
]) {
  assert.equal(isTelegramPostUrl(url), true, `Should identify Telegram permalink: ${url}`);
  assert.equal(usableTelegramImageUrl(url), "", `Must not use a Telegram permalink as an image: ${url}`);
  assert.equal(usableTelegramImageUrl({ url }), "", `Must reject permalink objects too: ${url}`);
}

const endpoint = "https://vqfmbpqurapcsuixgvql.supabase.co/functions/v1/telegram-page-image?item_id=edition&page=1";
assert.equal(usableTelegramImageUrl(endpoint), endpoint);
assert.equal(usableTelegramImageUrl({ url: endpoint }), endpoint);
assert.equal(usableTelegramImageUrl({ src: endpoint }), endpoint);
assert.equal(usableTelegramImageUrl({ url: "https://t.me/example_comic/123", src: endpoint }), endpoint);
assert.equal(usableTelegramImageUrl("https://example.com/page-1.jpg"), "https://example.com/page-1.jpg");
assert.equal(usableTelegramImageUrl("data:image/jpeg;base64,abc"), "");
assert.equal(usableTelegramImageUrl(""), "");

const normalizeStart = reader.indexOf("function normalizeItem(edition)");
const normalizeEnd = reader.indexOf("\nfunction showEmptyReader", normalizeStart);
assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, "Could not inspect normalizeItem.");
const normalize = reader.slice(normalizeStart, normalizeEnd);
assert.ok((normalize.match(/\.map\(usableTelegramImageUrl\)\.filter\(Boolean\)/g) || []).length >= 2,
  "Both page sources must filter unusable Telegram post URLs.");
assert.ok(normalize.includes('edition.telegramBaseUrl || window.BANCA_SUPABASE_URL'),
  "Image fallback must honor the edition's configured Supabase endpoint.");
assert.ok(normalize.includes("/functions/v1/telegram-page-image"),
  "Missing canonical Telegram page-image endpoint.");

console.log("Telegram page URL regression tests passed.");
