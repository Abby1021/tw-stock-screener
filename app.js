/* 台股條件選股器 v3
 * 資料來源
 *  證交所 OpenAPI  https://openapi.twse.com.tw/v1
 *    /exchangeReport/BWIBBU_ALL     上市 本益比、殖利率、淨值比
 *    /exchangeReport/STOCK_DAY_ALL  上市 日成交（收盤、漲跌、成交量）
 *    /opendata/t187ap14_L           上市 EPS 統計（含產業別）
 *  櫃買中心 OpenAPI https://www.tpex.org.tw/openapi/v1
 *    /tpex_mainboard_peratio_analysis   上櫃 本益比、殖利率、淨值比
 *    /tpex_mainboard_daily_close_quotes 上櫃 日收盤行情
 *    /mopsfin_t187ap14_O               上櫃 EPS 統計
 *    /mopsfin_t187ap03_O               上櫃 公司基本資料（補產業別）
 *  全市場每日收盤行情（建立歷史資料庫，一天一次請求）
 *    上市 https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json
 *    上櫃 https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=YYYY/MM/DD&type=EW&response=json
 *  個股歷史日 K（歷史資料庫失敗時的備案）
 *  證交所即時報價 https://mis.twse.com.tw/stock/api/getStockInfo.jsp
 *  鉅亨網新聞搜尋 https://ess.api.cnyes.com/ess/api/v1/news/keyword
 */
