// Mercari JP listing tracker for GitHub Actions (Node 22, no dependencies).
// For every search in config.json it fetches the newest on-sale listings, applies the optional
// title filters, and pushes listings it has not seen before to the ntfy app.
// Listings already notified are stored in seen.json in this repo (written through the GitHub API).
//
// Env: NTFY_TOPIC (required), GITHUB_TOKEN + GITHUB_REPOSITORY (set by Actions),
//      CHECKS (checks per run, default 1), INTERVAL_SEC (gap between checks, default 180)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const MERCARI_API = "https://api.mercari.jp/v2/entities:search";
const STATE_FILE = "seen.json";
const NTFY_TOPIC = (process.env.NTFY_TOPIC || "").trim();
const CHECKS = Number(process.env.CHECKS || 1);
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 180);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 0); // >0: keep checking for this long (one long Actions run)
const ACTIVE_HOURS = (process.env.ACTIVE_HOURS_JST || "").split("-").map(Number); // e.g. "8-24" (Japan time)
const inActiveHours = () => {
  if (ACTIVE_HOURS.length !== 2 || ACTIVE_HOURS.some(isNaN)) return true;
  const h = (new Date().getUTCHours() + 9) % 24;
  return h >= ACTIVE_HOURS[0] && h < ACTIVE_HOURS[1];
};
const MAX_NOTIFY = 12; // individual notifications per check; the rest are summarised in one

const norm = (s) => (s || "").normalize("NFKC").toLowerCase().replace(/[\s\-_.・]/g, "");
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((s) => s.trim());
const ints = (v) => (v ? v.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

// ---------- config ----------
let CONFIG_HASH = "";
function loadConfig() {
  let cfg;
  try {
    const raw = readFileSync("config.json", "utf8").replace(/^﻿/, "");
    CONFIG_HASH = createHash("sha1").update(raw).digest("hex").slice(0, 12);
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config.json tidak valid: ${e.message}`);
  }
  const searches = (cfg.searches || []).map((s, i) => {
    const label = `searches[${i}]`;
    let url;
    try { url = new URL(s.url); } catch { throw new Error(`${label}: "url" bukan link yang valid`); }
    if (!/(^|\.)mercari\.com$/.test(url.hostname)) throw new Error(`${label}: "url" harus link jp.mercari.com/search`);
    const p = url.searchParams;
    const keyword = (p.get("keyword") || "").trim();
    if (!keyword) throw new Error(`${label}: link pencarian tidak berisi keyword`);
    return {
      name: (s.name || keyword).trim(),
      keyword,
      excludeKeyword: p.get("exclude_keyword") || "",
      priceMin: Number(p.get("price_min") || 0),
      priceMax: Number(p.get("price_max") || 0),
      categoryId: ints(p.get("category_id")),
      brandId: ints(p.get("brand_id")),
      itemConditionId: ints(p.get("item_condition_id")),
      mustMatch: list(s.mustMatch).map(norm),
      labels: (s.labels || []).map((l) => ({ name: String(l.name), match: list(l.match).map(norm) })),
      exclude: list(s.exclude).map(norm),
      page: `https://jp.mercari.com/search?${p.toString()}`,
    };
  });
  if (!searches.length) throw new Error('config.json belum berisi pencarian di "searches"');
  const cat = cfg.categoryFilter || {};
  const allow = new Set(list(cat.allow)), block = new Set(list(cat.block)), titleOk = list(cat.titleFallback).map(norm);
  const blockExcept = list(cat.blockUnlessTitle).map(norm);
  for (const s of searches) Object.assign(s, { catAllow: allow, catBlock: block, catTitle: titleOk, catBlockExcept: blockExcept });
  return searches;
}

function isTarget(search, item) {
  const n = norm(item.name);
  if (item.auction) return false; // only fixed-price (Buy now) listings
  if (search.exclude.some((x) => n.includes(x))) return false;
  if (search.catBlock.has(item.categoryId) && search.catBlockExcept.some((t) => n.includes(t))) {
    // e.g. a buckle listed under the leather-strap category: keep it
  } else if (search.catAllow.size && !search.catAllow.has(item.categoryId)) {
    // unknown category: accept only if not a blocked category and the title clearly says it is a watch
    if (search.catBlock.has(item.categoryId) || !search.catTitle.some((t) => n.includes(t))) return false;
  }
  return search.mustMatch.length === 0 || search.mustMatch.some((m) => n.includes(m));
}

// ---------- DPoP token (ES256 JWT that Mercari's API requires) ----------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const b64uText = (s) => b64u(new TextEncoder().encode(s));

