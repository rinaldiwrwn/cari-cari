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

const H = async (url, m) => ({ DPoP: await dpop(url, m), "X-Platform": "web", Accept: "application/json",
  "Content-Type": "application/json; charset=utf-8",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" });
for (const u of ["https://api.mercari.jp/v1/master/item_categories", "https://api.mercari.jp/master/v1/itemCategories/get"]) {
  try {
    const r = await fetch(u, { headers: await H(u, "GET") });
    const txt = await r.text();
    console.log("CAT", u, r.status, txt.length);
    if (r.ok) {
      const flat = []; const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { if (o.id && o.name) flat.push(o); Object.values(o).forEach(walk); } };
      walk(JSON.parse(txt));
      for (const c of flat) if (/時計|ウォッチ/.test(c.name)) console.log("CAT", c.id, c.name, "parent", c.parent_category_id ?? c.parentCategoryId ?? c.parent_id ?? "?");
    }
  } catch (e) { console.log("CAT err", u, e.message); }
}
const counts = {};
for (const kw of ["omega", "longines", "オメガ", "certina", "wittnauer"]) {
  const body = {
    userId: "", pageSize: 120, pageToken: "", searchSessionId: crypto.randomUUID().replace(/-/g, ""),
    indexRouting: "INDEX_ROUTING_UNSPECIFIED", thumbnailTypes: [],
    searchCondition: { keyword: kw, excludeKeyword: "", sort: "SORT_CREATED_TIME", order: "ORDER_DESC", status: ["STATUS_ON_SALE"],
      sizeId: [], categoryId: [], brandId: [], sellerId: [], priceMin: 0, priceMax: 0, itemConditionId: [], shippingPayerId: [],
      shippingFromArea: [], shippingMethod: [], colorId: [], hasCoupon: false, attributes: [], itemTypes: [], skuIds: [] },
    defaultDatasets: ["DATASET_TYPE_MERCARI", "DATASET_TYPE_BEYOND"], serviceFrom: "suruga",
    withItemBrand: true, withItemSize: false, withItemPromotions: true, withItemSizes: true, withShopname: false,
  };
  const r = await fetch(API, { method: "POST", headers: await H(API, "POST"), body: JSON.stringify(body) });
  const j = await r.json();
  const items = j.items || [];
  console.log("KW", kw, r.status, items.length, "auction non-null:", items.filter((i) => i.auction).length);
  const a = items.find((i) => i.auction); if (a) console.log("AUCTION SAMPLE", JSON.stringify(a.auction));
  for (const it of items) { (counts[it.categoryId] ??= []).push(it.name.slice(0, 40)); }
}
for (const [c, names] of Object.entries(counts).sort((a, b) => b[1].length - a[1].length)) console.log("CID", c, names.length, "|", names.slice(0, 3).join(" / "));