(() => {
  "use strict";

  const VERSION = "3.2";
  const TWSE = "https://openapi.twse.com.tw/v1";
  const TPEX = "https://www.tpex.org.tw/openapi/v1";
  const PAGE = 150;
  const SCAN_MAX = 60;
  const DB_DAYS = 130;           // 歷史資料庫保留的交易日數（約 6 個月）
  const MIN_BARS = 30;           // 至少要有幾根 K 棒才做技術分析
  const DETAIL_MONTHS = 7;
  const SCAN_MONTHS = 5;
  const RT_INTERVAL = 60 * 1000;          // 盤中自選股報價更新間隔
  const RT_ALL_INTERVAL = 3 * 60 * 1000; // 盤中全部股票報價更新間隔
  const RT_BATCH = 80;                   // 每次即時報價請求的股票數
  // 各網站的請求間隔（毫秒），避免被交易所暫時封鎖
  const GAP = { "www.twse.com.tw": 2000, "www.tpex.org.tw": 1000, "mis.twse.com.tw": 1000 };

  // 用 start.bat（server.ps1 / server.py）開啟時，資料一律經由本機伺服器轉接，不受瀏覽器 CORS 限制。
  const LOCAL_SERVER = /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // 先讓瀏覽器直接連（有些網站允許，例如會擋程式連線的網站），失敗再走本機轉接。
  const ROUTES = LOCAL_SERVER
    ? [(u) => u, (u) => "/proxy?url=" + encodeURIComponent(u)]
    : [
        (u) => u,
        (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
        (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
      ];
  const ROUTE_NAMES = LOCAL_SERVER ? ["瀏覽器直連", "本機轉接"] : ["瀏覽器直連", "corsproxy", "allorigins"];
  const routeOk = {};
  const hostNext = {};

  const INDUSTRY_CODES = {
    "01": "水泥工業", "02": "食品工業", "03": "塑膠工業", "04": "紡織纖維", "05": "電機機械", "06": "電器電纜",
    "08": "玻璃陶瓷", "09": "造紙工業", "10": "鋼鐵工業", "11": "橡膠工業", "12": "汽車工業", "14": "建材營造業",
    "15": "航運業", "16": "觀光餐旅", "17": "金融保險業", "18": "貿易百貨業", "19": "綜合", "20": "其他業",
    "21": "化學工業", "22": "生技醫療業", "23": "油電燃氣業", "24": "半導體業", "25": "電腦及週邊設備業",
    "26": "光電業", "27": "通信網路業", "28": "電子零組件業", "29": "電子通路業", "30": "資訊服務業",
    "31": "其他電子業", "32": "文化創意業", "33": "農業科技業", "34": "電子商務", "35": "綠能環保",
    "36": "數位雲端", "37": "運動休閒", "38": "居家生活", "80": "管理股票",
  };

  const TECH_FILTERS = [
    ["hlBreak", "底底高＋破前高", true],
    ["hlWait", "底底高（待突破）", true],
    ["aboveMA20", "站上月線"],
    ["aboveMA60", "站上季線"],
    ["bullAlign", "均線多頭排列"],
    ["maGolden", "MA5 上穿 MA20"],
    ["kdGolden", "KD 黃金交叉"],
    ["kdLow", "KD 低檔 (<20)"],
    ["macdUp", "MACD 柱翻正"],
    ["rsiLow", "RSI 偏冷 (<30)"],
    ["volUp", "價漲量增"],
    ["bollBreakUp", "突破布林上軌"],
    ["biasLow", "負乖離過大"],
  ];

  const SIGNAL_GROUPS = [
    ["偏多訊號", [["hlBreak", "底底高＋突破前高"], ["aboveMA20", "站上月線"], ["aboveMA60", "站上季線"], ["bullAlign", "均線多頭排列"],
      ["maGolden", "MA5 上穿 MA20"], ["kdGolden", "KD 黃金交叉"], ["macdUp", "MACD 柱翻正"], ["volUp", "價漲量增"], ["bollBreakUp", "突破布林上軌"]]],
    ["偏空訊號", [["hlFail", "突破前高後又跌回"], ["belowMA20", "跌破月線"], ["belowMA60", "跌破季線"], ["bearAlign", "均線空頭排列"],
      ["maDeath", "MA5 下穿 MA20"], ["kdDeath", "KD 死亡交叉"], ["macdDown", "MACD 柱翻負"], ["volDown", "價跌量增"], ["bollBreakDown", "跌破布林下軌"]]],
    ["其他", [["hlWait", "底底高（待突破）"], ["kdHigh", "KD 超買 (>80)"], ["kdLow", "KD 超賣 (<20)"], ["rsiHigh", "RSI 偏熱 (>70)"],
      ["rsiLow", "RSI 偏冷 (<30)"], ["biasHigh", "正乖離過大"], ["biasLow", "負乖離過大"], ["bollSqueeze", "布林通道收斂"],
      ["nearRes", "接近壓力"], ["nearSup", "接近支撐"]]],
  ];
  const SIGNAL_LABEL = Object.fromEntries(SIGNAL_GROUPS.flatMap(([, l]) => l));

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  const pad = (n) => String(n).padStart(2, "0");

  /* ------------------------------------------------------------ 時間（台北） */
  function tpNow() {
    const f = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short",
    });
    const o = {};
    for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
    const hour = +o.hour % 24;
    return { date: `${o.year}-${o.month}-${o.day}`, hour, minute: +o.minute, time: `${pad(hour)}:${o.minute}:${o.second}`, wd: o.weekday };
  }
  const todayStr = () => tpNow().date;
  const isWeekend = (iso) => { const d = new Date(iso + "T00:00:00Z").getUTCDay(); return d === 0 || d === 6; };
  const prevDay = (iso) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  const ymd = (iso) => iso.replace(/-/g, "");
  const md = (iso) => (iso ? iso.slice(5).replace("-", "/") : "—");
  function inTradingHours() {
    const t = tpNow();
    if (t.wd === "Sat" || t.wd === "Sun") return false;
    const m = t.hour * 60 + t.minute;
    return m >= 8 * 60 + 59 && m <= 13 * 60 + 35;
  }

  /* ------------------------------------------------------------ 儲存 */
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (_) { return null; } },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); }
      catch (_) {
        try {
          Object.keys(localStorage).filter((x) => x.startsWith("h:")).forEach((x) => localStorage.removeItem(x));
          localStorage.setItem(k, JSON.stringify(v));
        } catch (__) {}
      }
    },
  };

  // IndexedDB：存全市場歷史行情（資料量太大放不進 localStorage）
  const idb = {
    db: null,
    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("tw-screener", 1);
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("days")) r.result.createObjectStore("days", { keyPath: "key" }); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this.db;
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction("days", mode);
        const out = fn(t.objectStore("days"));
        t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
        t.onerror = () => rej(t.error);
      });
    },
    all() { return this.tx("readonly", (s) => s.getAll()); },
    put(rec) { return this.tx("readwrite", (s) => s.put(rec)); },
    del(key) { return this.tx("readwrite", (s) => s.delete(key)); },
    clear() { return this.tx("readwrite", (s) => s.clear()); },
  };

  const defaultFilters = () => ({ q: "", mkt: "all", peMin: "", peMax: "", epsMin: "", epsMax: "", yMin: "", yMax: "", inds: new Set(), tech: new Set(), pivotW: "5", breakDays: "10" });
  const loadWatch = () => {
    const w = ls.get("tw-watch-v1") || {};
    return { list: Array.isArray(w.list) ? w.list : [], alerts: w.alerts || {}, log: Array.isArray(w.log) ? w.log : [] };
  };

  const state = {
    rows: [],
    byCode: new Map(),
    mode: "loading",
    src: { L: "wait", O: "wait" },
    epsLabel: "",
    filters: defaultFilters(),
    sort: { key: "pct", dir: -1 },
    shown: PAGE,
    view: "all",
    current: null,
    detailBars: null,
    detailAna: null,
    hist: new Map(),   // 逐檔抓的歷史（備案）
    ana: new Map(),    // code -> 技術分析結果
    days: { L: new Map(), O: new Map() }, // 歷史資料庫：date -> record
    dbBars: new Map(),
    db: { L: { status: "idle", have: 0, last: null, error: "" }, O: { status: "idle", have: 0, last: null, error: "" } },
    syncing: false,
    range: 66,
    ind: "kd",
    ov: { ma: true, boll: false, sr: true, pattern: true, trades: true },
    scanning: false,
    scanAbort: false,
    trades: ls.get("tw-trades-v1") || {},
    watch: loadWatch(),
    prefs: Object.assign({ sound: true, liveAll: true }, ls.get("tw-prefs-v1") || {}),
    snapDate: null,
    priceInfo: { latest: null, liveCount: 0 },
    rtAllTime: null,
    detailBase: null,
    detailProv: false,
    rt: {},            // code -> 即時報價
    rtTime: null,
    rtError: "",
    editTrade: null,
    editAlert: null,
  };
  const rowOf = (code) => state.byCode.get(code);
  Object.assign(routeOk, ls.get("tw-routes-v2") || {});

  /* ================================================================ fetch */
  function reserve(host) {
    const gap = GAP[host];
    if (!gap) return 0;
    const now = Date.now();
    const t = Math.max(now, hostNext[host] || 0);
    hostNext[host] = t + gap;
    return t - now;
  }
  async function getJSON(url, timeout = 20000) {
    const host = new URL(url).host;
    const all = [...ROUTES.keys()];
    const order = [...new Set(routeOk[host] != null ? [routeOk[host], ...all] : all)];
    let lastErr;
    for (const i of order) {
      await sleep(reserve(host));
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(ROUTES[i](url), { signal: ctrl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = JSON.parse(await res.text());
        if (routeOk[host] !== i) { routeOk[host] = i; ls.set("tw-routes-v2", routeOk); }
        return json;
      } catch (e) {
        lastErr = e.name === "AbortError" ? new Error("連線逾時")
          : e instanceof SyntaxError ? new Error("回傳的不是 JSON（可能被導到網頁或被封鎖）")
          : e.message === "Failed to fetch" ? new Error("連線被擋下") : e;
      } finally {
        clearTimeout(t);
      }
    }
    throw lastErr || new Error("fetch failed");
  }

  const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/<[^>]*>/g, "").replace(/[,\s]/g, "").replace(/^\+/, "");
    if (s === "" || /^-+$/.test(s) || s === "X" || s === "N/A") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const rocToISO = (s) => {
    const m = String(s).replace(/[^\d/]/g, "").match(/^(\d{2,3})\/?(\d{2})\/?(\d{2})$/);
    return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null;
  };
  // 回應裡的日期字串轉成 YYYYMMDD（西元 8 碼或民國 7 碼）；看不懂就回傳 null
  const respYMD = (s) => {
    const d = String(s || "").replace(/\D/g, "");
    if (d.length === 8) return d;
    if (d.length === 7) return String(+d.slice(0, 3) + 1911) + d.slice(3);
    return null;
  };
  const pick = (o, res) => {
    for (const re of res) for (const k of Object.keys(o)) if (re.test(k)) return o[k];
    return undefined;
  };
  const RE_CODE = [/^SecuritiesCompanyCode$/i, /^公司代號$/, /^CompanyCode$/i, /^Code$/i, /代號/];
  const normInd = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d{1,2}$/.test(s)) return INDUSTRY_CODES[pad(s)] || null;
    return s;
  };

  /* ============================================================ 當日資料 */
  async function loadTWSE() {
    const [bw, day, eps] = await Promise.allSettled([
      getJSON(`${TWSE}/exchangeReport/BWIBBU_ALL`),
      getJSON(`${TWSE}/exchangeReport/STOCK_DAY_ALL`),
      getJSON(`${TWSE}/opendata/t187ap14_L`),
    ]);
    if (bw.status !== "fulfilled" || !Array.isArray(bw.value) || !bw.value.length) throw bw.reason || new Error("no TWSE data");
    const dayMap = new Map();
    if (day.status === "fulfilled") for (const d of day.value) dayMap.set(d.Code, d);
    const epsMap = new Map();
    let epsLabel = "";
    if (eps.status === "fulfilled" && Array.isArray(eps.value)) {
      for (const e of eps.value) epsMap.set(e["公司代號"], e);
      const f = eps.value[0];
      if (f) epsLabel = `${f["年度"]}年Q${f["季別"]}`;
    }
    const rows = bw.value.map((b) => {
      const d = dayMap.get(b.Code) || {};
      const e = epsMap.get(b.Code) || {};
      return makeRow({
        mkt: "L", code: b.Code, name: b.Name, industry: normInd(e["產業別"]),
        close: num(d.ClosingPrice), change: num(d.Change), shares: num(d.TradeVolume),
        pe: num(b.PEratio), eps: num(e["基本每股盈餘(元)"]), yield: num(b.DividendYield), pb: num(b.PBratio),
      });
    });
    return { rows, date: rocToISO(bw.value[0].Date), epsLabel };
  }

  async function loadTPEx() {
    const [pe, q, eps, basic] = await Promise.allSettled([
      getJSON(`${TPEX}/tpex_mainboard_peratio_analysis`),
      getJSON(`${TPEX}/tpex_mainboard_daily_close_quotes`),
      getJSON(`${TPEX}/mopsfin_t187ap14_O`),
      getJSON(`${TPEX}/mopsfin_t187ap03_O`),
    ]);
    const ok = (x) => x.status === "fulfilled" && Array.isArray(x.value) && x.value.length > 0;
    const errs = [];
    const why = (name, x) => { if (!ok(x)) errs.push(`${name}：${x.status === "rejected" ? (x.reason && x.reason.message) || x.reason : "沒有資料"}`); };
    why("本益比", pe); why("收盤行情", q); why("EPS", eps); why("基本資料", basic);

    const peMap = new Map();
    if (ok(pe)) for (const p of pe.value) peMap.set(String(pick(p, RE_CODE)).trim(), p);
    const qMap = new Map();
    if (ok(q)) for (const r of q.value) qMap.set(String(pick(r, RE_CODE)).trim(), r);
    const epsMap = new Map();
    if (ok(eps)) for (const r of eps.value) epsMap.set(String(pick(r, RE_CODE)).trim(), r);
    const indMap = new Map();
    if (ok(basic)) for (const r of basic.value) indMap.set(String(pick(r, RE_CODE)).trim(), normInd(pick(r, [/產業別/, /Industry/i])));

    // OpenAPI 的本益比與收盤行情都失敗時，改用櫃買中心網站的每日行情與本益比查詢
    let fb = null, fbPE = null;
    if (!peMap.size && !qMap.size) {
      fb = await tpexLatestQuotes().catch((e) => { errs.push(`每日行情備案：${e.message}`); return null; });
      if (fb) fbPE = await tpexPE(fb.date).catch(() => null);
    }
    let codes = peMap.size ? [...peMap.keys()] : qMap.size ? [...qMap.keys()] : fb ? fb.list.map((x) => x.code) : [];
    codes = codes.filter((c) => /^[1-9]\d{3}[A-Z]?$/.test(c));
    if (!codes.length) {
      const e = new Error(errs.join("；") || "沒有資料");
      e.detail = errs;
      throw e;
    }
    const fbMap = new Map(fb ? fb.list.map((x) => [x.code, x]) : []);
    const rows = codes.map((code) => {
      const p = peMap.get(code) || {};
      const r = qMap.get(code) || {};
      const e = epsMap.get(code) || {};
      const f = fbMap.get(code) || {};
      const fp = (fbPE && fbPE.get(code)) || {};
      return makeRow({
        mkt: "O", code,
        name: String(pick(p, [/^CompanyName$/i, /公司簡稱/, /公司名稱/, /Name/i]) || pick(r, [/CompanyName/i, /名稱/]) || pick(e, [/公司簡稱/, /公司名稱/]) || f.name || code).trim(),
        industry: normInd(pick(e, [/產業別/, /Industry/i])) || indMap.get(code) || null,
        close: num(pick(r, [/^Close$/i, /收盤/])) ?? f.c ?? null,
        change: num(pick(r, [/^Change$/i, /漲跌/])) ?? f.chg ?? null,
        shares: num(pick(r, [/^TradingShares$/i, /成交股數/])) ?? f.v ?? null,
        pe: num(pick(p, [/^PriceEarningRatio$/i, /本益比/, /PEratio/i])) ?? fp.pe ?? null,
        eps: num(pick(e, [/基本每股盈餘/, /EPS/i, /EarningsPerShare/i])),
        yield: num(pick(p, [/^YieldRatio$/i, /殖利率/, /DividendYield/i])) ?? fp.y ?? null,
        pb: num(pick(p, [/^PriceBookRatio$/i, /淨值比/, /PBratio/i])) ?? fp.pb ?? null,
      });
    });
    const first = ok(pe) ? pe.value[0] : ok(q) ? q.value[0] : null;
    const date = first ? rocToISO(pick(first, [/^Date$/i, /日期/]) || "") : fb ? fb.date : null;
    return {
      rows, date, errs, fallback: !!fb,
      epsOk: epsMap.size > 0, indOk: rows.some((r) => r.industry !== "未分類"),
    };
  }

  // 櫃買中心網站的全部上櫃股票每日行情（含名稱），往前找最近有資料的交易日
  async function tpexLatestQuotes() {
    let d = todayStr(), lastErr;
    for (let i = 0; i < 10; i++, d = prevDay(d)) {
      if (isWeekend(d)) continue;
      try {
        const res = await fetchTpexDay(d, true);
        if (!res.noData && res.list.length) return { date: d, list: res.list };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("找不到最近的上櫃行情");
  }

  async function tpexPE(iso) {
    const [y, m, d] = iso.split("-");
    const tries = [
      `https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=${y}/${m}/${d}&response=json`,
      `https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&d=${+y - 1911}/${m}/${d}&o=json`,
    ];
    for (const url of tries) {
      try {
        const j = await getJSON(url, 20000);
        let fields = null, data = null;
        if (j && Array.isArray(j.tables) && j.tables[0]) { fields = j.tables[0].fields; data = j.tables[0].data; }
        else if (j && Array.isArray(j.aaData)) { data = j.aaData; }
        if (!Array.isArray(data) || !data.length) continue;
        const f = (fields || []).map((x) => String(x).replace(/\s|<[^>]*>/g, ""));
        const at = (re, def) => { const i = f.findIndex((x) => re.test(x)); return i >= 0 ? i : def; };
        const ix = { code: at(/代號/, 0), pe: at(/本益比/, 2), y: at(/殖利率/, 5), pb: at(/淨值比/, 6) };
        const map = new Map();
        for (const r of data) map.set(String(r[ix.code]).trim(), { pe: num(r[ix.pe]), y: num(r[ix.y]), pb: num(r[ix.pb]) });
        return map;
      } catch (_) {}
    }
    return null;
  }

  function makeRow(o) {
    const prev = o.close != null && o.change != null ? o.close - o.change : null;
    const r = {
      mkt: o.mkt, code: o.code, name: o.name, industry: o.industry || "未分類",
      close: o.close, change: o.change, pct: prev ? (o.change / prev) * 100 : null,
      pe: o.pe || null, eps: o.eps, yield: o.yield, pb: o.pb,
      volume: o.shares != null ? Math.round(o.shares / 1000) : null,
      score: null,
      priceSrc: null,
    };
    r.base = { close: r.close, change: r.change, pct: r.pct, pe: r.pe, yield: r.yield, pb: r.pb, volume: r.volume };
    return r;
  }

  function loadDemo() {
    // 示範資料：僅在無法連線交易所時使用，數字非真實行情
    const raw = [
      ["L", "2330", "台積電", "半導體業", 1285, 15, 24.6, 27.1, 1.4, 7.1, 31250, "hl"],
      ["L", "2454", "聯發科", "半導體業", 1390, -20, 19.8, 34.2, 4.1, 5.0, 4120],
      ["L", "2303", "聯電", "半導體業", 47.6, 0.35, 13.2, 1.62, 6.3, 1.4, 41870],
      ["L", "3711", "日月光投控", "半導體業", 168, 3.5, 17.9, 4.33, 3.3, 2.4, 12880, "wait"],
      ["L", "2379", "瑞昱", "半導體業", 542, -6, 16.4, 15.8, 4.6, 4.2, 1530],
      ["L", "2317", "鴻海", "其他電子業", 212, 4, 16.2, 5.9, 2.6, 1.6, 52310],
      ["L", "2382", "廣達", "電腦及週邊設備業", 286, 5.5, 17.5, 8.1, 3.6, 5.3, 9840],
      ["L", "3231", "緯創", "電腦及週邊設備業", 118, -1.5, 14.8, 3.6, 3.1, 2.3, 21460],
      ["L", "2357", "華碩", "電腦及週邊設備業", 612, 2, 12.1, 22.4, 5.2, 1.5, 1870],
      ["L", "2308", "台達電", "電子零組件業", 655, 12, 31.2, 9.6, 1.7, 6.1, 5320],
      ["L", "2327", "國巨", "電子零組件業", 598, -8, 18.3, 15.2, 3.9, 2.4, 2980],
      ["L", "1513", "中興電", "電機機械", 172.5, 2.5, 21.4, 4.1, 2.9, 3.8, 8930, "hl"],
      ["L", "3008", "大立光", "光電業", 2425, -35, 15.7, 70.3, 3.4, 2.0, 410],
      ["L", "2412", "中華電", "通信網路業", 128.5, 0.5, 26.4, 2.4, 3.8, 2.6, 8150],
      ["L", "2345", "智邦", "通信網路業", 742, 18, 29.8, 12.1, 1.6, 9.2, 2640],
      ["L", "2881", "富邦金", "金融保險業", 88.3, 0.9, 9.4, 4.8, 4.5, 1.2, 18420],
      ["L", "2882", "國泰金", "金融保險業", 63.5, -0.4, 10.6, 3.1, 4.7, 1.1, 22510],
      ["L", "2891", "中信金", "金融保險業", 41.25, 0.25, 11.8, 1.85, 4.9, 1.6, 35120],
      ["L", "1301", "台塑", "塑膠工業", 38.4, -0.45, null, -0.42, 2.1, 0.8, 16540],
      ["L", "1101", "台泥", "水泥工業", 26.15, 0.05, 21.8, 0.38, 3.2, 0.8, 11230],
      ["L", "1216", "統一", "食品工業", 81.2, 0.6, 22.5, 1.86, 3.6, 3.4, 6420],
      ["L", "2002", "中鋼", "鋼鐵工業", 19.35, -0.15, null, -0.11, 0.5, 0.9, 28760],
      ["L", "2603", "長榮", "航運業", 192.5, -4.5, 3.4, 18.2, 10.4, 1.0, 17650],
      ["L", "2207", "和泰車", "汽車工業", 548, 3, 15.9, 16.8, 4.2, 3.0, 380],
      ["L", "6505", "台塑化", "油電燃氣業", 44.7, -0.25, 58.2, 0.21, 1.8, 1.6, 4520],
      ["L", "1795", "美時", "生技醫療業", 268, 6, 18.6, 7.2, 2.6, 3.4, 1540],
      ["O", "6173", "信昌電", "電子零組件業", 58.4, 1.2, 19.5, 1.38, 3.4, 1.9, 6820, "hl"],
      ["O", "6488", "環球晶", "半導體業", 412, -6, 15.1, 13.6, 4.4, 2.0, 2310],
      ["O", "5347", "世界", "半導體業", 98.6, 0.8, 18.2, 2.71, 4.6, 2.1, 9740, "wait"],
      ["O", "3105", "穩懋", "半導體業", 132, -2.5, null, -0.86, 0.8, 1.7, 5410],
      ["O", "8299", "群聯", "半導體業", 586, 11, 13.9, 21.7, 3.9, 2.8, 2860],
      ["O", "3529", "力旺", "半導體業", 2310, 40, 61.2, 18.9, 1.1, 32.5, 520],
      ["O", "6274", "台燿", "電子零組件業", 168.5, 4, 16.8, 5.1, 3.0, 3.1, 4120],
      ["O", "3293", "鈊象", "文化創意業", 905, -10, 17.4, 27.2, 3.8, 6.4, 610],
      ["O", "5483", "中美晶", "半導體業", 104.5, 0.5, 14.2, 3.9, 4.8, 1.3, 3250],
      ["O", "4966", "譜瑞-KY", "半導體業", 448, -3, 20.8, 10.9, 3.1, 3.6, 890],
    ];
    const rows = raw.map(([mkt, code, name, industry, close, change, pe, eps, y, pb, vol, shape]) => {
      const r = makeRow({ mkt, code, name, industry, close, change, pe, eps, yield: y, pb, shares: vol * 1000 });
      r.demoShape = shape || null;
      return r;
    });
    return { rows, date: null, epsLabel: "115年Q2" };
  }

  /* ================================================================ boot */
  async function boot() {
    state.src = { L: "wait", O: "wait" };
    renderSource();
    renderSkeleton();
    state.hist.clear();
    const [L, O] = await Promise.allSettled([loadTWSE(), loadTPEx()]);
    let rows = [], date = null;
    const partial = [];
    const reason = (r) => (r && r.message ? r.message : String(r || "未知錯誤"));
    state.snapDate = { L: null, O: null };
    if (L.status === "fulfilled") { rows = rows.concat(L.value.rows); date = L.value.date; state.snapDate.L = L.value.date; state.epsLabel = L.value.epsLabel; state.src.L = "live"; }
    else { state.src.L = "fail"; console.warn("上市資料失敗", L.reason); }
    if (O.status === "fulfilled") {
      rows = rows.concat(O.value.rows); date = date || O.value.date; state.snapDate.O = O.value.date; state.src.O = "live";
      if (O.value.fallback) partial.push("櫃買中心 OpenAPI 讀取失敗，上櫃股票改用櫃買中心網站的每日行情，沒有 EPS 和產業別");
      else {
        if (!O.value.epsOk) partial.push("上櫃 EPS 資料讀取失敗，上櫃股票的 EPS 欄位會是空白，EPS 篩選會排除它們");
        if (!O.value.indOk) partial.push("上櫃產業別讀取失敗，上櫃股票會歸在「未分類」");
      }
      state.tpexErrs = O.value.errs || [];
    } else { state.src.O = "fail"; state.tpexErrs = (O.reason && O.reason.detail) || [reason(O.reason)]; console.warn("上櫃資料失敗", O.reason); }

    if (!rows.length) {
      const d = loadDemo();
      rows = d.rows; state.epsLabel = d.epsLabel; state.mode = "demo";
      state.src = { L: "demo", O: "demo" };
      const why = (r) => esc(r && r.message ? r.message : String(r || "未知錯誤"));
      $("demoBanner").innerHTML = location.protocol === "file:"
        ? `目前是直接打開 index.html，瀏覽器會擋下對交易所的連線，所以只顯示 <strong>36 檔示範資料</strong>。請改成雙擊資料夾裡的 <strong>start.bat</strong> 開啟，或開啟 CORS Unblock 擴充功能後按「重新載入」。`
        : LOCAL_SERVER
          ? `本機伺服器轉接交易所資料失敗，以下為<strong>示範資料</strong>。請看 start.bat 視窗裡「[轉接失敗]」的訊息（上市：${why(L.reason)}；上櫃：${why(O.reason)}）。`
          : `無法連線證交所與櫃買中心，以下為<strong>示範資料</strong>，數字和走勢都不是真實行情。把網頁下載到自己電腦、用 start.bat 開啟就會改抓即時資料。`;
    } else {
      state.mode = "live";
      if (state.src.L === "fail") partial.unshift(`上市資料讀取失敗（${reason(L.reason)}），目前只顯示上櫃股票`);
      if (state.src.O === "fail") partial.unshift(`上櫃資料讀取失敗（${state.tpexErrs.join("；")}），目前只顯示上市股票`);
    }
    state.rows = rows;
    state.byCode = new Map(rows.map((r) => [r.code, r]));
    for (const r of rows) { const a = state.ana.get(r.code); if (a && !a.error) r.score = a.score; }
    applyPrices();
    renderDataDate();
    $("epsPeriod").textContent = state.epsLabel ? `(${state.epsLabel}，元)` : "(元)";
    $("demoBanner").hidden = state.mode !== "demo";
    $("partialBanner").hidden = !partial.length;
    $("partialBanner").innerHTML = esc(partial.join("；")) + "。可按右上角「重新載入」再試一次；若一直失敗，請按頁面最下方的<strong>「連線診斷」</strong>，把結果複製給我。";
    renderSource();
    renderLive();
    buildIndustries();
    render();

    if (state.mode === "demo") {
      state.dbBars = new Map(rows.map((r) => [r.code, demoHistory(r)]));
      state.db.L = { status: "demo", have: 150, last: null, error: "" };
      state.db.O = { status: "demo", have: 150, last: null, error: "" };
      renderDb();
      await analyzeAll();
      checkAlerts("boot");
    } else {
      await loadDbFromDisk();
      checkAlerts("boot");
      syncHistory();
    }
    startRealtime();
  }

  function renderSource() {
    for (const m of ["L", "O"]) {
      const s = state.src[m];
      const el = $("src" + m);
      el.className = "pill " + (s === "live" ? "pill-live" : s === "demo" || s === "fail" ? "pill-demo" : "pill-wait");
      el.textContent = (m === "L" ? "上市 " : "上櫃 ") + ({ live: "即時", demo: "示範", fail: "失敗", wait: "載入中" })[s];
    }
  }

  /* ======================================================== 歷史資料庫 */
  // 解析交易所每日行情表格，依欄位名稱找位置；找不到欄位時用預設位置
  // all = true 時不限於目前清單裡的股票，並另外回傳名稱、漲跌（給上櫃備案資料使用）
  function parseDayTable(fields, data, def, all) {
    const idx = { name: 1, chg: 3, ...def };
    if (Array.isArray(fields) && fields.length) {
      const f = fields.map((x) => String(x).replace(/\s|<[^>]*>/g, ""));
      const find = (re) => f.findIndex((x) => re.test(x));
      const m = { code: find(/^(證券)?代號$/), name: find(/^(證券)?名稱$/), o: find(/^開盤/), h: find(/^最高/), l: find(/^最低/), c: find(/^收盤/), v: find(/^成交股數/), chg: find(/^漲跌(價差)?$/) };
      for (const k of Object.keys(m)) if (m[k] >= 0) idx[k] = m[k];
    }
    const rows = {};
    const list = [];
    let n = 0;
    for (const r of data || []) {
      if (!Array.isArray(r)) continue;
      const code = String(r[idx.code] ?? "").replace(/<[^>]*>/g, "").trim();
      if (all ? !/^[1-9]\d{3}[A-Z]?$/.test(code) : !state.byCode.has(code)) continue;
      const o = num(r[idx.o]), h = num(r[idx.h]), l = num(r[idx.l]), c = num(r[idx.c]);
      const shares = num(r[idx.v]) || 0;
      if (all) list.push({ code, name: String(r[idx.name] ?? code).trim(), c, chg: num(r[idx.chg]), v: shares });
      if ([o, h, l, c].some((v) => v == null || v <= 0)) continue; // 當天沒成交
      rows[code] = [o, h, l, c, Math.round(shares / 1000)];
      n++;
    }
    return { rows, n: all ? list.length : n, list };
  }

  async function fetchTwseDay(iso) {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(iso)}&type=ALLBUT0999&response=json`, 30000);
    if (!j || typeof j !== "object") throw new Error("回應格式不對");
    if (j.stat && j.stat !== "OK") {
      if (/沒有符合|查詢日期|無資料/.test(j.stat)) return { noData: true };
      throw new Error(String(j.stat).slice(0, 60));
    }
    const rd = respYMD(j.date);
    if (rd && rd !== ymd(iso)) return { noData: true };
    let tables = Array.isArray(j.tables) ? j.tables.slice() : [];
    for (let i = 1; i <= 12; i++) if (j["fields" + i]) tables.push({ fields: j["fields" + i], data: j["data" + i] });
    const t = tables.find((x) => Array.isArray(x.fields) && x.fields.some((f) => /代號/.test(f)) && x.fields.some((f) => /收盤/.test(f)));
    if (!t) return { noData: true };
    const res = parseDayTable(t.fields, t.data, { code: 0, v: 2, o: 5, h: 6, l: 7, c: 8 });
    if (!res.n) return (t.data || []).length ? Promise.reject(new Error("看不懂上市行情欄位")) : { noData: true };
    return res;
  }

  let tpexVariant = null;
  const TPEX_DAY = [
    (iso) => ({
      url: `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${iso.replace(/-/g, "/")}&type=EW&response=json`,
      parse: parseTpexNew,
    }),
    (iso) => ({
      url: `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${ymd(iso)}&type=EW&response=json`,
      parse: parseTpexNew,
    }),
    (iso) => {
      const [y, m, d] = iso.split("-");
      return {
        url: `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${+y - 1911}/${m}/${d}&se=EW&o=json`,
        parse: (j, want, all) => {
          if (!j || !Array.isArray(j.aaData)) return null;
          const rd = respYMD(j.reportDate);
          if (!j.aaData.length || (rd && rd !== want)) return { noData: true };
          const res = parseDayTable(null, j.aaData, { code: 0, c: 2, o: 4, h: 5, l: 6, v: 8 }, all);
          return res.n ? res : null;
        },
      };
    },
  ];
  function parseTpexNew(j, want, all) {
    if (!j || typeof j !== "object" || !Array.isArray(j.tables)) return null;
    const t = j.tables.find((x) => Array.isArray(x.fields) && x.fields.some((f) => /代號/.test(f)) && x.fields.some((f) => /收盤/.test(f))) || j.tables[0];
    if (!t) return { noData: true };
    const rd = respYMD(t.date || j.date);
    if (!Array.isArray(t.data) || !t.data.length || (rd && rd !== want)) return { noData: true };
    const res = parseDayTable(t.fields, t.data, { code: 0, c: 2, o: 4, h: 5, l: 6, v: 8 }, all);
    return res.n ? res : null;
  }
  async function fetchTpexDay(iso, all) {
    const want = ymd(iso);
    const order = tpexVariant != null ? [tpexVariant] : [...TPEX_DAY.keys()];
    let lastErr;
    for (const i of order) {
      const { url, parse } = TPEX_DAY[i](iso);
      try {
        const res = parse(await getJSON(url, 30000), want, all);
        if (res) { if (!res.noData) tpexVariant = i; return res; }
        lastErr = new Error("看不懂上櫃行情格式");
      } catch (e) { lastErr = e; }
    }
    if (tpexVariant != null && order.length === 1) { tpexVariant = null; }
    throw lastErr || new Error("上櫃行情抓取失敗");
  }

  async function loadDbFromDisk() {
    try {
      const recs = await idb.all();
      for (const r of recs || []) if (r && r.mkt && r.date) state.days[r.mkt].set(r.date, r);
    } catch (e) {
      console.warn("IndexedDB 無法使用，歷史資料只會存在這次開啟的頁面", e);
    }
    buildBars();
    applyPrices();
    renderDb();
    if (state.dbBars.size) await analyzeAll();
  }

  function buildBars() {
    const map = new Map();
    for (const m of ["L", "O"]) {
      const recs = [...state.days[m].values()].filter((r) => !r.holiday).sort((a, b) => (a.date < b.date ? -1 : 1));
      state.db[m].have = recs.length;
      state.db[m].last = recs.length ? recs[recs.length - 1].date : null;
      for (const rec of recs) {
        for (const code in rec.rows) {
          const v = rec.rows[code];
          let arr = map.get(code);
          if (!arr) map.set(code, (arr = []));
          arr.push({ time: rec.date, open: v[0], high: v[1], low: v[2], close: v[3], volume: v[4] });
        }
      }
    }
    state.dbBars = map;
  }

  async function syncHistory() {
    if (state.syncing || state.mode !== "live") return;
    state.syncing = true;
    const markets = ["L", "O"].filter((m) => state.src[m] === "live");
    for (const m of ["L", "O"]) if (!markets.includes(m)) state.db[m].status = "skip";
    renderDb();
    let pending = 0;
    const refresh = async () => { buildBars(); applyPrices(); renderDb(); await analyzeAll(); };
    await Promise.all(markets.map((m) => syncMarket(m, async () => { if (++pending % 15 === 0) await refresh(); })));
    await prune();
    await refresh();
    state.syncing = false;
    renderDb();
    checkAlerts("history");
  }

  async function syncMarket(m, onDay) {
    const st = state.db[m];
    st.status = "sync"; st.error = "";
    const today = todayStr();
    const days = state.days[m];
    let have = 0, errs = 0;
    let newer = null, newerDate = null; // 較新一個交易日的資料：休市日交易所可能回傳前一個交易日的資料，用來偵測重複
    let d = today;
    for (let i = 0; i < 260 && have < DB_DAYS; i++, d = prevDay(d)) {
      if (isWeekend(d)) continue;
      const rec = days.get(d);
      if (rec) { if (!rec.holiday) { have++; newer = rec.rows; newerDate = d; } st.have = Math.max(st.have, have); continue; }
      try {
        const res = m === "L" ? await fetchTwseDay(d) : await fetchTpexDay(d);
        errs = 0;
        if (!res.noData && sameDay(res.rows, newer)) {
          // 較新那天其實是休市日（交易所回傳了這一天的資料），把它改成休市
          const h = { key: `${m}:${newerDate}`, mkt: m, date: newerDate, holiday: true };
          days.set(newerDate, h);
          idb.put(h).catch(() => {});
          have--;
        }
        if (res.noData) {
          if (d < today) { const h = { key: `${m}:${d}`, mkt: m, date: d, holiday: true }; days.set(d, h); idb.put(h).catch(() => {}); }
          continue;
        }
        const r = { key: `${m}:${d}`, mkt: m, date: d, holiday: false, rows: res.rows };
        days.set(d, r);
        idb.put(r).catch(() => {});
        have++;
        newer = res.rows;
        newerDate = d;
        st.have = Math.max(st.have, have);
        st.fetched = (st.fetched || 0) + 1;
        renderDb();
        await onDay();
      } catch (e) {
        errs++;
        console.warn("歷史行情失敗", m, d, e);
        if (errs >= 4) { st.status = "fail"; st.error = e.message || String(e); renderDb(); return; }
      }
    }
    st.status = "ok";
  }

  // 兩天的行情完全一樣（含成交量）就視為重複資料
  function sameDay(a, b) {
    if (!a || !b) return false;
    const keys = Object.keys(a).slice(0, 30);
    if (!keys.length) return false;
    return keys.every((k) => b[k] && b[k].join() === a[k].join());
  }

  async function prune() {
    for (const m of ["L", "O"]) {
      const trading = [...state.days[m].values()].filter((r) => !r.holiday).map((r) => r.date).sort().reverse();
      if (trading.length <= DB_DAYS) continue;
      const cutoff = trading[DB_DAYS - 1];
      for (const [date, r] of [...state.days[m]]) {
        if (date < cutoff) { state.days[m].delete(date); idb.del(r.key).catch(() => {}); }
      }
    }
  }

  function renderDb() {
    const L = state.db.L, O = state.db.O;
    const box = $("dbTxt");
    const fallback = $("scanFallback");
    if (L.status === "demo") {
      box.innerHTML = "示範模式：技術條件直接篩選示範股票。";
      $("dbBarWrap").hidden = true;
      fallback.hidden = true;
      return;
    }
    const act = ["L", "O"].filter((m) => state.db[m].status !== "skip");
    const label = (m) => (m === "L" ? "上市" : "上櫃");
    const syncing = act.some((m) => state.db[m].status === "sync");
    const fails = act.filter((m) => state.db[m].status === "fail");
    const parts = act.map((m) => {
      const s = state.db[m];
      return `${label(m)} <b>${Math.min(s.have, DB_DAYS)}</b>/${DB_DAYS} 天${s.last ? `（至 ${md(s.last)}）` : ""}`;
    });
    let html = "";
    if (syncing) {
      const first = act.some((m) => state.db[m].have < DB_DAYS * 0.8);
      html = `建立歷史資料中：${parts.join("、")}。` + (first ? "第一次約需 5 分鐘，之後每天只補 1 天，可以先使用其他功能。" : "正在補最新的交易日。");
    } else if (act.length) {
      html = `歷史資料：${parts.join("、")}，點技術條件就會直接篩選。`;
    } else {
      html = "歷史資料準備中…";
    }
    if (fails.length) html += `<br>${fails.map(label).join("、")}歷史資料抓取失敗（${esc(fails.map((m) => state.db[m].error).join("；"))}），可改用下方的逐檔掃描。`;
    box.innerHTML = html;
    const total = act.length * DB_DAYS;
    const have = act.reduce((a, m) => a + Math.min(state.db[m].have, DB_DAYS), 0);
    $("dbBarWrap").hidden = !syncing;
    $("dbBar").style.width = total ? `${(have / total) * 100}%` : "0";
    fallback.hidden = !fails.length;
  }

  /* ======================================================== 最新股價 */
  // 股價優先用：今天的即時報價 → 歷史資料庫裡比 OpenAPI 更新的收盤 → OpenAPI 當日資料
  // 本益比、殖利率、淨值比依最新股價等比例換算（EPS、股利、淨值不變）
  function applyPrices() {
    const today = todayStr();
    let latest = null, liveCount = 0;
    for (const r of state.rows) {
      const b = r.base;
      if (!b) continue;
      const rt = state.rt[r.code];
      const bars = state.dbBars.get(r.code);
      const lb = bars && bars.length ? bars[bars.length - 1] : null;
      const snap = state.snapDate && state.snapDate[r.mkt];
      let price = null, prev = null, vol = null, src = null;
      if (rt && rt.date === today && rt.price != null) { price = rt.price; prev = rt.prev; vol = rt.vol; src = "rt"; liveCount++; }
      else if (lb && snap && lb.time > snap) {
        price = lb.close; prev = bars.length > 1 ? bars[bars.length - 2].close : null; vol = lb.volume; src = "db";
        if (!latest || lb.time > latest) latest = lb.time;
      }
      if (price == null) {
        Object.assign(r, { close: b.close, change: b.change, pct: b.pct, pe: b.pe, yield: b.yield, pb: b.pb, volume: b.volume, priceSrc: null });
        continue;
      }
      const k = b.close ? price / b.close : null;
      r.close = price;
      r.change = prev != null ? Math.round((price - prev) * 10000) / 10000 : null;
      r.pct = prev ? ((price - prev) / prev) * 100 : null;
      r.volume = vol ?? b.volume;
      r.pe = b.pe && k ? b.pe * k : b.pe;
      r.yield = b.yield && k ? b.yield / k : b.yield;
      r.pb = b.pb && k ? b.pb * k : b.pb;
      r.priceSrc = src;
    }
    state.priceInfo = { latest, liveCount };
    renderDataDate();
  }

  function renderDataDate() {
    const el = $("dataDate");
    if (state.mode === "demo") { el.textContent = "資料日期 示範"; el.title = ""; return; }
    const snap = state.snapDate ? state.snapDate.L || state.snapDate.O : null;
    const { latest, liveCount } = state.priceInfo;
    if (liveCount && state.rtAllTime) {
      el.textContent = `即時 ${md(todayStr())} ${state.rtAllTime.slice(0, 5)}`;
      el.title = "盤中股價為證交所即時報價（約延遲數秒），本益比、殖利率依即時股價換算";
    } else if (latest) {
      el.textContent = `收盤 ${latest}`;
      el.title = "股價為交易所當日收盤行情，本益比、殖利率依收盤價換算";
    } else {
      el.textContent = snap ? `資料日期 ${snap}` : "資料日期 —";
      el.title = "";
    }
  }

  // 盤中把今天還沒收盤的即時報價當成一根暫時的 K 棒，讓技術條件反映今天的走勢
  function withProvisional(code, bars) {
    const rt = state.rt[code];
    const today = todayStr();
    if (!bars || !bars.length || !rt || rt.date !== today || rt.price == null) return { bars, prov: false };
    if (bars[bars.length - 1].time >= today) return { bars, prov: false };
    const o = rt.open ?? rt.price;
    const bar = {
      time: today, open: o, close: rt.price, volume: rt.vol || 0,
      high: Math.max(rt.high ?? rt.price, rt.price, o), low: Math.min(rt.low ?? rt.price, rt.price, o),
    };
    return { bars: bars.concat([bar]), prov: true };
  }

  /* ======================================================= filter + table */
  function buildIndustries() {
    const counts = new Map();
    const base = state.rows.filter((r) => state.filters.mkt === "all" || r.mkt === state.filters.mkt);
    for (const r of base) counts.set(r.industry, (counts.get(r.industry) || 0) + 1);
    for (const i of [...state.filters.inds]) if (!counts.has(i)) state.filters.inds.delete(i);
    const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $("industries").innerHTML = list.map(([name, n]) =>
      `<button type="button" class="ind" data-ind="${esc(name)}" aria-pressed="${state.filters.inds.has(name)}">${esc(name)}<small>${n}</small></button>`).join("");
  }

  function buildTechChips() {
    $("techChips").innerHTML = TECH_FILTERS.map(([k, label, star]) =>
      `<button type="button" class="ind tech${star ? " featured" : ""}" data-tech="${k}" aria-pressed="${state.filters.tech.has(k)}">${label}</button>`).join("");
  }

  const inRange = (v, lo, hi) => {
    const hasLo = String(lo).trim() !== "", hasHi = String(hi).trim() !== "";
    if (!hasLo && !hasHi) return true;
    if (v == null) return false;
    if (hasLo && v < +lo) return false;
    if (hasHi && v > +hi) return false;
    return true;
  };

  function baseFiltered() {
    const f = state.filters;
    const q = f.q.trim().toLowerCase();
    return state.rows.filter((r) =>
      (f.mkt === "all" || r.mkt === f.mkt) &&
      (!q || r.code.includes(q) || r.name.toLowerCase().includes(q)) &&
      (!f.inds.size || f.inds.has(r.industry)) &&
      inRange(r.pe, f.peMin, f.peMax) &&
      inRange(r.eps, f.epsMin, f.epsMax) &&
      inRange(r.yield, f.yMin, f.yMax)
    );
  }

  function sortRows(list) {
    const { key, dir } = state.sort;
    return list.sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === "string") return x.localeCompare(y, "zh-Hant") * dir;
      return (x - y) * dir;
    });
  }

  function filtered() {
    const base = sortRows(baseFiltered());
    const tech = state.filters.tech;
    if (!tech.size) return { list: base, base };
    const list = base.filter((r) => {
      const a = state.ana.get(r.code);
      return a && !a.error && [...tech].every((k) => a.keys.has(k));
    });
    return { list, base };
  }

  const fmt = (v, d = 2) => (v == null ? '<span class="na">—</span>' : v.toLocaleString("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const priceDigits = (v) => (v == null ? 2 : v < 50 ? 2 : v >= 1000 ? 0 : 1);
  const dirCls = (v) => (v == null || Math.abs(v) < 1e-9 ? "flat" : v > 0 ? "up" : "down");
  const sign = (v, d = 2) => (v == null ? "—" : (v > 0 ? "▲" : v < 0 ? "▼" : "") + Math.abs(v).toFixed(d));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const p2 = (v) => (v == null ? "—" : (+v).toFixed(v < 50 ? 2 : v >= 1000 ? 0 : 1));
  const money = (v) => `<b class="${dirCls(v)}">${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v)).toLocaleString()}</b>`;
  const inWatch = (code) => state.watch.list.includes(code);
  const starBtn = (code) => `<button type="button" class="star" data-star="${esc(code)}" aria-pressed="${inWatch(code)}" aria-label="${inWatch(code) ? "移出自選" : "加入自選"}">${inWatch(code) ? "★" : "☆"}</button>`;

  function techCell(code) {
    const a = state.ana.get(code);
    if (!a) return "";
    if (a.error) return '<span class="mini wait">無資料</span>';
    let h = "";
    if (a.keys.has("hlBreak")) h += '<span class="mini pat">破前高</span>';
    else if (a.keys.has("hlWait")) h += '<span class="mini wait">底底高</span>';
    if (a.bull) h += `<span class="mini bull">多 ${a.bull}</span>`;
    if (a.bear) h += `<span class="mini bear">空 ${a.bear}</span>`;
    return h || '<span class="mini wait">中性</span>';
  }

  const HEAD_ALL = [
    ["", "star-col"], ["代號", "", "code"], ["名稱", "", "name"], ["產業", "col-ind", "industry"], ["收盤", "num", "close"],
    ["漲跌", "num", "pct"], ["本益比", "num", "pe"], ["EPS", "num", "eps"], ["殖利率", "num", "yield"],
    ["淨值比", "num col-pb", "pb"], ["成交量(張)", "num col-vol", "volume"], ["技術", "col-tech", "score"],
  ];
  const HEAD_WATCH = [
    ["", "star-col"], ["代號"], ["名稱"], ["現價", "num"], ["漲跌", "num"], ["持有(張)", "num"], ["成本", "num col-cost"],
    ["未實現損益", "num col-pl"], ["報酬率", "num"], ["提醒"], ["技術", "col-tech"],
  ];
  function renderHead() {
    const H = state.view === "all" ? HEAD_ALL : HEAD_WATCH;
    $("thead").innerHTML = "<tr>" + H.map(([t, cls, key]) => {
      const on = key && key === state.sort.key && state.view === "all";
      return `<th${cls ? ` class="${cls}${on ? " sorted" : ""}"` : on ? ' class="sorted"' : ""}${key && state.view === "all" ? ` data-key="${key}"` : ""}${on ? ` data-dir="${state.sort.dir > 0 ? "↑" : "↓"}"` : ""}>${t}</th>`;
    }).join("") + "</tr>";
  }

  function render() {
    renderHead();
    $("watchCount").textContent = state.watch.list.length;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
    $("sortWrap").hidden = state.view !== "all";
    $("watchTools").hidden = state.view !== "watch";
    if (state.view === "watch") renderWatch(); else renderAll();
    const f = state.filters;
    const active = [f.q, f.peMin, f.peMax, f.epsMin, f.epsMax, f.yMin, f.yMax].filter((v) => String(v).trim() !== "").length +
      (f.inds.size ? 1 : 0) + (f.tech.size ? 1 : 0) + (f.mkt !== "all" ? 1 : 0);
    $("activeCount").hidden = !active;
    $("activeCount").textContent = active;
    saveFilters();
  }

  function renderAll() {
    const { list, base } = filtered();
    const tb = $("tbody");
    if (!list.length) {
      const msg = state.filters.tech.size
        ? (state.syncing ? "歷史資料建立中，目前還沒有符合的股票，請稍候。" : "沒有符合技術條件的股票，試著減少條件或調整轉折靈敏度。")
        : "沒有符合條件的股票，試著放寬本益比或 EPS 區間。";
      tb.innerHTML = `<tr><td colspan="12" class="empty">${msg}</td></tr>`;
    } else {
      tb.innerHTML = list.slice(0, state.shown).map((r) => `
        <tr data-code="${esc(r.code)}" tabindex="0"${state.current === r.code ? ' class="active"' : ""}>
          <td class="star-cell">${starBtn(r.code)}</td>
          <td class="code">${esc(r.code)}${r.mkt === "O" ? '<span class="mkt">櫃</span>' : ""}</td>
          <td class="name${(state.trades[r.code] || []).length ? " has-trade" : ""}">${esc(r.name)}</td>
          <td class="col-ind">${esc(r.industry)}</td>
          <td class="num">${fmt(r.close, priceDigits(r.close))}</td>
          <td class="num ${dirCls(r.pct)}">${r.pct == null ? "—" : sign(r.pct) + "%"}</td>
          <td class="num">${fmt(r.pe)}</td>
          <td class="num ${r.eps != null && r.eps < 0 ? "down" : ""}">${fmt(r.eps)}</td>
          <td class="num">${r.yield == null ? fmt(null) : r.yield.toFixed(2) + "%"}</td>
          <td class="num col-pb">${fmt(r.pb)}</td>
          <td class="num col-vol">${fmt(r.volume, 0)}</td>
          <td class="col-tech">${techCell(r.code)}</td>
        </tr>`).join("");
    }
    $("moreBtn").hidden = list.length <= state.shown;
    $("moreBtn").textContent = `顯示更多（還有 ${Math.max(0, list.length - state.shown)} 檔）`;

    const pes = list.map((r) => r.pe).filter((v) => v != null).sort((a, b) => a - b);
    const med = pes.length ? pes[Math.floor(pes.length / 2)] : null;
    $("summary").innerHTML = `符合 <b>${list.length.toLocaleString()}</b> / ${state.rows.length.toLocaleString()} 檔` +
      (med != null ? `　本益比中位數 <b>${med.toFixed(1)}</b>` : "");

    const note = $("techNote");
    if (state.filters.tech.size) {
      const missing = base.filter((r) => !state.ana.has(r.code) || state.ana.get(r.code).error).length;
      const parts = [];
      if (state.syncing) parts.push("歷史資料還在建立中，結果會隨資料補齊而增加。");
      if (base.some((r) => { const a = state.ana.get(r.code); return a && a.prov; })) parts.push(`技術訊號含今天的盤中走勢（即時報價 ${(state.rtAllTime || "").slice(0, 5)}），收盤前可能改變。`);
      if (missing && !state.syncing) parts.push(`目前範圍有 ${missing} 檔沒有足夠的歷史資料（例如新上市或長期沒成交），沒有列入。`);
      note.hidden = !parts.length;
      note.textContent = parts.join("");
    } else note.hidden = true;

    const toScan = Math.min(base.filter((r) => !state.ana.has(r.code)).length, SCAN_MAX);
    $("scanBtn").textContent = state.scanning ? "掃描中…" : `逐檔掃描技術訊號（${toScan} 檔）`;
    $("scanBtn").disabled = state.scanning || !toScan;
  }

  function quoteOf(code) {
    const rt = state.rt[code];
    if (rt && rt.price != null && rt.date === todayStr()) return { price: rt.price, prev: rt.prev, src: "即時", time: rt.time };
    const r = rowOf(code);
    if (r && r.close != null) return { price: r.close, prev: r.change != null ? r.close - r.change : null, src: "收盤" };
    return null;
  }

  function renderWatch() {
    const tb = $("tbody");
    const list = state.watch.list;
    $("moreBtn").hidden = true;
    $("techNote").hidden = true;
    if (!list.length) {
      tb.innerHTML = `<tr><td colspan="11" class="empty">還沒有自選股。在股票列表點 ☆ 加入；在個股頁記錄交易或設定提醒時，也會自動加入。</td></tr>`;
      $("summary").innerHTML = "";
    } else {
      let totalUnreal = 0, totalCost = 0;
      tb.innerHTML = list.map((code) => {
        const r = rowOf(code);
        const q = quoteOf(code);
        const p = position(state.trades[code] || [], q && q.price);
        if (p.lots) { totalUnreal += p.unreal; totalCost += p.cost; }
        const chg = q && q.prev ? ((q.price - q.prev) / q.prev) * 100 : null;
        const al = state.watch.alerts[code] || [];
        const on = al.filter((a) => a.active).length, hit = al.filter((a) => !a.active).length;
        return `
        <tr data-code="${esc(code)}" tabindex="0"${state.current === code ? ' class="active"' : ""}>
          <td class="star-cell">${starBtn(code)}</td>
          <td class="code">${esc(code)}${r && r.mkt === "O" ? '<span class="mkt">櫃</span>' : ""}</td>
          <td class="name">${esc(r ? r.name : "—")}</td>
          <td class="num">${q ? fmt(q.price, priceDigits(q.price)) + (q.src === "即時" ? '<span class="rt">即時</span>' : "") : fmt(null)}</td>
          <td class="num ${dirCls(chg)}">${chg == null ? "—" : sign(chg) + "%"}</td>
          <td class="num">${p.lots ? p.lots : '<span class="na">—</span>'}</td>
          <td class="num col-cost">${p.avg != null ? p2(p.avg) : '<span class="na">—</span>'}</td>
          <td class="num col-pl">${p.lots ? money(p.unreal) : '<span class="na">—</span>'}</td>
          <td class="num ${dirCls(p.pct)}">${p.pct != null && p.lots ? (p.pct >= 0 ? "+" : "") + p.pct.toFixed(2) + "%" : '<span class="na">—</span>'}</td>
          <td>${on ? `<span class="st st-on">監控 ${on}</span>` : ""}${hit ? `<span class="st st-hit">已觸發 ${hit}</span>` : ""}${!on && !hit ? '<span class="na">—</span>' : ""}</td>
          <td class="col-tech">${techCell(code)}</td>
        </tr>`;
      }).join("");
      $("summary").innerHTML = `自選 <b>${list.length}</b> 檔` + (totalCost ? `　持股未實現損益 ${money(totalUnreal)} 元（${((totalUnreal / totalCost) * 100).toFixed(2)}%，未計手續費與稅）` : "");
    }
    const rtOn = inTradingHours() && state.mode === "live";
    $("quoteTxt").textContent = state.mode !== "live" ? "示範模式：使用示範收盤價" :
      state.rtError ? `即時報價暫時抓不到（${state.rtError}），先用收盤價` :
      state.rtTime ? `即時報價更新於 ${state.rtTime}${rtOn ? "，盤中每分鐘自動更新" : "（已收盤）"}` :
      rtOn ? "盤中每分鐘自動更新報價" : "目前非交易時間，使用最近收盤價";
    $("quoteBtn").disabled = state.mode !== "live";
  }

  function renderSkeleton() {
    renderHead();
    $("tbody").innerHTML = Array.from({ length: 10 }, () => `<tr class="sk">${"<td><span></span></td>".repeat(12)}</tr>`).join("");
    $("summary").textContent = "正在向證交所與櫃買中心取得資料…";
  }

  function syncInputs() {
    const f = state.filters;
    for (const k of ["q", "peMin", "peMax", "epsMin", "epsMax", "yMin", "yMax", "pivotW", "breakDays"]) $(k).value = f[k];
    const sv = `${state.sort.key}:${state.sort.dir}`;
    if ([...$("sortSel").options].some((o) => o.value === sv)) $("sortSel").value = sv;
    document.querySelectorAll("#mktSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mkt === f.mkt));
    document.querySelectorAll(".ind[data-ind]").forEach((b) => b.setAttribute("aria-pressed", f.inds.has(b.dataset.ind)));
    document.querySelectorAll(".ind[data-tech]").forEach((b) => b.setAttribute("aria-pressed", f.tech.has(b.dataset.tech)));
  }

  function saveFilters() {
    const f = state.filters;
    ls.set("tw-screener-v2", { ...f, inds: [...f.inds], tech: [...f.tech], sort: state.sort, ov: state.ov, view: state.view });
  }
  function loadFilters() {
    const s = ls.get("tw-screener-v2");
    if (!s) return;
    const d = defaultFilters();
    for (const k of Object.keys(d)) if (k in s && k !== "inds" && k !== "tech") d[k] = s[k] ?? d[k];
    d.inds = new Set(s.inds || []);
    d.tech = new Set((s.tech || []).filter((k) => TECH_FILTERS.some(([x]) => x === k)));
    state.filters = d;
    if (s.sort) state.sort = s.sort;
    if (s.ov) Object.assign(state.ov, s.ov);
    if (s.view === "watch") state.view = "watch";
  }

  const PRESETS = {
    value: { peMin: "0", peMax: "12", epsMin: "0", epsMax: "", yMin: "", yMax: "", sort: { key: "pe", dir: 1 } },
    yield: { peMin: "", peMax: "", epsMin: "0", epsMax: "", yMin: "5", yMax: "", sort: { key: "yield", dir: -1 } },
    profit: { peMin: "", peMax: "", epsMin: "5", epsMax: "", yMin: "", yMax: "", sort: { key: "eps", dir: -1 } },
    loss: { peMin: "", peMax: "", epsMin: "", epsMax: "0", yMin: "", yMax: "", sort: { key: "eps", dir: 1 } },
  };

  /* ===================================================== 逐檔歷史（備案） */
  function parseTable(fields, rows, volFactor) {
    const idx = { d: 0, v: 1, o: 3, h: 4, l: 5, c: 6 };
    let vf = volFactor;
    if (Array.isArray(fields) && fields.length) {
      const find = (re) => fields.findIndex((f) => re.test(String(f)));
      const m = { d: find(/日期/), o: find(/開盤/), h: find(/最高/), l: find(/最低/), c: find(/收盤/), v: find(/成交(股數|仟股|張數)/) };
      for (const k of Object.keys(m)) if (m[k] >= 0) idx[k] = m[k];
      const vName = String(fields[idx.v] || "");
      vf = /仟股|張/.test(vName) ? 1 : /股/.test(vName) ? 1 / 1000 : vf;
    }
    const out = [];
    for (const r of rows || []) {
      const time = rocToISO(r[idx.d]);
      const o = num(r[idx.o]), h = num(r[idx.h]), l = num(r[idx.l]), c = num(r[idx.c]);
      if (!time || [o, h, l, c].some((v) => v == null || v <= 0)) continue;
      out.push({ time, open: o, high: h, low: l, close: c, volume: Math.round((num(r[idx.v]) || 0) * vf) });
    }
    return out;
  }

  const HIST_SOURCES = {
    L: [
      (code, y, m) => ({
        url: `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${y}${pad(m)}01&stockNo=${code}&response=json`,
        parse: (j) => (j && j.stat === "OK" ? parseTable(j.fields, j.data, 1 / 1000) : j && j.stat ? [] : null),
      }),
    ],
    O: [
      (code, y, m) => ({
        url: `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${y}/${pad(m)}/01&response=json`,
        parse: (j) => {
          const t = j && Array.isArray(j.tables) ? j.tables[0] : null;
          if (t && Array.isArray(t.data)) return parseTable(t.fields, t.data, 1);
          return j && /ok/i.test(j.stat || "") ? [] : null;
        },
      }),
      (code, y, m) => ({
        url: `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${y - 1911}/${pad(m)}&stkno=${code}`,
        parse: (j) => (j && Array.isArray(j.aaData) ? parseTable(null, j.aaData, 1) : null),
      }),
    ],
  };

  async function getMonth(row, y, m) {
    const key = `h:${row.mkt}:${row.code}:${y}${pad(m)}`;
    const now = new Date();
    const isCur = y === now.getFullYear() && m === now.getMonth() + 1;
    const cached = ls.get(key);
    if (cached && (!isCur || cached.d === todayStr())) return cached.b;
    let lastErr;
    for (const mk of HIST_SOURCES[row.mkt]) {
      const { url, parse } = mk(row.code, y, m);
      try {
        const bars = parse(await getJSON(url, 15000));
        if (bars) { ls.set(key, { d: todayStr(), b: bars }); return bars; }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("無法解析歷史資料");
  }

  async function loadHistory(row, months) {
    const db = state.dbBars.get(row.code);
    if (db && db.length >= 60) return db;
    const have = state.hist.get(row.code);
    if (have && have.months >= months) return have.bars;
    let bars;
    if (state.mode === "live") {
      const now = new Date();
      const all = new Map();
      let fails = 0;
      for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        try {
          for (const b of await getMonth(row, d.getFullYear(), d.getMonth() + 1)) all.set(b.time, b);
        } catch (e) { fails++; console.warn("歷史資料失敗", row.code, d, e); }
      }
      bars = [...all.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
      if (bars.length < 25) {
        if (db && db.length >= MIN_BARS) return db;
        throw new Error(fails ? "歷史資料抓取失敗" : "歷史資料不足");
      }
    } else {
      bars = demoHistory(row);
    }
    state.hist.set(row.code, { bars, months });
    return bars;
  }

  function demoHistory(row) {
    let seed = [...row.code].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const n = 150;
    let closes = [];
    if (row.demoShape) {
      const pts = row.demoShape === "hl"
        ? [[0, 0.8], [70, 0.98], [92, 0.86], [115, 1.03], [130, 0.93], [149, 1.07]]
        : [[0, 0.85], [70, 1.0], [95, 0.86], [118, 1.04], [136, 0.92], [149, 0.99]];
      for (let i = 0; i < n; i++) {
        let s = 0;
        while (s < pts.length - 2 && i > pts[s + 1][0]) s++;
        const [x0, y0] = pts[s], [x1, y1] = pts[s + 1];
        closes.push((y0 + ((y1 - y0) * (i - x0)) / (x1 - x0)) * (1 + (rnd() - 0.5) * 0.006));
      }
    } else {
      closes = [1];
      for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + (rnd() - 0.48) * 0.04));
    }
    const k = row.close / closes[n - 1];
    const dates = [];
    let d = todayStr();
    while (dates.length < n) { if (!isWeekend(d)) dates.unshift(d); d = prevDay(d); }
    const r2 = (v) => +v.toFixed(v < 50 ? 2 : 1);
    return closes.map((cl, i) => {
      const c = cl * k;
      const o = i ? closes[i - 1] * k * (1 + (rnd() - 0.5) * 0.008) : c;
      const up = c >= (i ? closes[i - 1] * k : c);
      return {
        time: dates[i], open: r2(o), close: r2(c),
        high: r2(Math.max(o, c) * (1 + rnd() * 0.01)), low: r2(Math.min(o, c) * (1 - rnd() * 0.01)),
        volume: Math.round((row.volume || 1000) * (0.5 + rnd()) * (up && row.demoShape && i > n - 8 ? 1.9 : 1)),
      };
    });
  }

  /* =========================================================== indicators */
  const SMA = (v, n) => {
    const out = new Array(v.length).fill(null);
    let s = 0;
    for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) out[i] = s / n; }
    return out;
  };
  const EMA = (v, n) => { const k = 2 / (n + 1), o = []; v.forEach((x, i) => o.push(i ? x * k + o[i - 1] * (1 - k) : x)); return o; };
  function KD(bars, n = 9) {
    let k = 50, d = 50;
    return bars.map((b, i) => {
      if (i < n - 1) return { k: null, d: null };
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) { if (bars[j].high > hh) hh = bars[j].high; if (bars[j].low < ll) ll = bars[j].low; }
      const rsv = hh === ll ? 50 : ((b.close - ll) / (hh - ll)) * 100;
      k = (2 / 3) * k + rsv / 3;
      d = (2 / 3) * d + k / 3;
      return { k, d };
    });
  }
  function MACD(c) {
    const e12 = EMA(c, 12), e26 = EMA(c, 26);
    const dif = c.map((_, i) => e12[i] - e26[i]);
    const dea = EMA(dif, 9);
    return dif.map((v, i) => ({ dif: i < 25 ? null : v, dea: i < 33 ? null : dea[i], osc: i < 33 ? null : v - dea[i] }));
  }
  function RSI(c, n = 14) {
    const out = c.map(() => null);
    let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const ch = c[i] - c[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0);
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return out;
  }
  function BOLL(c, n = 20, m = 2) {
    const mid = SMA(c, n);
    return c.map((_, i) => {
      if (mid[i] == null) return { mid: null, up: null, lo: null, bw: null };
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      return { mid: mid[i], up: mid[i] + m * sd, lo: mid[i] - m * sd, bw: (2 * m * sd) / mid[i] };
    });
  }
  const BIAS = (c, ma) => c.map((x, i) => (ma[i] == null ? null : ((x - ma[i]) / ma[i]) * 100));

  function pivots(bars, w) {
    const raw = [];
    for (let i = w; i < bars.length - w; i++) {
      let isH = true, isL = true;
      for (let j = i - w; j <= i + w && (isH || isL); j++) {
        if (j === i) continue;
        if (bars[j].high > bars[i].high || (j < i && bars[j].high === bars[i].high)) isH = false;
        if (bars[j].low < bars[i].low || (j < i && bars[j].low === bars[i].low)) isL = false;
      }
      if (isH) raw.push({ i, type: "H", price: bars[i].high });
      if (isL) raw.push({ i, type: "L", price: bars[i].low });
    }
    const alt = [];
    for (const p of raw) {
      const last = alt[alt.length - 1];
      if (last && last.type === p.type) {
        if ((p.type === "H" && p.price >= last.price) || (p.type === "L" && p.price <= last.price)) alt[alt.length - 1] = p;
      } else alt.push(p);
    }
    return alt;
  }

  function hlPattern(bars, w, recent) {
    const piv = pivots(bars, w);
    const lows = piv.filter((p) => p.type === "L");
    if (lows.length < 2) return null;
    const L2 = lows[lows.length - 1], L1 = lows[lows.length - 2];
    const H = piv.find((p) => p.type === "H" && p.i > L1.i && p.i < L2.i);
    if (!H) return null;
    const H0 = [...piv].reverse().find((p) => p.type === "H" && p.i < L1.i) || null;
    const n = bars.length - 1;
    let k = -1;
    for (let i = L2.i + 1; i <= n; i++) if (bars[i].close > H.price) { k = i; break; }
    const higherLow = L2.price > L1.price;
    const ago = k >= 0 ? n - k : null;
    const holding = bars[n].close >= H.price;
    let status = "none";
    if (higherLow) {
      if (k < 0) status = bars[n].close < L2.price ? "none" : "wait";
      else if (holding && ago < recent) status = "break";
      else if (!holding) status = "fail";
      else status = "old";
    }
    return { L1, H, L2, H0, k, ago, higherLow, holding, status, piv };
  }

  function supportResistance(bars, w, look = 120) {
    const start = Math.max(0, bars.length - look);
    const piv = pivots(bars, w).filter((p) => p.i >= start);
    const c = bars[bars.length - 1].close;
    const res = piv.filter((p) => p.type === "H" && p.price > c * 1.003).map((p) => p.price).sort((a, b) => a - b)[0];
    const sup = piv.filter((p) => p.type === "L" && p.price < c * 0.997).map((p) => p.price).sort((a, b) => b - a)[0];
    const win = bars.slice(start);
    const hi = Math.max(...win.map((b) => b.high)), lo = Math.min(...win.map((b) => b.low));
    return { res: res ?? (hi > c * 1.003 ? hi : null), sup: sup ?? (lo < c * 0.997 ? lo : null) };
  }

  function computeAll(bars) {
    const c = bars.map((b) => b.close);
    const ma20 = SMA(c, 20), ma60 = SMA(c, 60);
    return { ma5: SMA(c, 5), ma20, ma60, kd: KD(bars), macd: MACD(c), rsi: RSI(c), boll: BOLL(c), bias20: BIAS(c, ma20), bias60: BIAS(c, ma60) };
  }

  /* ====================================================== signal library */
  function analyze(row, bars) {
    const w = +state.filters.pivotW, recent = +state.filters.breakDays;
    const ind = computeAll(bars);
    const n = bars.length - 1;
    const b = bars[n], c = b.close, name = row ? row.name : "";
    const { ma5, ma20, ma60, kd, macd, rsi, boll, bias20 } = ind;
    const S = [];
    const add = (key, tone, title, meaning, caveat, report) => S.push({ key, tone, title, meaning, caveat, report });
    const slope = (arr) => {
      if (arr[n] == null || arr[n - 5] == null) return "";
      const d = (arr[n] - arr[n - 5]) / arr[n - 5];
      return d > 0.003 ? "上彎" : d < -0.003 ? "下彎" : "走平";
    };
    const P = (v) => p2(v);
    const dt = (i) => md(bars[i].time);

    const pat = hlPattern(bars, w, recent);
    if (pat && pat.higherLow) {
      const { L1, H, L2, H0, k, ago } = pat;
      const hh = H0 && H.price > H0.price ? "，且前高也高於更早的高點（頭頭高）" : "";
      const base = `最近一個轉折低點 ${P(L2.price)}（${dt(L2.i)}）高於前一個低點 ${P(L1.price)}（${dt(L1.i)}），代表回檔沒有跌破前低${hh}。`;
      if (pat.status === "break") {
        add("hlBreak", "bull", `底底高＋突破前高 ${P(H.price)}（${ago ? ago + " 日前" : "今日"}突破）`,
          base + `接著股價在 ${dt(k)} 收盤 ${P(bars[k].close)} 突破兩個低點之間的高點 ${P(H.price)}。高點和低點一起墊高，就是道氏理論對多頭趨勢的定義。`,
          `轉折點怎麼認定會影響結果（左側「轉折靈敏度」可以調）。突破後如果收盤又跌回 ${P(H.price)} 以下，常被視為假突破，很多人會把前高或前低 ${P(L2.price)} 當停損參考。`,
          `${name}自 ${dt(L1.i)} 低點 ${P(L1.price)} 元反彈後，於 ${dt(L2.i)} 回檔至 ${P(L2.price)} 元未跌破前低，形成底底高；${dt(k)} 收盤 ${P(bars[k].close)} 元突破前高 ${P(H.price)} 元，呈現多頭趨勢結構。若收盤跌回 ${P(H.price)} 元以下，則視為突破失敗。`);
      } else if (pat.status === "wait") {
        const dist = ((H.price - c) / c) * 100;
        add("hlWait", "neutral", `底底高，距前高 ${P(H.price)} 還有 ${dist.toFixed(1)}%`,
          base + `目前還沒有收盤站上兩低點之間的高點 ${P(H.price)}，多頭結構尚未確認。`,
          "底底高只代表賣壓減輕，要等收盤突破前高才算確認；若跌破前一個低點，型態就失效。",
          `${name}近期低點由 ${P(L1.price)} 元墊高至 ${P(L2.price)} 元，呈現底底高，但尚未突破前高 ${P(H.price)} 元，後續觀察能否帶量突破。`);
      } else if (pat.status === "fail") {
        add("hlFail", "bear", `突破前高 ${P(H.price)} 後又跌回`,
          base + `股價曾在 ${dt(k)} 收盤突破前高 ${P(H.price)}，但現在又回到前高之下。`,
          "假突破常代表追價買盤不足，短線容易回測前低。",
          `${name}於 ${dt(k)} 一度突破前高 ${P(H.price)} 元，但目前收盤 ${P(c)} 元已跌回其下，突破失敗，需留意回測前低 ${P(L2.price)} 元。`);
      }
    }

    if (ma20[n] != null) {
      const s = slope(ma20);
      if (c >= ma20[n]) add("aboveMA20", "bull", `收盤站上月線 MA20（${P(ma20[n])}，${s}）`,
        "月線是近 20 個交易日的平均收盤價，可以看成最近一個月買進者的平均成本。股價在月線之上，代表這群人平均是賺錢的，短中期趨勢偏多。",
        "股價在月線附近來回穿越時訊號容易失真，最好同時看月線是上彎還是下彎。",
        `${name}收盤價 ${P(c)} 元位於月線（${P(ma20[n])} 元）之上，月線${s}，短中期趨勢偏多。`);
      else add("belowMA20", "bear", `收盤跌破月線 MA20（${P(ma20[n])}，${s}）`,
        "股價低於近 20 日平均成本，最近一個月買進的人平均是虧損的，短中期趨勢偏弱，月線容易變成反彈的壓力。",
        "急跌後常會反彈到月線附近，跌破不代表會一路跌。",
        `${name}收盤價 ${P(c)} 元跌破月線（${P(ma20[n])} 元），月線${s}，短中期走勢偏弱。`);
    }
    if (ma60[n] != null) {
      if (c >= ma60[n]) add("aboveMA60", "bull", `站上季線 MA60（${P(ma60[n])}）`,
        "季線是近 60 個交易日（約一季）的平均成本，常被當作中期多空分界。站上季線代表中期趨勢偏多。",
        "季線反應慢，轉折時會落後，適合用來判斷大方向。",
        `${name}股價位於季線（${P(ma60[n])} 元）之上，中期趨勢偏多。`);
      else add("belowMA60", "bear", `位於季線 MA60（${P(ma60[n])}）之下`,
        "股價低於近一季的平均成本，中期趨勢偏空，季線附近通常有解套賣壓。",
        "長期下跌後剛站回季線的股票，常要多次測試才站得穩。",
        `${name}股價仍在季線（${P(ma60[n])} 元）之下，中期趨勢偏空。`);
    }
    if (ma5[n] != null && ma60[n] != null) {
      if (ma5[n] > ma20[n] && ma20[n] > ma60[n]) add("bullAlign", "bull", "均線多頭排列（MA5 > MA20 > MA60）",
        "短、中、長期均線由上而下排列，代表各期間買進的人都在獲利，是典型的多頭格局。",
        "排列成形時股價通常已經漲一段，追價要留意乖離是否過大。",
        `${name}短中長期均線呈多頭排列（5 日 ${P(ma5[n])}、20 日 ${P(ma20[n])}、60 日 ${P(ma60[n])}），趨勢偏多。`);
      else if (ma5[n] < ma20[n] && ma20[n] < ma60[n]) add("bearAlign", "bear", "均線空頭排列（MA5 < MA20 < MA60）",
        "短、中、長期均線由下而上排列，各期間買進的人都套牢，反彈容易遇到賣壓。",
        "空頭排列中出現的反彈常只是短線，要等均線糾結、翻揚才比較有轉機。",
        `${name}均線呈空頭排列，趨勢偏弱。`);
    }
    for (let i = n; i > n - 5 && i > 0; i--) {
      if (ma5[i - 1] == null || ma20[i - 1] == null) break;
      const when = n - i ? `${n - i} 日前` : "今日";
      if (ma5[i - 1] <= ma20[i - 1] && ma5[i] > ma20[i]) {
        add("maGolden", "bull", `MA5 上穿 MA20（${when}）`,
          "5 日均線由下往上穿過月線，代表最近一週的平均成本高於最近一個月，短期買氣轉強。",
          "均線是落後指標，盤整時很容易出現交叉又馬上交叉回去的假訊號。",
          `${name}於 ${dt(i)} 出現 5 日均線上穿月線的黃金交叉，短期買氣轉強。`); break;
      }
      if (ma5[i - 1] >= ma20[i - 1] && ma5[i] < ma20[i]) {
        add("maDeath", "bear", `MA5 下穿 MA20（${when}）`,
          "5 日均線由上往下跌破月線，短期走勢轉弱。",
          "在多頭趨勢中的短暫死叉，有時只是回檔整理。",
          `${name}於 ${dt(i)} 出現 5 日均線下穿月線的死亡交叉，短期轉弱。`); break;
      }
    }

    for (let i = n; i > n - 3 && i > 0; i--) {
      const a = kd[i - 1], z = kd[i];
      if (a.k == null) break;
      if (a.k <= a.d && z.k > z.d) {
        add("kdGolden", "bull", `KD 黃金交叉${z.k < 30 ? "（低檔）" : ""}　K ${z.k.toFixed(0)} / D ${z.d.toFixed(0)}`,
          "KD 衡量收盤價落在近 9 日高低區間的哪個位置。K 值由下往上穿過 D 值，代表短線動能轉強；發生在 20–30 以下的低檔區時意義比較強。",
          "KD 很敏感，盤整時會頻繁交叉；最好搭配均線或型態一起判斷。",
          `${name} KD 指標於 ${dt(i)} 出現黃金交叉（K ${z.k.toFixed(1)}、D ${z.d.toFixed(1)}）${z.k < 30 ? "，且位於低檔區" : ""}，短線動能轉強。`); break;
      }
      if (a.k >= a.d && z.k < z.d) {
        add("kdDeath", "bear", `KD 死亡交叉${z.k > 70 ? "（高檔）" : ""}　K ${z.k.toFixed(0)} / D ${z.d.toFixed(0)}`,
          "K 值由上往下跌破 D 值，代表短線動能轉弱；在 80 附近的高檔區發生時，常是短線拉回的訊號。",
          "強勢股常在高檔反覆交叉（鈍化），不一定真的會跌。",
          `${name} KD 指標於 ${dt(i)} 出現死亡交叉（K ${z.k.toFixed(1)}、D ${z.d.toFixed(1)}），短線動能轉弱。`); break;
      }
    }
    const k = kd[n].k;
    if (k != null && k > 80) add("kdHigh", "neutral", `K 值 ${k.toFixed(0)}，超買區`,
      "K 值高於 80，代表收盤價接近近 9 日最高點，短線漲多。", "強勢股可能在 80 以上持續鈍化，不能單獨當賣出訊號。",
      `${name} K 值達 ${k.toFixed(1)}，進入超買區，短線漲多。`);
    if (k != null && k < 20) add("kdLow", "neutral", `K 值 ${k.toFixed(0)}，超賣區`,
      "K 值低於 20，代表收盤價接近近 9 日最低點，短線跌深。", "弱勢股可能在低檔持續鈍化，要等黃金交叉或止跌訊號。",
      `${name} K 值為 ${k.toFixed(1)}，進入超賣區，短線跌深。`);

    const r = rsi[n];
    if (r != null && r > 70) add("rsiHigh", "neutral", `RSI ${r.toFixed(0)} 偏熱`,
      "RSI 比較近 14 日上漲和下跌的力道。高於 70 代表近期漲勢過猛，可能過熱。", "多頭行情中 RSI 可以長時間維持在 70 以上。",
      `${name} RSI(14) 為 ${r.toFixed(1)}，短線偏熱。`);
    if (r != null && r < 30) add("rsiLow", "neutral", `RSI ${r.toFixed(0)} 偏冷`,
      "RSI 低於 30 代表近期跌勢過重，可能出現跌深反彈。", "空頭行情中 RSI 可以長時間低於 30，不代表馬上止跌。",
      `${name} RSI(14) 為 ${r.toFixed(1)}，短線超跌。`);

    const m = macd[n], mp = macd[n - 1];
    if (m.osc != null && mp && mp.osc != null) {
      const MEAN = "MACD 用 12 日和 26 日指數平均線的差（DIF）表示趨勢動能，再和它自己的 9 日平均比較。柱狀體 OSC = DIF − MACD。";
      if (mp.osc <= 0 && m.osc > 0) add("macdUp", "bull", "MACD 柱狀體翻正", MEAN + "柱狀體由負翻正，代表中期動能轉強。",
        "MACD 反應較慢，適合確認趨勢，不適合抓最低點。", `${name} MACD 柱狀體由負翻正（OSC ${m.osc.toFixed(2)}），中期動能轉強。`);
      else if (mp.osc >= 0 && m.osc < 0) add("macdDown", "bear", "MACD 柱狀體翻負", MEAN + "柱狀體由正翻負，代表中期動能轉弱。",
        "在大多頭裡的短暫翻負，有時只是整理。", `${name} MACD 柱狀體由正翻負（OSC ${m.osc.toFixed(2)}），中期動能轉弱。`);
      else {
        const grow = Math.abs(m.osc) > Math.abs(mp.osc);
        add(m.osc > 0 ? "macdPos" : "macdNeg", m.osc > 0 ? "bull" : "bear", `MACD 柱狀體${m.osc > 0 ? "為正" : "為負"}${grow ? "且擴大" : "但收斂"}`,
          MEAN + (m.osc > 0 ? "柱狀體為正代表多方動能占優" : "柱狀體為負代表空方動能占優") + (grow ? "，而且力道還在增加。" : "，但力道正在減弱。"),
          "柱狀體收斂常是轉折的前兆，但要等翻正或翻負才確認。",
          `${name} MACD 柱狀體${m.osc > 0 ? "為正" : "為負"}（OSC ${m.osc.toFixed(2)}）${grow ? "並持續擴大" : "但逐漸收斂"}。`);
      }
    }

    const vWin = bars.slice(-21, -1);
    const vAvg = vWin.length ? vWin.reduce((a, x) => a + x.volume, 0) / vWin.length : 0;
    if (vAvg && b.volume > vAvg * 1.5 && n > 0) {
      const up = c >= bars[n - 1].close;
      const x = (b.volume / vAvg).toFixed(1);
      add(up ? "volUp" : "volDown", up ? "bull" : "bear", `${up ? "價漲量增" : "價跌量增"}（量為 20 日均量 ${x} 倍）`,
        up ? "上漲時成交量明顯放大，代表有較多買盤願意追價，漲勢比較有支撐。" : "下跌時成交量放大，代表賣壓沉重，有人急著出場。",
        up ? "如果是在高檔連續爆量但股價漲不動，反而可能是出貨。" : "長期下跌後的爆量長黑，有時是最後的恐慌賣壓。",
        `${name}今日成交 ${b.volume.toLocaleString()} 張，為 20 日均量的 ${x} 倍，${up ? "價漲量增" : "價跌量增"}。`);
    }

    const bo = boll[n];
    if (bo.up != null) {
      if (c > bo.up) add("bollBreakUp", "bull", `收盤突破布林上軌（${P(bo.up)}）`,
        "布林通道是月線上下加減 2 個標準差，約涵蓋 95% 的價格波動。收盤站上上軌代表走勢強勁，可能啟動新一波行情。",
        "也可能是短線過熱，常見股價沿上軌走一段後拉回中軌（月線）整理。",
        `${name}收盤 ${P(c)} 元突破布林通道上軌 ${P(bo.up)} 元，走勢強勁。`);
      if (c < bo.lo) add("bollBreakDown", "bear", `收盤跌破布林下軌（${P(bo.lo)}）`,
        "收盤跌破下軌代表跌勢超出正常波動範圍，賣壓沉重。", "跌破下軌後常有技術性反彈，但不代表趨勢反轉。",
        `${name}收盤 ${P(c)} 元跌破布林通道下軌 ${P(bo.lo)} 元，賣壓沉重。`);
      const bws = boll.slice(-60).map((x) => x.bw).filter((x) => x != null);
      if (bws.length > 40 && bo.bw <= Math.min(...bws) * 1.1) add("bollSqueeze", "neutral", `布林通道收斂（帶寬 ${(bo.bw * 100).toFixed(1)}%）`,
        "通道寬度接近近 60 日最窄，代表波動降到很低，常是大行情前的醞釀期。", "收斂只說明「快要動了」，方向要等突破上軌或跌破下軌才知道。",
        `${name}布林通道帶寬縮至 ${(bo.bw * 100).toFixed(1)}%，為近期最窄，後續可留意帶量突破方向。`);
    }

    const bi = bias20[n];
    if (bi != null && bi > 10) add("biasHigh", "neutral", `20 日正乖離 ${bi.toFixed(1)}%`,
      "乖離率是股價偏離均線的百分比。正乖離過大代表短期漲太快、離平均成本太遠，容易拉回。", "門檻因個股波動而異，大型權值股 5–8% 就算偏高，小型股可能 15% 以上才算。",
      `${name}股價與月線正乖離達 ${bi.toFixed(1)}%，短線漲幅偏大，留意拉回。`);
    if (bi != null && bi < -10) add("biasLow", "neutral", `20 日負乖離 ${bi.toFixed(1)}%`,
      "負乖離過大代表股價跌得離平均成本太遠，常出現跌深反彈。", "反彈不等於反轉，空頭行情中負乖離可以持續擴大。",
      `${name}股價與月線負乖離達 ${bi.toFixed(1)}%，短線跌深，有反彈機會。`);

    const sr = supportResistance(bars, w);
    if (sr.res != null && (sr.res - c) / c < 0.03) add("nearRes", "neutral", `接近壓力 ${P(sr.res)}（差 ${(((sr.res - c) / c) * 100).toFixed(1)}%）`,
      "壓力是近期轉折高點的價位，之前在那裡買進的人可能想解套賣出。", "帶量突破壓力後，壓力常轉為支撐。",
      `${name}股價接近前波高點 ${P(sr.res)} 元的壓力區。`);
    if (sr.sup != null && (c - sr.sup) / c < 0.03) add("nearSup", "neutral", `接近支撐 ${P(sr.sup)}（差 ${(((c - sr.sup) / c) * 100).toFixed(1)}%）`,
      "支撐是近期轉折低點的價位，之前在那裡有買盤承接。", "跌破支撐後，支撐常轉為壓力。",
      `${name}股價接近前波低點 ${P(sr.sup)} 元的支撐區。`);

    const order = { hlBreak: 0, hlWait: 1, hlFail: 1 };
    S.sort((a, z) => (order[a.key] ?? 5) - (order[z.key] ?? 5));
    const bull = S.filter((s) => s.tone === "bull").length, bear = S.filter((s) => s.tone === "bear").length;
    return { sigs: S, keys: new Set(S.map((s) => s.key)), bull, bear, score: bull - bear, pat, sr, ind, last: bars[n].time };
  }

  function setAnalysis(row, bars, prov) {
    const a = analyze(row, bars);
    // 表格只需要訊號與分數；指標陣列只在個股圖表使用，不留在記憶體
    const slim = { keys: a.keys, bull: a.bull, bear: a.bear, score: a.score, last: a.last, sigs: a.sigs, prov: !!prov };
    state.ana.set(row.code, slim);
    row.score = a.score;
    return slim;
  }

  let anaGen = 0;
  async function analyzeAll() {
    const gen = ++anaGen;
    const rows = state.rows;
    for (let i = 0; i < rows.length; i++) {
      if (gen !== anaGen) return;
      const r = rows[i];
      const b = state.dbBars.get(r.code);
      if (b && b.length >= MIN_BARS) { const w = withProvisional(r.code, b); setAnalysis(r, w.bars, w.prov); }
      else if (!state.hist.has(r.code)) { state.ana.delete(r.code); r.score = null; }
      if (i % 150 === 149) await sleep(0);
    }
    if (gen === anaGen) render();
  }

  /* ================================================================ 逐檔掃描 */
  async function scan() {
    if (state.scanning) return;
    const targets = sortRows(baseFiltered()).filter((r) => !state.ana.has(r.code)).slice(0, SCAN_MAX);
    if (!targets.length) return;
    state.scanning = true;
    state.scanAbort = false;
    $("scanProg").hidden = false;
    render();
    let done = 0, fail = 0;
    const t0 = Date.now();
    for (const row of targets) {
      if (state.scanAbort) break;
      try {
        const bars = await loadHistory(row, SCAN_MONTHS);
        setAnalysis(row, bars);
      } catch (e) {
        fail++;
        state.ana.set(row.code, { error: true, keys: new Set() });
        row.score = null;
      }
      done++;
      $("scanBar").style.width = `${(done / targets.length) * 100}%`;
      const left = Math.round((((Date.now() - t0) / done) * (targets.length - done)) / 1000);
      $("scanTxt").textContent = `${done} / ${targets.length}　${row.code} ${row.name}${left > 3 ? `　約剩 ${left} 秒` : ""}`;
      if (done % 3 === 0 || done === targets.length) render();
    }
    state.scanning = false;
    $("scanTxt").textContent = state.scanAbort ? `已停止，完成 ${done} 檔` : `完成 ${done} 檔${fail ? `，${fail} 檔抓不到資料` : ""}。`;
    render();
  }

  /* ============================================================== detail */
  async function openDetail(code) {
    const r = rowOf(code);
    if (!r) return;
    state.current = code;
    state.detailBars = null;
    state.detailBase = null;
    state.detailProv = false;
    state.detailAna = null;
    state.editTrade = null;
    state.editAlert = null;
    document.querySelectorAll("#tbody tr").forEach((tr) => tr.classList.toggle("active", tr.dataset.code === code));
    $("detail").hidden = false;
    $("scrim").hidden = false;
    document.body.style.overflow = "hidden";

    $("dName").textContent = r.name;
    $("dCode").textContent = r.code;
    $("dMkt").textContent = r.mkt === "O" ? "上櫃" : "上市";
    $("dInd").textContent = r.industry;
    renderDetailPrice();
    $("kPE").textContent = r.pe == null ? "—" : r.pe.toFixed(2);
    $("kEPS").textContent = r.eps == null ? "—" : r.eps.toFixed(2);
    $("kY").textContent = r.yield == null ? "—" : r.yield.toFixed(2) + "%";
    $("kPB").textContent = r.pb == null ? "—" : r.pb.toFixed(2);
    renderStar();

    $("signals").innerHTML = '<p class="empty-sig">載入歷史股價中…</p>';
    $("ohlc").textContent = "載入歷史股價中…";
    resetTradeForm();
    resetAlertForm();
    renderTrades();
    renderAlerts();
    destroyCharts();
    showChartMsg("");
    renderExplain();
    loadNews(r);

    try {
      const bars = await loadHistory(r, DETAIL_MONTHS);
      if (state.current !== code) return;
      state.detailBase = bars;
      const w = withProvisional(code, bars);
      state.detailBars = w.bars;
      state.detailProv = w.prov;
      state.detailAna = analyze(r, w.bars);
      drawCharts();
      renderSignals();
    } catch (e) {
      if (state.current !== code) return;
      $("ohlc").textContent = "";
      $("signals").innerHTML = "";
      showChartMsg("無法取得歷史股價（交易所可能暫時限制連線頻率），請稍後再試。");
    }
  }

  function renderDetailPrice() {
    const code = state.current;
    if (!code) return;
    const r = rowOf(code);
    const q = quoteOf(code);
    const chg = q && q.prev != null ? q.price - q.prev : r.change;
    const pct = q && q.prev ? (chg / q.prev) * 100 : r.pct;
    $("dClose").textContent = q ? q.price.toLocaleString() : "—";
    $("dChg").className = "mono " + dirCls(chg);
    $("dChg").textContent = chg == null ? "—" : `${sign(chg)}  ${sign(pct)}%${q && q.src === "即時" ? `　即時 ${q.time || ""}` : ""}`;
  }

  function renderStar() {
    const on = inWatch(state.current);
    $("dStar").setAttribute("aria-pressed", on);
    $("dStar").textContent = on ? "★ 已加入自選" : "☆ 加入自選";
  }

  function closeDetail() {
    $("detail").hidden = true;
    $("scrim").hidden = true;
    document.body.style.overflow = "";
    state.current = null;
    destroyCharts();
    document.querySelectorAll("#tbody tr.active").forEach((tr) => tr.classList.remove("active"));
  }

  function showChartMsg(msg) {
    $("chartMsg").textContent = msg;
    $("chartMsg").hidden = !msg;
    $("chartMain").hidden = !!msg;
    $("chartInd").hidden = !!msg;
  }

  function renderSignals() {
    const a = state.detailAna;
    if (!a) return;
    const TAG = { bull: "偏多", bear: "偏空", neutral: "留意" };
    $("signals").innerHTML = a.sigs.length ? a.sigs.map((s, i) => `
      <details class="sig-card ${s.tone}${s.key.startsWith("hl") ? " pattern" : ""}"${s.key === "hlBreak" ? " open" : ""}>
        <summary><span class="sig-tag">${TAG[s.tone]}</span><span>${esc(s.title)}</span></summary>
        <div class="sig-body">
          <p><b>代表什麼</b>${esc(s.meaning)}</p>
          <p><b>要注意</b>${esc(s.caveat)}</p>
          <div class="report"><span>${esc(s.report)}</span><button type="button" class="copy" data-copy="${i}">複製</button></div>
        </div>
      </details>`).join("") : '<p class="empty-sig">目前沒有明顯的技術訊號。</p>';
  }

  const EXPLAIN = {
    kd: "KD（隨機指標）用近 9 日最高、最低價，判斷今天收盤落在區間的哪個位置。K 值反應快、D 值較平滑。K 由下往上穿過 D 叫黃金交叉，由上往下叫死亡交叉；80 以上是超買區、20 以下是超賣區。強勢股常在 80 以上鈍化，所以高檔死叉不一定是賣點。",
    macd: "MACD 用 12 日與 26 日指數移動平均的差（DIF，橘線）衡量趨勢動能，再取 DIF 的 9 日平均當訊號線（MACD，藍線）。柱狀體 OSC = DIF − MACD，柱子由負翻正代表動能轉強、由正翻負代表轉弱。MACD 反應比 KD 慢，適合確認中期方向。",
    rsi: "RSI（相對強弱指標）比較近 14 日上漲和下跌的力道，介於 0–100。70 以上代表漲勢過猛、可能過熱；30 以下代表跌勢過重、可能超跌。多頭行情中 RSI 常維持在 40–80 之間。",
    bias: "乖離率是股價偏離均線的百分比：(收盤 − 均線) ÷ 均線。乖離太大時，股價常有往均線拉回的傾向。這裡畫的是相對月線（20 日）與季線（60 日）的乖離；20 日乖離超過 ±10% 會標示為過大，實際門檻依個股波動不同。",
  };
  function renderExplain() {
    $("indExplainBody").innerHTML = `<p>${EXPLAIN[state.ind]}</p>` +
      "<p>主圖圖層：布林通道＝月線 ± 2 倍標準差；支撐壓力取近期轉折高低點；頭底型態依左側的「轉折靈敏度」找出頭與底，並標出前高、前低和突破點；我的交易是你在下方記錄的買賣點。股價未做除權息還原，除權息當天的跳空會影響判讀。</p>";
  }

  /* ============================================================== charts */
  let charts = [];
  function destroyCharts() { charts.forEach((c) => c.remove()); charts = []; }
  const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const f1 = (v) => (v == null ? "—" : v.toFixed(1));
  const f2 = (v) => (v == null ? "—" : v.toFixed(2));
  const toISO = (t) => (typeof t === "object" ? `${t.year}-${pad(t.month)}-${pad(t.day)}` : String(t));

  function drawCharts() {
    const code = state.current;
    const all = state.detailBars, a = state.detailAna;
    if (!code || !all || !a) return;
    destroyCharts();
    if (typeof LightweightCharts === "undefined") { showChartMsg("圖表程式庫載入失敗，請確認網路連線。"); return; }
    showChartMsg("");

    const ind = a.ind;
    const start = Math.max(0, all.length - state.range);
    const bars = all.slice(start);
    const sl = (arr) => arr.slice(start);
    const C = {};
    for (const k of ["panel", "fg", "muted", "line", "up", "down", "ma5", "ma20", "ma60", "accent", "buy", "sell"]) C[k] = tok("--" + k);

    const base = {
      autoSize: true,
      layout: { background: { type: "solid", color: C.panel }, textColor: C.muted, fontFamily: "JetBrains Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: C.line, style: 1 }, horzLines: { color: C.line, style: 1 } },
      rightPriceScale: { borderColor: C.line },
      timeScale: { borderColor: C.line, rightOffset: 3 },
      crosshair: { mode: 0 },
      localization: { locale: "zh-TW" },
    };
    const line = (chart, color, opt = {}) => chart.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opt });
    const toLine = (vals) => bars.map((b, i) => (vals[i] == null ? { time: b.time } : { time: b.time, value: vals[i] }));

    const main = LightweightCharts.createChart($("chartMain"), base);
    const candle = main.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down });
    candle.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });
    const vol = main.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vol.setData(bars.map((b, i) => ({ time: b.time, value: b.volume, color: (b.close >= (i ? bars[i - 1].close : b.open) ? C.up : C.down) + "66" })));

    if (state.ov.ma) {
      line(main, C.ma5).setData(toLine(sl(ind.ma5)));
      line(main, C.ma20).setData(toLine(sl(ind.ma20)));
      line(main, C.ma60).setData(toLine(sl(ind.ma60)));
    }
    if (state.ov.boll) {
      const bo = sl(ind.boll);
      line(main, C.accent, { lineWidth: 1, lineStyle: 2 }).setData(toLine(bo.map((x) => x.up)));
      line(main, C.accent, { lineWidth: 1, lineStyle: 2 }).setData(toLine(bo.map((x) => x.lo)));
      if (!state.ov.ma) line(main, C.ma20, { lineWidth: 1 }).setData(toLine(bo.map((x) => x.mid)));
    }
    if (state.ov.sr) {
      if (a.sr.res != null) candle.createPriceLine({ price: a.sr.res, color: C.muted, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: "壓力" });
      if (a.sr.sup != null) candle.createPriceLine({ price: a.sr.sup, color: C.muted, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: "支撐" });
    }
    // 提醒的價位線
    for (const al of state.watch.alerts[code] || []) {
      if (!al.active || (al.type !== "priceGE" && al.type !== "priceLE")) continue;
      candle.createPriceLine({ price: al.value, color: al.side === "buy" ? C.buy : C.sell, lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: `${al.side === "buy" ? "買" : "賣"}提醒` });
    }

    const markers = [];
    const inView = (i) => i >= start;
    const tAt = (i) => all[i].time;
    if (state.ov.pattern && a.pat && a.pat.higherLow) {
      const { L1, H, L2, k, status } = a.pat;
      const col = status === "break" ? C.up : C.muted;
      candle.createPriceLine({ price: H.price, color: col, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "前高" });
      candle.createPriceLine({ price: L1.price, color: C.muted, lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: "前低" });
      if (inView(L1.i)) markers.push({ time: tAt(L1.i), position: "belowBar", color: C.muted, shape: "circle", text: "底" });
      if (inView(H.i)) markers.push({ time: tAt(H.i), position: "aboveBar", color: C.muted, shape: "circle", text: "頭" });
      if (inView(L2.i)) markers.push({ time: tAt(L2.i), position: "belowBar", color: C.up, shape: "arrowUp", text: "底↑" });
      if (k >= 0 && inView(k)) markers.push({ time: tAt(k), position: "aboveBar", color: status === "fail" ? C.down : C.up, shape: "square", text: "破前高" });
    }
    if (state.ov.trades) {
      for (const t of state.trades[code] || []) {
        const bar = bars.find((b) => b.time >= t.date);
        if (!bar) continue;
        markers.push(t.side === "buy"
          ? { time: bar.time, position: "belowBar", color: C.buy, shape: "arrowUp", text: `買 ${t.price}` }
          : { time: bar.time, position: "aboveBar", color: C.sell, shape: "arrowDown", text: `賣 ${t.price}` });
      }
    }
    markers.sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : 0));
    candle.setMarkers(markers);
    main.timeScale().fitContent();

    const sub = LightweightCharts.createChart($("chartInd"), { ...base, timeScale: { ...base.timeScale, visible: false } });
    const guideLines = (series, levels) => levels.forEach((p) => series.createPriceLine({ price: p, color: C.muted, lineStyle: 2, lineWidth: 1, axisLabelVisible: false }));
    let legendFn;
    if (state.ind === "kd") {
      const kd = sl(ind.kd);
      const ks = line(sub, C.ma5); ks.setData(toLine(kd.map((x) => x.k)));
      line(sub, C.ma20).setData(toLine(kd.map((x) => x.d)));
      guideLines(ks, [80, 20]);
      legendFn = (i) => `K9 <span style="color:${C.ma5}">${f1(kd[i]?.k)}</span>　D9 <span style="color:${C.ma20}">${f1(kd[i]?.d)}</span>`;
    } else if (state.ind === "macd") {
      const m = sl(ind.macd);
      sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
        .setData(bars.map((b, i) => (m[i].osc == null ? { time: b.time } : { time: b.time, value: m[i].osc, color: (m[i].osc >= 0 ? C.up : C.down) + "aa" })));
      line(sub, C.ma5).setData(toLine(m.map((x) => x.dif)));
      line(sub, C.ma20).setData(toLine(m.map((x) => x.dea)));
      legendFn = (i) => `DIF <span style="color:${C.ma5}">${f2(m[i]?.dif)}</span>　MACD <span style="color:${C.ma20}">${f2(m[i]?.dea)}</span>　OSC ${f2(m[i]?.osc)}`;
    } else if (state.ind === "rsi") {
      const r = sl(ind.rsi);
      const s = line(sub, C.ma60); s.setData(toLine(r));
      guideLines(s, [70, 30]);
      legendFn = (i) => `RSI14 <span style="color:${C.ma60}">${f1(r[i])}</span>`;
    } else {
      const b20 = sl(ind.bias20), b60 = sl(ind.bias60);
      const s = line(sub, C.ma20); s.setData(toLine(b20));
      line(sub, C.ma60).setData(toLine(b60));
      guideLines(s, [0]);
      legendFn = (i) => `BIAS20 <span style="color:${C.ma20}">${f2(b20[i])}%</span>　BIAS60 <span style="color:${C.ma60}">${f2(b60[i])}%</span>`;
    }
    sub.timeScale().fitContent();

    let lock = false;
    const sync = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange((rg) => {
      if (lock || !rg) return;
      lock = true; to.timeScale().setVisibleLogicalRange(rg); lock = false;
    });
    sync(main, sub); sync(sub, main);

    const idxOf = new Map(bars.map((b, i) => [b.time, i]));
    const ma5 = sl(ind.ma5), ma20 = sl(ind.ma20), ma60 = sl(ind.ma60), bo = sl(ind.boll);
    const showInfo = (i) => {
      const b = bars[i];
      if (!b) return;
      const cls = dirCls(b.close - (i ? bars[i - 1].close : b.open));
      let s = `${b.time}${state.detailProv && i === bars.length - 1 ? "（盤中）" : ""}　開 <b>${b.open}</b>　高 <b>${b.high}</b>　低 <b>${b.low}</b>　收 <b class="${cls}">${b.close}</b>　量 <b>${b.volume.toLocaleString()}</b> 張`;
      if (state.ov.ma) s += `<br><span class="ma5">MA5 ${f2(ma5[i])}</span>　<span class="ma20">MA20 ${f2(ma20[i])}</span>　<span class="ma60">MA60 ${f2(ma60[i])}</span>`;
      if (state.ov.boll) s += `<br>布林 上 ${f2(bo[i].up)}　中 ${f2(bo[i].mid)}　下 ${f2(bo[i].lo)}`;
      $("ohlc").innerHTML = s;
      $("indLegend").innerHTML = legendFn(i);
    };
    const onMove = (p) => {
      const i = p && p.time != null ? idxOf.get(toISO(p.time)) : undefined;
      showInfo(i == null ? bars.length - 1 : i);
    };
    main.subscribeCrosshairMove(onMove);
    sub.subscribeCrosshairMove(onMove);
    showInfo(bars.length - 1);
    charts = [main, sub];
  }

  /* ============================================================== 自選股 */
  const saveWatch = () => ls.set("tw-watch-v1", state.watch);
  function toggleWatch(code, force) {
    const on = inWatch(code);
    const want = force == null ? !on : force;
    if (want === on) return;
    if (want) state.watch.list.push(code);
    else state.watch.list = state.watch.list.filter((c) => c !== code);
    saveWatch();
    if (state.current === code) renderStar();
    render();
    if (want) refreshRealtime();
  }

  /* ============================================================== 交易紀錄 */
  const saveTrades = () => ls.set("tw-trades-v1", state.trades);

  function position(list, close) {
    let shares = 0, cost = 0, realized = 0;
    for (const t of [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))) {
      const sh = t.qty * 1000;
      if (t.side === "buy") { shares += sh; cost += sh * t.price; }
      else {
        const avg = shares ? cost / shares : 0;
        const q = Math.min(sh, shares);
        realized += (t.price - avg) * q;
        cost -= avg * q;
        shares -= q;
      }
    }
    const avg = shares ? cost / shares : null;
    const unreal = shares && close != null ? (close - avg) * shares : 0;
    return { lots: shares / 1000, avg, cost, realized, unreal, pct: cost ? (unreal / cost) * 100 : null };
  }

  function resetTradeForm() {
    const r = rowOf(state.current);
    state.editTrade = null;
    $("tDate").value = todayStr();
    $("tSide").value = "buy";
    const q = quoteOf(state.current);
    $("tPrice").value = q ? q.price : (r && r.close) ?? "";
    $("tQty").value = 1;
    $("tNote").value = "";
    $("tSubmit").textContent = "記錄交易";
    $("tCancel").hidden = true;
    $("tradeErr").hidden = true;
  }

  function renderTrades() {
    const code = state.current;
    const list = (state.trades[code] || []).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    if (!list.length) {
      $("tradeSummary").innerHTML = "";
      $("tradeList").innerHTML = '<li><span></span><span></span><span class="tnote">還沒有交易紀錄。記錄後會在 K 線上標出買賣點。</span><span></span></li>';
      return;
    }
    const q = quoteOf(code);
    const p = position(list, q && q.price);
    $("tradeSummary").innerHTML =
      `<span>持有 <b>${p.lots}</b> 張</span>` +
      (p.avg != null ? `<span>平均成本 <b>${p2(p.avg)}</b></span><span>未實現 ${money(p.unreal)} 元${p.pct != null ? `（${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(2)}%）` : ""}</span>` : "") +
      (p.realized ? `<span>已實現 ${money(p.realized)} 元</span>` : "") +
      '<span class="small">未計手續費與證交稅</span>';
    $("tradeList").innerHTML = list.map((t) => `
      <li${state.editTrade === t.id ? ' class="editing"' : ""}>
        <span class="side ${t.side}">${t.side === "buy" ? "買" : "賣"}</span>
        <span class="mono">${t.date}　${t.price} × ${t.qty} 張</span>
        <span class="tnote">${esc(t.note || "")}</span>
        <span class="row-btns"><button type="button" class="del" data-edit-trade="${t.id}">編輯</button><button type="button" class="del" data-del="${t.id}">刪除</button></span>
      </li>`).join("");
  }

  function startEditTrade(id) {
    const t = (state.trades[state.current] || []).find((x) => x.id === id);
    if (!t) return;
    state.editTrade = id;
    $("tDate").value = t.date;
    $("tSide").value = t.side;
    $("tPrice").value = t.price;
    $("tQty").value = t.qty;
    $("tNote").value = t.note || "";
    $("tSubmit").textContent = "儲存修改";
    $("tCancel").hidden = false;
    $("tradeErr").hidden = true;
    renderTrades();
    $("tradeForm").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function submitTrade(e) {
    e.preventDefault();
    const code = state.current;
    const err = $("tradeErr");
    const date = $("tDate").value, side = $("tSide").value;
    const price = num($("tPrice").value), qty = Math.round(num($("tQty").value) || 0);
    const others = (state.trades[code] || []).filter((t) => t.id !== state.editTrade);
    let msg = "";
    if (!date) msg = "請填交易日期。";
    else if (date > todayStr()) msg = "交易日期不能是未來的日期。";
    else if (!price || price <= 0) msg = "請填正確的成交價格。";
    else if (qty <= 0) msg = "張數至少要 1 張。";
    else {
      // 檢查每個時間點的持股都不會變成負數
      const test = others.concat([{ id: state.editTrade || Date.now(), date, side, price, qty }]);
      let held = 0;
      for (const t of test.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))) {
        held += t.side === "buy" ? t.qty : -t.qty;
        if (held < 0) { msg = `${t.date} 賣出後持股會變成負數，請確認張數或日期。`; break; }
      }
    }
    err.hidden = !msg;
    err.textContent = msg;
    if (msg) return;
    const note = $("tNote").value.trim();
    if (state.editTrade) {
      const t = (state.trades[code] || []).find((x) => x.id === state.editTrade);
      Object.assign(t, { date, side, price, qty, note });
    } else {
      (state.trades[code] = state.trades[code] || []).push({ id: Date.now(), date, side, price, qty, note });
    }
    saveTrades();
    toggleWatch(code, true);
    resetTradeForm();
    renderTrades();
    renderAlerts();
    drawCharts();
    render();
    checkAlerts("trade");
  }

  function onTradeListClick(e) {
    const ed = e.target.closest("[data-edit-trade]");
    if (ed) { startEditTrade(+ed.dataset.editTrade); return; }
    const b = e.target.closest("[data-del]");
    if (!b || !confirmBtn(b)) return;
    const code = state.current;
    state.trades[code] = (state.trades[code] || []).filter((t) => String(t.id) !== b.dataset.del);
    if (!state.trades[code].length) delete state.trades[code];
    if (state.editTrade && String(state.editTrade) === b.dataset.del) resetTradeForm();
    saveTrades();
    renderTrades();
    drawCharts();
    render();
  }

  // 兩段式確認：第一次點變成「確定刪除？」，3 秒內再點才執行
  function confirmBtn(b) {
    if (b.classList.contains("confirm")) return true;
    b.classList.add("confirm");
    const old = b.textContent;
    b.textContent = "確定刪除？";
    setTimeout(() => { if (b.isConnected) { b.classList.remove("confirm"); b.textContent = old; } }, 3000);
    return false;
  }

  /* ============================================================== 提醒 */
  function describeAlert(a) {
    switch (a.type) {
      case "priceGE": return `股價 ≥ ${a.value} 元`;
      case "priceLE": return `股價 ≤ ${a.value} 元`;
      case "retGE": return `獲利達 ${a.value}%`;
      case "retLE": return `虧損達 ${a.value}%`;
      case "tech": return `出現「${SIGNAL_LABEL[a.tech] || a.tech}」`;
      default: return "";
    }
  }

  function buildAlertTechOptions() {
    $("aTech").innerHTML = SIGNAL_GROUPS.map(([g, list]) =>
      `<optgroup label="${g}">${list.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</optgroup>`).join("");
  }

  function syncAlertType() {
    const t = $("aType").value;
    $("aTechWrap").hidden = t !== "tech";
    $("aValWrap").hidden = t === "tech";
    $("aVal").step = t.startsWith("ret") ? "0.5" : "0.01";
    renderAlertHint();
  }

  function renderAlertHint() {
    const code = state.current;
    if (!code) return;
    const t = $("aType").value;
    const q = quoteOf(code);
    const p = position(state.trades[code] || [], q && q.price);
    let h = q ? `目前股價 ${p2(q.price)}（${q.src}）` : "";
    if (t.startsWith("ret")) {
      h += p.lots ? `；持有 ${p.lots} 張，平均成本 ${p2(p.avg)}，目前報酬率 ${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(2)}%` : "；報酬率條件要先在下方記錄買進，才會用你的持有成本計算";
    }
    if (t === "tech") h += "；技術訊號依每日收盤判斷，收盤後更新歷史資料時檢查";
    $("alertHint").textContent = h ? h + "。" : "";
  }

  function resetAlertForm() {
    state.editAlert = null;
    $("aSide").value = "buy";
    $("aType").value = "priceLE";
    $("aVal").value = "";
    $("aNote").value = "";
    $("aSubmit").textContent = "新增提醒";
    $("aCancel").hidden = true;
    $("alertErr").hidden = true;
    syncAlertType();
  }

  function renderAlerts() {
    const code = state.current;
    const list = state.watch.alerts[code] || [];
    if (!list.length) {
      $("alertList").innerHTML = '<li><span></span><span class="tnote">還沒有提醒條件。例如設定「股價 ≤ 停損價」或「出現 KD 死亡交叉」，條件成立時會跳出通知。</span><span></span></li>';
      renderAlertHint();
      return;
    }
    $("alertList").innerHTML = list.map((a) => `
      <li${state.editAlert === a.id ? ' class="editing"' : ""}>
        <span class="side ${a.side}">${a.side === "buy" ? "買" : "賣"}</span>
        <span class="a-main">
          <span>${esc(describeAlert(a))} ${a.active ? '<span class="st st-on">監控中</span>' : `<span class="st st-hit">已觸發</span>`}</span>
          <span class="a-sub">${a.active ? "" : `${esc(a.triggeredAt || "")} 觸發，當時 ${esc(String(a.triggeredPrice ?? "—"))} 元。`}${esc(a.note || "")}</span>
        </span>
        <span class="row-btns">
          ${a.active ? "" : `<button type="button" class="del" data-rearm="${a.id}">重新啟用</button>`}
          <button type="button" class="del" data-edit-alert="${a.id}">編輯</button>
          <button type="button" class="del" data-del-alert="${a.id}">刪除</button>
        </span>
      </li>`).join("");
    renderAlertHint();
  }

  function startEditAlert(id) {
    const a = (state.watch.alerts[state.current] || []).find((x) => x.id === id);
    if (!a) return;
    state.editAlert = id;
    $("aSide").value = a.side;
    $("aType").value = a.type;
    $("aVal").value = a.value ?? "";
    if (a.tech) $("aTech").value = a.tech;
    $("aNote").value = a.note || "";
    $("aSubmit").textContent = "儲存修改";
    $("aCancel").hidden = false;
    $("alertErr").hidden = true;
    syncAlertType();
    renderAlerts();
    $("alertForm").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function submitAlert(e) {
    e.preventDefault();
    ensureAudio();
    const code = state.current;
    const type = $("aType").value, side = $("aSide").value;
    const value = type === "tech" ? null : num($("aVal").value);
    const tech = type === "tech" ? $("aTech").value : null;
    let msg = "";
    if (type !== "tech" && (value == null || value <= 0)) msg = type.startsWith("ret") ? "請填百分比，例如 10 代表 10%。" : "請填提醒的價格。";
    if (type === "retLE" && value >= 100) msg = "虧損百分比要小於 100。";
    $("alertErr").hidden = !msg;
    $("alertErr").textContent = msg;
    if (msg) return;
    const note = $("aNote").value.trim();
    const list = (state.watch.alerts[code] = state.watch.alerts[code] || []);
    if (state.editAlert) {
      const a = list.find((x) => x.id === state.editAlert);
      Object.assign(a, { type, side, value, tech, note, active: true, triggeredAt: null, triggeredPrice: null });
    } else {
      list.push({ id: Date.now(), type, side, value, tech, note, active: true, createdAt: new Date().toISOString(), triggeredAt: null, triggeredPrice: null });
    }
    saveWatch();
    toggleWatch(code, true);
    resetAlertForm();
    renderAlerts();
    drawCharts();
    render();
    maybeAskNotify();
    checkAlerts("edit");
  }

  function onAlertListClick(e) {
    const code = state.current;
    const list = state.watch.alerts[code] || [];
    const ed = e.target.closest("[data-edit-alert]");
    if (ed) { startEditAlert(+ed.dataset.editAlert); return; }
    const ra = e.target.closest("[data-rearm]");
    if (ra) {
      const a = list.find((x) => String(x.id) === ra.dataset.rearm);
      if (a) { a.active = true; a.triggeredAt = null; a.triggeredPrice = null; saveWatch(); renderAlerts(); drawCharts(); render(); checkAlerts("edit"); }
      return;
    }
    const d = e.target.closest("[data-del-alert]");
    if (!d || !confirmBtn(d)) return;
    state.watch.alerts[code] = list.filter((x) => String(x.id) !== d.dataset.delAlert);
    if (!state.watch.alerts[code].length) delete state.watch.alerts[code];
    if (state.editAlert && String(state.editAlert) === d.dataset.delAlert) resetAlertForm();
    saveWatch();
    renderAlerts();
    drawCharts();
    render();
  }

  // 檢查所有提醒條件；成立的會通知一次並改成「已觸發」
  function checkAlerts(reason) {
    const hits = [];
    // 技術訊號要等當天的歷史資料補齊後才檢查，避免用舊資料誤判
    const techReady = state.mode === "demo" || (!state.syncing && reason !== "boot");
    for (const code of Object.keys(state.watch.alerts)) {
      const q = quoteOf(code);
      const ana = state.ana.get(code);
      for (const a of state.watch.alerts[code]) {
        if (!a.active) continue;
        let met = false;
        if (a.type === "priceGE") met = !!q && q.price >= a.value;
        else if (a.type === "priceLE") met = !!q && q.price <= a.value;
        else if (a.type === "retGE" || a.type === "retLE") {
          const p = position(state.trades[code] || [], q && q.price);
          if (q && p.lots > 0 && p.avg) {
            const ret = ((q.price - p.avg) / p.avg) * 100;
            met = a.type === "retGE" ? ret >= a.value : ret <= -a.value;
          }
        } else if (a.type === "tech") {
          met = techReady && !!ana && !ana.error && !ana.prov && ana.keys.has(a.tech);
        }
        if (!met) continue;
        const t = tpNow();
        a.active = false;
        a.triggeredAt = `${md(t.date)} ${t.time.slice(0, 5)}`;
        a.triggeredPrice = q ? q.price : null;
        hits.push({ code, a, q });
      }
    }
    if (!hits.length) return;
    saveWatch();
    for (const h of hits) notify(h);
    render();
    if (state.current) { renderAlerts(); drawCharts(); }
  }

  /* ============================================================== 通知 */
  let audioCtx = null;
  function ensureAudio() {
    try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch (_) {}
  }
  function beep() {
    if (!state.prefs.sound || !audioCtx) return;
    try {
      const now = audioCtx.currentTime;
      [0, 0.18].forEach((dt, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = i ? 1046 : 784;
        g.gain.setValueAtTime(0.0001, now + dt);
        g.gain.exponentialRampToValueAtTime(0.25, now + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dt + 0.16);
        o.connect(g).connect(audioCtx.destination);
        o.start(now + dt); o.stop(now + dt + 0.18);
      });
    } catch (_) {}
  }

  let titleTimer = null;
  const baseTitle = document.title;
  function flashTitle(text) {
    clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(() => { document.title = (on = !on) ? `🔔 ${text}` : baseTitle; }, 1000);
    const stop = () => { clearInterval(titleTimer); document.title = baseTitle; window.removeEventListener("focus", stop); };
    window.addEventListener("focus", stop);
    if (document.hasFocus()) setTimeout(stop, 4000);
  }

  function notify({ code, a, q }) {
    const r = rowOf(code);
    const name = r ? r.name : code;
    const title = `${a.side === "buy" ? "買進" : "賣出"}提醒｜${name} ${code}`;
    const body = `${describeAlert(a)}成立：目前 ${q ? p2(q.price) : "—"} 元（${q ? q.src : "—"}）${a.note ? `。${a.note}` : ""}`;
    state.watch.log.unshift({ id: Date.now() + Math.random(), code, title, body, time: a.triggeredAt, side: a.side, read: false });
    state.watch.log = state.watch.log.slice(0, 100);
    saveWatch();
    renderBell();
    toast(title, body, a.side, code);
    beep();
    flashTitle(title);
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        const n = new Notification(title, { body, tag: `${code}-${a.id}` });
        n.onclick = () => { window.focus(); openDetail(code); n.close(); };
      }
    } catch (_) {}
  }

  function toast(title, body, side, code) {
    const el = document.createElement("div");
    el.className = `toast ${side || ""}`;
    el.innerHTML = `<span class="tt">${esc(title)}</span><button type="button" class="tx" aria-label="關閉">×</button><span class="tb">${esc(body)}</span>` +
      (code ? `<button type="button" class="btn small to">查看個股</button>` : "");
    el.querySelector(".tx").onclick = () => el.remove();
    if (code) el.querySelector(".to").onclick = () => { el.remove(); openDetail(code); };
    $("toasts").prepend(el);
    setTimeout(() => el.remove(), 20000);
    while ($("toasts").children.length > 4) $("toasts").lastChild.remove();
  }

  function renderBell() {
    const unread = state.watch.log.filter((l) => !l.read).length;
    $("bellBadge").hidden = !unread;
    $("bellBadge").textContent = unread > 99 ? "99+" : unread;
    $("logList").innerHTML = state.watch.log.length ? state.watch.log.slice(0, 30).map((l) => `
      <li data-log="${esc(l.code)}" class="${l.read ? "" : "unread"}"><span class="lt">${esc(l.title)}</span><span class="ls">${esc(l.time || "")}　${esc(l.body)}</span></li>`).join("")
      : '<li class="empty-log">還沒有提醒。在個股頁設定買賣提醒後，條件成立會出現在這裡。</li>';
    renderNotifState();
  }

  function renderNotifState() {
    const msg = $("notifMsg"), btn = $("notifBtn");
    if (!("Notification" in window)) { btn.hidden = true; msg.textContent = "這個瀏覽器不支援桌面通知，提醒只會顯示在頁面右下角。"; return; }
    const p = Notification.permission;
    btn.hidden = p === "granted";
    msg.textContent = p === "granted" ? "桌面通知已開啟。網頁要開著（可以縮到最小）才收得到提醒。"
      : p === "denied" ? "桌面通知被封鎖了。可以點網址列左邊的圖示 → 通知 → 允許。"
      : location.protocol === "file:" ? "直接開檔案時瀏覽器可能不允許桌面通知；用 start.bat 開啟比較穩。"
      : "開啟後，就算切到其他視窗也會跳出 Windows 通知。";
  }

  async function askNotify() {
    ensureAudio();
    if (!("Notification" in window)) return renderNotifState();
    try { await Notification.requestPermission(); } catch (_) {}
    renderNotifState();
  }
  function maybeAskNotify() {
    if ("Notification" in window && Notification.permission === "default") askNotify();
  }

  /* ============================================================== 即時報價 */
  let rtTimer = null, rtAllTimer = null;
  function startRealtime() {
    clearInterval(rtTimer);
    clearInterval(rtAllTimer);
    if (state.mode !== "live") { render(); return; }
    rtTimer = setInterval(() => { if (inTradingHours()) refreshRealtime(); }, RT_INTERVAL);
    rtAllTimer = setInterval(() => { if (inTradingHours()) refreshAllRealtime(); }, RT_ALL_INTERVAL);
    if (inTradingHours()) { refreshAllRealtime(); refreshRealtime(); }
  }

  // 向證交所即時報價系統查詢一批股票（上市 tse_、上櫃 otc_）；回傳成功的批數
  async function fetchQuotes(codes) {
    let okBatches = 0, lastErr = null;
    for (let i = 0; i < codes.length; i += RT_BATCH) {
      const chs = codes.slice(i, i + RT_BATCH).map((c) => `${rowOf(c).mkt === "O" ? "otc" : "tse"}_${c}.tw`).join("|");
      try {
        const j = await getJSON(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chs)}&json=1&delay=0&_=${Date.now()}`, 15000);
        if (!j || !Array.isArray(j.msgArray)) throw new Error("即時報價格式不對");
        const first = (s) => num(String(s || "").split("_")[0]);
        for (const it of j.msgArray) {
          const price = num(it.z) ?? first(it.b) ?? first(it.a) ?? null;
          const d = String(it.d || "");
          state.rt[it.c] = {
            price, prev: num(it.y), open: num(it.o), high: num(it.h), low: num(it.l), vol: num(it.v),
            time: it.t || "", date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : todayStr(),
          };
        }
        okBatches++;
      } catch (e) { lastErr = e; console.warn("即時報價失敗", e); }
    }
    if (!okBatches && lastErr) throw lastErr;
    return okBatches;
  }

  function afterQuotes() {
    applyPrices();
    checkAlerts("realtime");
    render();
    if (state.current) {
      renderDetailPrice();
      renderAlertHint();
      renderTrades();
      if (state.detailBase) {
        const w = withProvisional(state.current, state.detailBase);
        if (w.prov || state.detailProv) {
          state.detailBars = w.bars;
          state.detailProv = w.prov;
          state.detailAna = analyze(rowOf(state.current), w.bars);
          renderSignals();
          drawCharts();
        }
      }
    }
  }

  let rtBusy = false;
  async function refreshRealtime(force) {
    if (state.mode !== "live" || rtBusy) return;
    const codes = [...new Set([...state.watch.list, ...Object.keys(state.watch.alerts)])].filter((c) => rowOf(c));
    if (state.current && !codes.includes(state.current)) codes.push(state.current);
    if (!codes.length) return;
    if (!force && !inTradingHours()) return;
    rtBusy = true;
    try {
      await fetchQuotes(codes);
      state.rtError = "";
      state.rtTime = tpNow().time;
    } catch (e) {
      state.rtError = e.message || "連線失敗";
    } finally {
      rtBusy = false;
    }
    afterQuotes();
  }

  let rtAllBusy = false;
  async function refreshAllRealtime(force) {
    if (state.mode !== "live" || rtAllBusy || !state.prefs.liveAll) return;
    if (!force && !inTradingHours()) return;
    rtAllBusy = true;
    $("liveTxt").textContent = "更新中…";
    try {
      await fetchQuotes(state.rows.map((r) => r.code));
      state.rtAllTime = tpNow().time;
      state.rtTime = state.rtAllTime;
      state.rtError = "";
    } catch (e) {
      state.rtError = e.message || "連線失敗";
    } finally {
      rtAllBusy = false;
    }
    renderLive();
    applyPrices();
    await analyzeAll();
    afterQuotes();
  }

  function renderLive() {
    const t = $("liveTxt");
    if (state.mode !== "live") { t.textContent = ""; return; }
    if (!state.prefs.liveAll) t.textContent = "";
    else if (state.rtError && !state.rtAllTime) t.textContent = "即時報價抓不到";
    else if (inTradingHours()) t.textContent = state.rtAllTime ? `每 3 分鐘更新` : "等待更新";
    else t.textContent = "已收盤";
  }

  /* ============================================================== 備份 */
  async function offerFile(name, text, type) {
    const dl = window.claude && window.claude.use ? await window.claude.use("downloads").catch(() => null) : null;
    if (dl) {
      try { await dl.save({ filename: name, data: text }); $("ioMsg").textContent = `已匯出 ${name}`; }
      catch (e) { $("ioMsg").textContent = e && e.code === "declined" ? "已取消匯出。" : "這個環境不允許下載檔案。"; }
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      $("ioMsg").textContent = `已匯出 ${name}`;
    } catch (_) {
      $("ioMsg").textContent = "這個環境不允許下載檔案。";
    }
  }
  function exportBackup() {
    const w = { list: state.watch.list, alerts: state.watch.alerts };
    offerFile(`台股選股器備份_${todayStr()}.json`, JSON.stringify({ app: "tw-screener", version: 3, trades: state.trades, watch: w }, null, 2), "application/json");
  }
  function exportCSV() {
    const nameOf = (c) => (rowOf(c) || {}).name || "";
    const lines = [["日期", "代號", "名稱", "買賣", "價格", "張數", "金額", "理由"].join(",")];
    const all = [];
    for (const [code, list] of Object.entries(state.trades)) for (const t of list) all.push({ code, ...t });
    all.sort((a, b) => (a.date < b.date ? -1 : 1));
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    for (const t of all) lines.push([t.date, t.code, q(nameOf(t.code)), t.side === "buy" ? "買進" : "賣出", t.price, t.qty, Math.round(t.price * t.qty * 1000), q(t.note || "")].join(","));
    offerFile(`台股交易紀錄_${todayStr()}.csv`, "﻿" + lines.join("\n"), "text/csv");
  }
  function importBackup(e) {
    const file = e.target.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        const tr = data.trades || (data.app ? {} : data);
        let n = 0, nw = 0, na = 0;
        for (const [code, list] of Object.entries(tr)) {
          if (!Array.isArray(list)) continue;
          const cur = state.trades[code] || [];
          const ids = new Set(cur.map((t) => String(t.id)));
          for (const t of list) if (t && t.date && t.side && t.price && !ids.has(String(t.id))) { cur.push(t); n++; }
          if (cur.length) state.trades[code] = cur;
        }
        if (data.watch) {
          for (const c of data.watch.list || []) if (!state.watch.list.includes(c)) { state.watch.list.push(c); nw++; }
          for (const [code, list] of Object.entries(data.watch.alerts || {})) {
            const cur = state.watch.alerts[code] || [];
            const ids = new Set(cur.map((a) => String(a.id)));
            for (const a of list || []) if (a && a.type && !ids.has(String(a.id))) { cur.push(a); na++; }
            if (cur.length) state.watch.alerts[code] = cur;
          }
        }
        saveTrades();
        saveWatch();
        $("ioMsg").textContent = `已匯入 ${n} 筆交易、${nw} 檔自選股、${na} 個提醒`;
        render();
        if (state.current) { renderTrades(); renderAlerts(); drawCharts(); }
      } catch (_) {
        $("ioMsg").textContent = "檔案格式不對，請選擇用「匯出備份」產生的 .json 檔。";
      }
      e.target.value = "";
    };
    rd.readAsText(file);
  }

  async function rebuildDb(btn) {
    if (!confirmBtn(btn)) return;
    btn.classList.remove("confirm");
    btn.textContent = "重建歷史資料";
    if (state.syncing) { $("ioMsg").textContent = "歷史資料正在更新，請等它完成後再重建。"; return; }
    try { await idb.clear(); } catch (_) {}
    state.days = { L: new Map(), O: new Map() };
    state.dbBars = new Map();
    state.ana.clear();
    for (const m of ["L", "O"]) state.db[m] = { status: "idle", have: 0, last: null, error: "" };
    $("ioMsg").textContent = "已清除歷史資料，重新建立中。";
    render();
    syncHistory();
  }

  /* ============================================================ 自動更新 */
  const cmpVer = (a, b) => {
    const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  };
  async function checkUpdate(manual) {
    const say = (t) => { if (manual) $("ioMsg").textContent = t; };
    if (!LOCAL_SERVER) return say("自動更新只能在用 start.bat 開啟時使用。");
    if (!manual && ls.get("tw-upd-check") === todayStr()) return;
    say("檢查更新中…");
    try {
      const res = await fetch("/update/check", { cache: "no-store" });
      if (res.status === 404) return say("目前的伺服器版本不支援自動更新，請重新下載整包。");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
      ls.set("tw-upd-check", todayStr());
      if (j.configured === false) return say("還沒設定更新來源（update.json）。");
      if (cmpVer(j.version, VERSION) > 0) { showUpdate(j); say(""); }
      else say(`已經是最新版 v${VERSION}。`);
    } catch (e) {
      say(`檢查更新失敗：${e.message}`);
    }
  }
  function showUpdate(j) {
    const notes = Array.isArray(j.notes) ? j.notes : j.notes ? [String(j.notes)] : [];
    const el = $("updBanner");
    el.innerHTML = `<div class="upd-main"><strong>有新版本 v${esc(j.version)}</strong>（目前 v${VERSION}）` +
      (notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "") + `</div>` +
      `<div class="upd-btns"><button type="button" id="updGo" class="btn primary small">立即更新</button><button type="button" id="updLater" class="btn small">稍後</button></div>`;
    el.hidden = false;
    $("updLater").onclick = () => { el.hidden = true; };
    $("updGo").onclick = applyUpdate;
  }
  async function applyUpdate() {
    const el = $("updBanner");
    $("updGo").disabled = true;
    $("updGo").textContent = "更新中…";
    try {
      const res = await fetch("/update/apply", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "HTTP " + res.status);
      const changed = Array.isArray(j.changed) ? j.changed : j.changed ? [j.changed] : [];
      if (j.restart) {
        el.innerHTML = `<div class="upd-main"><strong>已更新到 v${esc(j.version)}</strong>。這次也更新了伺服器程式：請關掉 start.bat 的視窗，再重新雙擊 start.bat 開啟。</div>`;
      } else {
        el.innerHTML = `<div class="upd-main"><strong>已更新到 v${esc(j.version)}</strong>（${changed.length} 個檔案），正在重新載入…</div>`;
        setTimeout(() => location.reload(), 1500);
      }
    } catch (e) {
      el.innerHTML = `<div class="upd-main"><strong>更新失敗</strong>：${esc(e.message)}。可以稍後再試，或請 Claude 傳整包新版。</div>`;
    }
  }

  /* ============================================================ 連線診斷 */
  let diagText = "";
  async function runDiag() {
    const out = $("diagOut");
    $("diagRun").disabled = true;
    const lines = [];
    const push = (t) => { lines.push(t); diagText = lines.join("\n"); out.textContent = diagText; out.scrollTop = out.scrollHeight; };
    let d1 = prevDay(todayStr());
    while (isWeekend(d1)) d1 = prevDay(d1);
    const [y, m, d] = d1.split("-");
    const probes = [
      ["上櫃 OpenAPI 本益比", `${TPEX}/tpex_mainboard_peratio_analysis`],
      ["上櫃 OpenAPI 收盤行情", `${TPEX}/tpex_mainboard_daily_close_quotes`],
      ["上櫃 OpenAPI EPS", `${TPEX}/mopsfin_t187ap14_O`],
      ["上櫃 OpenAPI 基本資料", `${TPEX}/mopsfin_t187ap03_O`],
      ["上櫃 每日行情 新版(/)", TPEX_DAY[0](d1).url],
      ["上櫃 每日行情 新版(8碼)", TPEX_DAY[1](d1).url],
      ["上櫃 每日行情 舊版", TPEX_DAY[2](d1).url],
      ["上櫃 本益比 新版", `https://www.tpex.org.tw/www/zh-tw/afterTrading/peQryDate?date=${y}/${m}/${d}&response=json`],
      ["上櫃 本益比 舊版", `https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&d=${+y - 1911}/${m}/${d}&o=json`],
      ["上櫃 個股月成交", `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=6488&date=${y}/${m}/01&response=json`],
      ["上市 OpenAPI 本益比", `${TWSE}/exchangeReport/BWIBBU_ALL`],
      ["上市 每日行情", `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(d1)}&type=ALLBUT0999&response=json`],
      ["即時報價", `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent("tse_2330.tw|otc_6488.tw")}&json=1&delay=0`],
    ];
    push(`台股條件選股器 v${VERSION} 連線診斷　${todayStr()} ${tpNow().time}`);
    push(`開啟方式：${location.protocol}//${location.host || "(檔案)"}　測試日期：${d1}`);
    push(`瀏覽器：${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 90)}`);
    push(`上市狀態：${state.src.L}　上櫃狀態：${state.src.O}${state.tpexErrs && state.tpexErrs.length ? "　上櫃錯誤：" + state.tpexErrs.join("；") : ""}`);
    push(`歷史資料：上市 ${state.db.L.status} ${state.db.L.have} 天、上櫃 ${state.db.O.status} ${state.db.O.have} 天${state.db.O.error ? "（" + state.db.O.error + "）" : ""}`);
    push("");
    for (const [name, url] of probes) {
      push(`■ ${name}`);
      push(`  ${url}`);
      for (const ri of ROUTES.keys()) {
        const host = new URL(url).host;
        await sleep(reserve(host));
        const t0 = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        try {
          const res = await fetch(ROUTES[ri](url), { signal: ctrl.signal });
          const text = await res.text();
          const ms = Date.now() - t0;
          let desc = "";
          try {
            const j = JSON.parse(text);
            if (Array.isArray(j)) desc = `JSON 陣列 ${j.length} 筆；欄位：${j[0] ? Object.keys(j[0]).join(",").slice(0, 300) : "（空）"}`;
            else if (j && typeof j === "object") {
              const keys = Object.keys(j);
              desc = `JSON 物件；鍵：${keys.join(",").slice(0, 200)}`;
              if (j.stat) desc += `；stat=${String(j.stat).slice(0, 60)}`;
              if (j.date || j.reportDate) desc += `；date=${j.date || j.reportDate}`;
              const t = Array.isArray(j.tables) ? j.tables.find((x) => x && Array.isArray(x.data) && x.data.length) || j.tables[0] : null;
              if (t) desc += `；tables=${j.tables.length}；表格日期=${t.date || ""}；fields=${JSON.stringify(t.fields || []).slice(0, 300)}；筆數=${(t.data || []).length}；第一筆=${JSON.stringify((t.data || [])[0] || null).slice(0, 200)}`;
              if (Array.isArray(j.aaData)) desc += `；aaData 筆數=${j.aaData.length}；第一筆=${JSON.stringify(j.aaData[0] || null).slice(0, 200)}`;
              if (Array.isArray(j.msgArray)) desc += `；msgArray=${j.msgArray.length}；${JSON.stringify(j.msgArray[0] || null).slice(0, 200)}`;
              if (Array.isArray(j.data) && j.fields) desc += `；fields=${JSON.stringify(j.fields).slice(0, 300)}；第一筆=${JSON.stringify(j.data[0] || null).slice(0, 200)}`;
            }
          } catch (_) {
            desc = `不是 JSON；內容開頭：${text.replace(/\s+/g, " ").slice(0, 160)}`;
          }
          push(`  [${ROUTE_NAMES[ri]}] HTTP ${res.status}　${ms}ms　${text.length} 字　${res.headers.get("content-type") || ""}`);
          push(`    ${desc}`);
        } catch (e) {
          push(`  [${ROUTE_NAMES[ri]}] 失敗：${e.name === "AbortError" ? "逾時" : e.message}`);
        } finally {
          clearTimeout(timer);
        }
      }
    }
    push("");
    push("測試完成。請按「複製結果」，貼到對話裡。");
    $("diagRun").disabled = false;
  }

  /* ================================================================ news */
  async function loadNews(r) {
    const list = $("news");
    const q = encodeURIComponent(r.name);
    $("newsLinks").innerHTML = [
      [`https://www.cnyes.com/twstock/${r.code}`, "鉅亨網個股頁"],
      [`https://news.cnyes.com/search?keyword=${q}`, "鉅亨網新聞搜尋"],
      [`https://tw.stock.yahoo.com/quote/${r.code}.${r.mkt === "O" ? "TWO" : "TW"}/news`, "Yahoo 股市新聞"],
      ["https://mops.twse.com.tw/mops/web/t05st01", "公開資訊觀測站 重大訊息"],
    ].map(([u, t]) => `<a href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join("");
    if (state.mode !== "live") {
      list.innerHTML = '<li class="msg">示範模式不抓新聞，請用下方連結到鉅亨網或 Yahoo 查看。</li>';
      return;
    }
    list.innerHTML = '<li class="msg">搜尋鉅亨網新聞中…</li>';
    try {
      const j = await getJSON(`https://ess.api.cnyes.com/ess/api/v1/news/keyword?q=${q}&limit=8&page=1`, 10000);
      if (state.current !== r.code) return;
      const items = (j && j.data && j.data.items) || [];
      list.innerHTML = items.length ? items.map((n) => {
        const t = new Date(n.publishAt * 1000);
        const when = `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
        return `<li><a href="https://news.cnyes.com/news/id/${encodeURIComponent(n.newsId)}" target="_blank" rel="noopener">${esc(String(n.title || "").replace(/<[^>]+>/g, ""))}</a><time>鉅亨網 · ${when}</time></li>`;
      }).join("") : '<li class="msg">鉅亨網近期沒有這檔股票的新聞。</li>';
    } catch (e) {
      if (state.current === r.code) list.innerHTML = '<li class="msg">無法連線鉅亨網新聞，請用下方連結查看。</li>';
    }
  }

  /* ================================================================ bind */
  function bindUI() {
    let t;
    for (const k of ["q", "peMin", "peMax", "epsMin", "epsMax", "yMin", "yMax"]) {
      $(k).addEventListener("input", (e) => {
        state.filters[k] = e.target.value;
        state.shown = PAGE;
        if (state.view !== "all") state.view = "all";
        clearTimeout(t);
        t = setTimeout(render, 120);
      });
    }
    for (const k of ["pivotW", "breakDays"]) {
      $(k).addEventListener("change", async (e) => {
        state.filters[k] = e.target.value;
        for (const r of state.rows) { const h = state.hist.get(r.code); if (h && !state.dbBars.has(r.code)) setAnalysis(r, h.bars); }
        await analyzeAll();
        if (state.current && state.detailBars) { state.detailAna = analyze(rowOf(state.current), state.detailBars); renderSignals(); drawCharts(); }
        checkAlerts("params");
      });
    }
    const toAll = () => { if (state.view !== "all") state.view = "all"; };
    $("mktSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-mkt]");
      if (!b) return;
      state.filters.mkt = b.dataset.mkt;
      state.shown = PAGE;
      toAll();
      buildIndustries();
      syncInputs();
      render();
    });
    $("industries").addEventListener("click", (e) => {
      const b = e.target.closest(".ind");
      if (!b) return;
      const s = state.filters.inds;
      s.has(b.dataset.ind) ? s.delete(b.dataset.ind) : s.add(b.dataset.ind);
      b.setAttribute("aria-pressed", s.has(b.dataset.ind));
      state.shown = PAGE;
      toAll();
      render();
    });
    $("techChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tech]");
      if (!b) return;
      const s = state.filters.tech;
      s.has(b.dataset.tech) ? s.delete(b.dataset.tech) : s.add(b.dataset.tech);
      b.setAttribute("aria-pressed", s.has(b.dataset.tech));
      state.shown = PAGE;
      toAll();
      render();
    });
    $("techClear").addEventListener("click", () => { state.filters.tech.clear(); syncInputs(); render(); });
    $("indClear").addEventListener("click", () => { state.filters.inds.clear(); syncInputs(); render(); });
    $("scanBtn").addEventListener("click", scan);
    $("scanStop").addEventListener("click", () => { state.scanAbort = true; });
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      const { sort, ...vals } = PRESETS[b.dataset.preset];
      Object.assign(state.filters, vals);
      state.sort = { ...sort };
      state.shown = PAGE;
      toAll();
      syncInputs();
      render();
    }));
    $("resetBtn").addEventListener("click", () => {
      const keep = { pivotW: state.filters.pivotW, breakDays: state.filters.breakDays };
      state.filters = { ...defaultFilters(), ...keep };
      state.sort = { key: "pct", dir: -1 };
      buildIndustries();
      syncInputs();
      render();
    });
    $("sortSel").addEventListener("change", (e) => {
      const [key, dir] = e.target.value.split(":");
      state.sort = { key, dir: +dir };
      render();
    });
    $("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-key]");
      if (!th) return;
      const key = th.dataset.key;
      const def = ["code", "name", "industry", "pe"].includes(key) ? 1 : -1;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: def };
      const sv = `${state.sort.key}:${state.sort.dir}`;
      if ([...$("sortSel").options].some((o) => o.value === sv)) $("sortSel").value = sv;
      render();
    });
    document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
      state.view = b.dataset.view;
      render();
      if (state.view === "watch" && inTradingHours()) refreshRealtime();
    }));
    $("quoteBtn").addEventListener("click", () => refreshRealtime(true));
    $("moreBtn").addEventListener("click", () => { state.shown += PAGE; render(); });
    const open = (e) => {
      const s = e.target.closest("[data-star]");
      if (s) { e.stopPropagation(); toggleWatch(s.dataset.star); return; }
      const tr = e.target.closest("tr[data-code]");
      if (tr) openDetail(tr.dataset.code);
    };
    $("tbody").addEventListener("click", open);
    $("tbody").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.target.closest("[data-star]")) open(e); });
    $("closeDetail").addEventListener("click", closeDetail);
    $("scrim").addEventListener("click", closeDetail);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("diagPanel").hidden) { $("diagPanel").hidden = true; $("diagScrim").hidden = true; }
      else if (!$("bellPanel").hidden) toggleBell(false);
      else if (!$("detail").hidden) closeDetail();
    });
    $("reloadBtn").addEventListener("click", boot);
    $("dStar").addEventListener("click", () => toggleWatch(state.current));

    document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      state.range = +b.dataset.range;
      document.querySelectorAll("[data-range]").forEach((x) => x.classList.toggle("on", x === b));
      drawCharts();
    }));
    document.querySelectorAll("[data-ind]").forEach((b) => b.addEventListener("click", () => {
      state.ind = b.dataset.ind;
      document.querySelectorAll("[data-ind]").forEach((x) => x.classList.toggle("on", x === b));
      renderExplain();
      drawCharts();
    }));
    document.querySelectorAll("[data-ov]").forEach((b) => {
      b.setAttribute("aria-pressed", state.ov[b.dataset.ov]);
      b.addEventListener("click", () => {
        state.ov[b.dataset.ov] = !state.ov[b.dataset.ov];
        b.setAttribute("aria-pressed", state.ov[b.dataset.ov]);
        saveFilters();
        drawCharts();
      });
    });
    $("signals").addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy]");
      if (!b) return;
      const text = b.previousElementSibling.textContent;
      const done = () => { b.textContent = "已複製"; setTimeout(() => (b.textContent = "複製"), 1500); };
      const fallback = () => {
        const rg = document.createRange();
        rg.selectNodeContents(b.previousElementSibling);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
        b.textContent = "已選取，請按 Ctrl+C";
      };
      try { navigator.clipboard.writeText(text).then(done, fallback); } catch (_) { fallback(); }
    });
    $("tradeForm").addEventListener("submit", submitTrade);
    $("tCancel").addEventListener("click", () => { resetTradeForm(); renderTrades(); });
    $("tradeList").addEventListener("click", onTradeListClick);
    $("alertForm").addEventListener("submit", submitAlert);
    $("aType").addEventListener("change", syncAlertType);
    $("aCancel").addEventListener("click", () => { resetAlertForm(); renderAlerts(); });
    $("alertList").addEventListener("click", onAlertListClick);

    // 通知中心
    const toggleBell = (show) => {
      const want = show == null ? $("bellPanel").hidden : show;
      $("bellPanel").hidden = !want;
      $("bellBtn").setAttribute("aria-expanded", want);
      if (want) renderBell();
    };
    $("bellBtn").addEventListener("click", (e) => { e.stopPropagation(); ensureAudio(); toggleBell(); });
    document.addEventListener("click", (e) => { if (!$("bellPanel").hidden && !e.target.closest(".bell-wrap")) toggleBell(false); });
    $("markRead").addEventListener("click", () => { state.watch.log.forEach((l) => (l.read = true)); saveWatch(); renderBell(); });
    $("logList").addEventListener("click", (e) => {
      const li = e.target.closest("[data-log]");
      if (!li) return;
      state.watch.log.forEach((l) => { if (l.code === li.dataset.log) l.read = true; });
      saveWatch();
      renderBell();
      toggleBell(false);
      openDetail(li.dataset.log);
    });
    $("notifBtn").addEventListener("click", askNotify);
    $("soundChk").checked = !!state.prefs.sound;
    $("soundChk").addEventListener("change", (e) => { state.prefs.sound = e.target.checked; ls.set("tw-prefs-v1", state.prefs); ensureAudio(); });
    $("testNotif").addEventListener("click", () => {
      ensureAudio();
      const title = "測試提醒｜台股條件選股器";
      const body = "通知設定正常。條件成立時會像這樣提醒你。";
      toast(title, body, "buy");
      beep();
      try { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body }); } catch (_) {}
    });
    document.addEventListener("pointerdown", ensureAudio, { once: true });

    $("liveAllChk").checked = !!state.prefs.liveAll;
    $("liveAllChk").addEventListener("change", (e) => {
      state.prefs.liveAll = e.target.checked;
      ls.set("tw-prefs-v1", state.prefs);
      if (state.prefs.liveAll) refreshAllRealtime(true);
      else { renderLive(); }
    });
    $("updBtn").addEventListener("click", () => checkUpdate(true));
    $("diagBtn").addEventListener("click", () => { $("diagPanel").hidden = false; $("diagScrim").hidden = false; if (!diagText) runDiag(); });
    const closeDiag = () => { $("diagPanel").hidden = true; $("diagScrim").hidden = true; };
    $("diagClose").addEventListener("click", closeDiag);
    $("diagScrim").addEventListener("click", closeDiag);
    $("diagRun").addEventListener("click", runDiag);
    $("diagCopy").addEventListener("click", () => {
      const b = $("diagCopy");
      const fallback = () => {
        const rg = document.createRange(); rg.selectNodeContents($("diagOut"));
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
        b.textContent = "已選取，請按 Ctrl+C";
      };
      try { navigator.clipboard.writeText(diagText).then(() => { b.textContent = "已複製"; setTimeout(() => (b.textContent = "複製結果"), 1500); }, fallback); } catch (_) { fallback(); }
    });

    $("exportBtn").addEventListener("click", exportBackup);
    $("csvBtn").addEventListener("click", exportCSV);
    $("importFile").addEventListener("change", importBackup);
    $("clearDbBtn").addEventListener("click", (e) => rebuildDb(e.currentTarget));

    // 頁面開著跨過收盤時間時，每 30 分鐘補一次最新交易日
    setInterval(() => { if (state.mode === "live" && !inTradingHours()) syncHistory(); }, 30 * 60 * 1000);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => drawCharts());
    new MutationObserver(() => drawCharts()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  /* =============================================================== start */
  $("scanMaxTxt").textContent = SCAN_MAX;
  $("verTxt").textContent = `v${VERSION}`;
  loadFilters();
  buildTechChips();
  buildAlertTechOptions();
  bindUI();
  syncInputs();
  renderBell();
  boot();
  setTimeout(() => checkUpdate(false), 3000);

  // 測試用（瀏覽器主控台可呼叫）；一般使用不需要
  window.__twScreener = { state, analyze, hlPattern, position, parseDayTable, fetchTwseDay, fetchTpexDay, checkAlerts, refreshAllRealtime, applyPrices, routeOk, VERSION };
})();