async function makeDpop(url, method) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y } };
  const payload = { iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), htu: url, htm: method, uuid: crypto.randomUUID() };
  const input = b64uText(JSON.stringify(header)) + "." + b64uText(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(input));
  return input + "." + b64u(sig);
}

// ---------- Mercari search ----------
async function searchMercari(s) {
  const body = {
    userId: "", pageSize: 60, pageToken: "",
    searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
    searchCondition: {
      keyword: s.keyword, excludeKeyword: s.excludeKeyword, sort: "SORT_CREATED_TIME", order: "ORDER_DESC", status: ["STATUS_ON_SALE"],
      sizeId: [], categoryId: s.categoryId, brandId: s.brandId, sellerId: [], priceMin: s.priceMin, priceMax: s.priceMax,
      itemConditionId: s.itemConditionId, shippingPayerId: [], shippingFromArea: [], shippingMethod: [],
      colorId: [], hasCoupon: false, attributes: [], itemTypes: [], skuIds: [],
    },
    defaultDatasets: ["DATASET_TYPE_MERCARI", "DATASET_TYPE_BEYOND"], serviceFrom: "suruga",
    withItemBrand: true, withItemSize: false, withItemPromotions: true, withItemSizes: true, withShopname: false,
    withAuction: true, // without this the "auction" field is always null
  };
  const res = await fetch(MERCARI_API, {
    method: "POST",
    headers: {
      DPoP: await makeDpop(MERCARI_API, "POST"),
      "X-Platform": "web",
      "Content-Type": "application/json; charset=utf-8",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Mercari HTTP ${res.status}: ${(await res.text()).slice(0, 150).replace(/\s+/g, " ")}`);
  const json = await res.json();
  return (json.items || []).map((it) => {
    const shop = it.itemType === "ITEM_TYPE_BEYOND";
    return {
      id: it.id,
      name: it.name,
      price: Number(it.price),
      categoryId: String(it.categoryId || ""),
      auction: !!it.auction,
      url: shop ? `https://jp.mercari.com/shops/product/${it.id}` : `https://jp.mercari.com/item/${it.id}`,
      thumb: it.thumbnails && it.thumbnails[0],
      search: (s.labels.find((l) => l.match.some((m) => norm(it.name).includes(m))) || s).name,
    };
  });
}

async function getTargets(searches) {
  const byId = new Map();
  for (const [i, s] of searches.entries()) {
    if (i > 0) await sleep(400); // be gentle with Mercari when there are many searches
    for (const it of await searchMercari(s)) if (!byId.has(it.id) && isTarget(s, it)) byId.set(it.id, it);
  }
  return [...byId.values()];
}

// ---------- ntfy ----------
async function notify(msg) {
  try { await sendNtfy(msg); } catch (e) { console.log(`ntfy gagal: ${e.message}`); }
}
async function sendNtfy({ title, message, url, image, tags = ["shopping_cart"], priority = 4 }) {
  const payload = { topic: NTFY_TOPIC, title, message, priority, tags };
  if (url) { payload.click = url; payload.actions = [{ action: "view", label: "Buka listing", url }]; }
  if (image) payload.attach = image;
  const r = await fetch("https://ntfy.sh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) console.log(`ntfy HTTP ${r.status}`);
}

// ---------- state (seen.json) ----------
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/${STATE_FILE}`;
const ghHeaders = () => ({ Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "mercari-tracker" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseState = (text) => {
  const s = JSON.parse(text.replace(/^﻿/, ""));
  return { ids: s.ids || null, fails: s.fails || 0, cfg: s.cfg || "" };
};

async function loadState() {
  if (!GH_TOKEN) return { state: existsSync(STATE_FILE) ? parseState(readFileSync(STATE_FILE, "utf8")) : { ids: null, fails: 0 }, sha: null };
  const r = await fetch(GH_URL, { headers: ghHeaders() });
  if (r.status === 404) return { state: { ids: null, fails: 0 }, sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
  const j = await r.json();
  return { state: parseState(Buffer.from(j.content, "base64").toString("utf8")), sha: j.sha };
}

async function updateState(mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, sha } = await loadState();
    mutate(state);
    if (state.ids) state.ids = state.ids.slice(-20000);
    const text = JSON.stringify(state) + "\n";
    if (!GH_TOKEN) { writeFileSync(STATE_FILE, text); return state; }
    const r = await fetch(GH_URL, {
      method: "PUT",
      headers: ghHeaders(),
      body: JSON.stringify({ message: "Update seen listings", content: Buffer.from(text).toString("base64"), sha: sha || undefined }),
    });
    if (r.ok) return state;
    if (r.status === 403) throw new Error("GitHub PUT 403: aktifkan Settings > Actions > General > Workflow permissions > Read and write permissions");
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub PUT ${r.status}`);
    await sleep(1000 + Math.random() * 2000); // another run wrote at the same moment; reload and retry
  }
  throw new Error("Gagal menyimpan seen.json setelah 5x");
}

