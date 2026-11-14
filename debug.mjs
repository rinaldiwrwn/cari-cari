// Temporary: inspect Mercari search response fields (auction detection). Will be deleted.
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
const body = {
  userId: "", pageSize: 120, pageToken: "", searchSessionId: crypto.randomUUID().replace(/-/g, ""),
  indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
  searchCondition: { keyword: "omega", excludeKeyword: "", sort: "SORT_CREATED_TIME", order: "ORDER_DESC", status: ["STATUS_ON_SALE"],
    sizeId: [], categoryId: [], brandId: [], sellerId: [], priceMin: 0, priceMax: 0, itemConditionId: [], shippingPayerId: [],
    shippingFromArea: [], shippingMethod: [], colorId: [], hasCoupon: false, attributes: [], itemTypes: [], skuIds: [] },
  defaultDatasets: ["DATASET_TYPE_MERCARI", "DATASET_TYPE_BEYOND"], serviceFrom: "suruga",
  withItemBrand: true, withItemSize: false, withItemPromotions: true, withItemSizes: true, withShopname: false,
};
const r = await fetch(API, { method: "POST", headers: { DPoP: await dpop(API, "POST"), "X-Platform": "web",
  "Content-Type": "application/json; charset=utf-8", Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" },
  body: JSON.stringify(body) });
const j = await r.json();
console.log("HTTP", r.status, "items", (j.items || []).length, "top keys", Object.keys(j));
const keys = {};
for (const it of j.items || []) for (const [k, v] of Object.entries(it)) {
  const sig = k + ":" + (Array.isArray(v) ? "array" : typeof v) + (typeof v !== "object" ? "=" + String(v).slice(0, 40) : "");
  keys[k] ??= new Map(); keys[k].set(sig, (keys[k].get(sig) || 0) + 1);
}
for (const [k, m] of Object.entries(keys)) console.log(k, "->", [...m.entries()].slice(0, 6).map(([s, c]) => `${s.split(":").slice(1).join(":")} x${c}`).join(" | "));
const auc = (j.items || []).filter((it) => JSON.stringify(it).toLowerCase().includes("auction"));
console.log("items mentioning auction:", auc.length);
for (const it of auc.slice(0, 3)) console.log(JSON.stringify(it).slice(0, 1500));
console.log("sample normal:", JSON.stringify((j.items || []).find((it) => !auc.includes(it))).slice(0, 1500));
