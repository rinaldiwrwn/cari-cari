// Temporary: find how auctions are marked. Will be deleted.
const API = "https://api.mercari.jp/v2/entities:search";
const b64u = (b) => Buffer.from(b).toString("base64url");
const t = (s) => b64u(new TextEncoder().encode(s));
async function dpop(url, m) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const j = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const i = t(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: { crv: "P-256", kty: "EC", x: j.x, y: j.y } })) + "." +
    t(JSON.stringify({ iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), htu: url, htm: m, uuid: crypto.randomUUID() }));
  const s = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(i));
  return i + "." + b64u(s);
}
const H = async (url, m) => ({ DPoP: await dpop(url, m), "X-Platform": "web", Accept: "application/json",
  "Content-Type": "application/json; charset=utf-8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" });
const ids = "m28458513435 m43809576976 m61144491505 m51061592697 m81327263294 m16893137105 m26908563116 m89081787120 m10525607703 m60263814384 m36903335888 m22770525167 m49292074405 m42963597121 m42234386074 m10442265661 m32179858917 m46485944878 m94832176327".split(" ");
const pick = (o, path = "") => { const out = []; const walk = (v, p) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const np = p ? p + "." + k : k; if (/auction|bid|sale_type|selling_type|price_type/i.test(k)) out.push(np + "=" + JSON.stringify(x).slice(0, 300)); walk(x, np); } }; walk(o, path); return out; };
let shown = 0;
for (const id of ids) {
  const u = `https://api.mercari.jp/items/get?id=${id}&include_item_attributes=true&include_auction=true`;
  const r = await fetch(u, { headers: await H("https://api.mercari.jp/items/get", "GET") });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { console.log(id, r.status, txt.slice(0, 200)); continue; }
  const d = j.data || j;
  console.log("ITEM", id, r.status, "status=" + d.status, "price=" + d.price, "|", pick(d).join(" ; ") || "(no auction-like keys)");
  if (shown < 1 && r.ok) { console.log("KEYS", Object.keys(d).join(",")); shown++; }
  await new Promise((s) => setTimeout(s, 300));
}
// search with candidate flags
for (const extra of [{}, { withAuction: true }, { withAuctionInfo: true }]) {
  const body = { userId: "", pageSize: 120, pageToken: "", searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
    searchCondition: { keyword: "腕時計", excludeKeyword: "", sort: "SORT_CREATED_TIME", order: "ORDER_DESC", status: ["STATUS_ON_SALE"],
      sizeId: [], categoryId: [], brandId: [], sellerId: [], priceMin: 0, priceMax: 0, itemConditionId: [], shippingPayerId: [],
      shippingFromArea: [], shippingMethod: [], colorId: [], hasCoupon: false, attributes: [], itemTypes: [], skuIds: [] },
    defaultDatasets: ["DATASET_TYPE_MERCARI", "DATASET_TYPE_BEYOND"], serviceFrom: "suruga",
    withItemBrand: true, withItemSize: false, withItemPromotions: true, withItemSizes: true, withShopname: false, ...extra };
  const r = await fetch(API, { method: "POST", headers: await H(API, "POST"), body: JSON.stringify(body) });
  const j = await r.json(); const items = j.items || [];
  const a = items.filter((i) => i.auction);
  console.log("SEARCH", JSON.stringify(extra), r.status, items.length, "auction non-null:", a.length, a[0] ? JSON.stringify(a[0].auction) + " " + a[0].id : "");
  const promos = new Set(items.flatMap((i) => (i.itemPromotions || []).map((p) => JSON.stringify(p).slice(0, 120))));
  console.log("PROMOS", [...promos].slice(0, 8).join(" || "));
}
// "le vent" titles to learn Japanese spelling
{
  const body = { userId: "", pageSize: 60, pageToken: "", searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
    searchCondition: { keyword: "セイコー le vent", excludeKeyword: "", sort: "SORT_SCORE", order: "ORDER_DESC", status: [],
      sizeId: [], categoryId: [], brandId: [], sellerId: [], priceMin: 0, priceMax: 0, itemConditionId: [], shippingPayerId: [],
      shippingFromArea: [], shippingMethod: [], colorId: [], hasCoupon: false, attributes: [], itemTypes: [], skuIds: [] },
    defaultDatasets: ["DATASET_TYPE_MERCARI", "DATASET_TYPE_BEYOND"], serviceFrom: "suruga",
    withItemBrand: true, withItemSize: false, withItemPromotions: true, withItemSizes: true, withShopname: false };
  const r = await fetch(API, { method: "POST", headers: await H(API, "POST"), body: JSON.stringify(body) });
  const j = await r.json(); for (const it of (j.items || []).slice(0, 25)) console.log("LEVENT", it.categoryId, it.name);
}