const addIds = (ids, more) => [...new Set([...(ids || []), ...more])];
const yen = (n) => n.toLocaleString("en-US");

async function checkOnce(searches) {
  const { state } = await loadState();
  let items;
  try {
    items = await getTargets(searches);
  } catch (e) {
    const s = await updateState((st) => { st.fails += 1; });
    console.log(`GAGAL (${s.fails}x berturut-turut): ${e.message}`);
    if (s.fails === 5) await notify({ title: "Mercari tracker bermasalah", message: `5x gagal berturut-turut: ${e.message}`, url: searches[0].page, tags: ["rotating_light"] });
    return;
  }

  if (state.ids && state.cfg !== CONFIG_HASH) {
    // config.json changed (e.g. new brands): record what is already listed instead of flooding notifications
    const added = items.filter((i) => !state.ids.includes(i.id)).length;
    await updateState((st) => { st.ids = addIds(st.ids, items.map((i) => i.id)); st.fails = 0; st.cfg = CONFIG_HASH; });
    const names = [...new Set(searches.map((s) => s.name))];
    console.log(`Config berubah: ${added} listing lama dicatat tanpa notifikasi.`);
    await notify({ title: "Mercari tracker diperbarui", message: `Sekarang memantau ${names.length} pencarian: ${names.join(", ")}. ${added} listing yang sudah ada dicatat; listing baru berikutnya dikirim ke sini.`, tags: ["gear"], priority: 3 });
    return;
  }

  if (!state.ids) {
    await updateState((st) => { st.ids = addIds(st.ids, items.map((i) => i.id)); st.fails = 0; st.cfg = CONFIG_HASH; });
    const names = [...new Set(searches.map((s) => s.name))].join(", ");
    console.log(`Run pertama: ${items.length} listing dicatat (${names}).`);
    await notify({ title: "Mercari tracker aktif", message: `Memantau: ${names}. ${items.length} listing yang sudah ada dicatat; listing baru berikutnya dikirim ke sini.`, url: searches[0].page });
    return;
  }

  const seen = new Set(state.ids);
  const fresh = items.filter((i) => !seen.has(i.id));
  // save first, so a failed notification never causes the same listing to be sent again and again
  if (fresh.length || state.fails) await updateState((st) => { st.ids = addIds(st.ids, fresh.map((n) => n.id)); st.fails = 0; });
  for (const [i, n] of fresh.entries()) {
    console.log(`BARU [${n.search}]: ${n.price} yen | ${n.name} | ${n.url}`);
    if (i < MAX_NOTIFY) {
      if (i > 0) await sleep(1500); // ntfy.sh rejects bursts (HTTP 429)
      await notify({ title: `${n.search}: ${yen(n.price)} yen`, message: n.name, url: n.url, image: n.thumb });
    }
  }
  if (fresh.length > MAX_NOTIFY) {
    const rest = fresh.slice(MAX_NOTIFY);
    await sleep(1500);
    await notify({ title: `+${rest.length} listing baru lainnya`, message: rest.slice(0, 15).map((n) => `${n.search} ${yen(n.price)} yen: ${n.name.slice(0, 40)}`).join("\n"), tags: ["package"], priority: 3 });
  }
  console.log(`OK: ${items.length} listing dicek, ${fresh.length} baru.`);
}

// ---------- main ----------
if (!NTFY_TOPIC) {
  console.log("Secret NTFY_TOPIC belum diisi (Settings > Secrets and variables > Actions).");
  process.exit(process.env.GITHUB_EVENT_NAME === "schedule" ? 0 : 1);
}
let searches;
try {
  searches = loadConfig();
} catch (e) {
  console.log(e.message);
  process.exit(1);
}
for (const s of searches) console.log(`Pencarian: ${s.name} | ${s.page}`);
if (!inActiveHours()) {
  console.log(`Di luar jam aktif (${process.env.ACTIVE_HOURS_JST} waktu Jepang), tidak mengecek.`);
  process.exit(0);
}
const started = Date.now();
for (let i = 0; RUN_MINUTES > 0 ? true : i < CHECKS; i++) {
  if (i > 0) await sleep(INTERVAL_SEC * 1000);
  if (RUN_MINUTES > 0 && Date.now() - started > RUN_MINUTES * 60000) break;
  if (!inActiveHours()) { console.log("Jam aktif selesai, berhenti sampai besok pagi."); break; }
  try { await checkOnce(searches); } catch (e) { console.log(`ERROR: ${e.message}`); }
}
