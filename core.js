(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.VolumeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RANK_ALIASES = [
    "rank", "ranking", "rankno", "rankingno", "position", "place", "order",
    "sequence", "serialno", "userrank", "userranking", "ranknum", "ranknumber", "index"
  ];
  const VOLUME_ALIASES = [
    "volume", "tradingvolume", "tradevolume", "totalvolume", "totaltradevolume",
    "accumulatedtradingvolume", "cumulativetradingvolume", "turnover", "tradeamount",
    "tradingamount", "totaltradeamount", "dealamount", "transactionamount", "amount"
  ];
  const NAME_ALIASES = ["name", "nickname", "username", "displayname", "nick", "usernick"];
  const TOTAL_ALIASES = ["total", "totalcount", "recordcount", "participants", "participantcount", "totalparticipants"];
  const PAGE_ALIASES = ["page", "pageno", "pagenum", "pageindex", "current", "currentpage"];
  const SIZE_ALIASES = ["pagesize", "size", "limit", "perpage", "rows"]; 
  const OFFSET_ALIASES = ["offset", "start", "startindex"];

  function normalizeKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
  }

  function parseNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    let text = value.trim();
    if (!text) return null;
    const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
    text = text.replace(/[,$￥¥€£₽₩₹\s]/g, "").replace(/[()]/g, "");
    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    let number = Number(match[0]);
    if (!Number.isFinite(number)) return null;
    const suffix = text.slice((match.index || 0) + match[0].length).toUpperCase();
    if (suffix.startsWith("K")) number *= 1e3;
    else if (suffix.startsWith("M")) number *= 1e6;
    else if (suffix.startsWith("B")) number *= 1e9;
    else if (suffix.startsWith("T")) number *= 1e12;
    else if (suffix.startsWith("万")) number *= 1e4;
    else if (suffix.startsWith("亿")) number *= 1e8;
    return negative ? -Math.abs(number) : number;
  }

  function toCents(value) {
    const number = parseNumber(value);
    return number === null ? null : Math.round(number * 100);
  }

  function toMicros(value) {
    const number = parseNumber(value);
    return number === null ? null : Math.round(number * 100000);
  }

  function rewardPer10k(rewardAmount, volumeMicros) {
    const reward = parseNumber(rewardAmount);
    if (reward === null || reward < 0 || !Number.isFinite(volumeMicros) || volumeMicros <= 0) return null;
    return (reward / volumeMicros) * 1_000_000_000;
  }

  function getByPath(object, path) {
    let current = object;
    for (const key of path) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  }

  function flattenObject(object, prefix, depth, output) {
    if (!object || typeof object !== "object" || Array.isArray(object) || depth > 2) return output;
    for (const [key, value] of Object.entries(object)) {
      const path = prefix.concat(key);
      if (value == null) continue;
      if (typeof value === "object" && !Array.isArray(value)) flattenObject(value, path, depth + 1, output);
      else output.push({ path, key, value });
    }
    return output;
  }

  function keyScore(key, aliases, type) {
    const normalized = normalizeKey(key);
    const exact = aliases.indexOf(normalized);
    if (exact >= 0) return 100 - exact;
    if (type === "volume") {
      if (/reward|prize|bonus|pool|rate|percent/.test(normalized)) return -100;
      if (/volume|turnover/.test(normalized)) return 65;
      if (/trade|trading|deal|transaction/.test(normalized) && /amount|value|total/.test(normalized)) return 55;
    }
    if (type === "rank" && /rank|ranking|position|place/.test(normalized)) return 60;
    if (type === "name" && /name|nick/.test(normalized)) return 40;
    return -1;
  }

  function inferField(samples, aliases, type) {
    const candidates = new Map();
    for (const sample of samples.slice(0, 8)) {
      for (const item of flattenObject(sample, [], 0, [])) {
        const id = item.path.join(".");
        const score = keyScore(item.key, aliases, type);
        if (score < 0) continue;
        let valid = false;
        if (type === "name") valid = typeof item.value === "string" && item.value.trim().length > 0;
        else valid = parseNumber(item.value) !== null;
        if (!valid) continue;
        const previous = candidates.get(id) || { path: item.path, score, hits: 0 };
        previous.hits += 1;
        previous.score = Math.max(previous.score, score);
        candidates.set(id, previous);
      }
    }
    return Array.from(candidates.values()).sort((a, b) => (b.score + b.hits * 8) - (a.score + a.hits * 8))[0] || null;
  }

  function findRecordArray(payload) {
    const found = [];
    const seen = new WeakSet();
    function visit(value, path, depth) {
      if (!value || typeof value !== "object" || depth > 9) return;
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        const samples = value.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 8);
        if (samples.length) {
          const volume = inferField(samples, VOLUME_ALIASES, "volume");
          const rank = inferField(samples, RANK_ALIASES, "rank");
          const name = inferField(samples, NAME_ALIASES, "name");
          if (volume) {
            const numericVolumes = samples.filter(item => toCents(getByPath(item, volume.path)) !== null).length;
            const numericRanks = rank ? samples.filter(item => parseNumber(getByPath(item, rank.path)) !== null).length : 0;
            found.push({
              path,
              records: value,
              fields: { volume: volume.path, rank: rank && rank.path, name: name && name.path },
              score: numericVolumes * 12 + numericRanks * 7 + Math.min(value.length, 20) + (rank ? 20 : 0)
            });
          }
        }
        for (let i = 0; i < Math.min(value.length, 4); i += 1) visit(value[i], path.concat(i), depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(value)) visit(child, path.concat(key), depth + 1);
    }
    visit(payload, [], 0);
    return found.sort((a, b) => b.score - a.score)[0] || null;
  }

  function findNumericByAlias(object, aliases, maxDepth) {
    let best = null;
    const seen = new WeakSet();
    function visit(value, depth) {
      if (!value || typeof value !== "object" || depth > maxDepth || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) return;
      for (const [key, child] of Object.entries(value)) {
        const normalized = normalizeKey(key);
        const aliasIndex = aliases.indexOf(normalized);
        const number = parseNumber(child);
        if (aliasIndex >= 0 && number !== null) {
          const candidate = { key, value: number, score: 100 - aliasIndex - depth * 2 };
          if (!best || candidate.score > best.score) best = candidate;
        }
        if (child && typeof child === "object") visit(child, depth + 1);
      }
    }
    visit(object, 0);
    return best;
  }

  function extractPage(payload, fallbackPage, fallbackPageSize) {
    const candidate = findRecordArray(payload);
    if (!candidate) return null;
    const pageHint = findNumericByAlias(payload, PAGE_ALIASES, 6);
    const sizeHint = findNumericByAlias(payload, SIZE_ALIASES, 6);
    const totalHint = findNumericByAlias(payload, TOTAL_ALIASES, 7);
    const page = Math.max(1, Math.trunc(fallbackPage || (pageHint && pageHint.value) || 1));
    const pageSize = Math.max(1, Math.trunc(fallbackPageSize || (sizeHint && sizeHint.value) || candidate.records.length || 10));
    const records = [];
    candidate.records.forEach((item, index) => {
      const rawVolume = getByPath(item, candidate.fields.volume);
      const micros = toMicros(rawVolume);
      if (micros === null) return;
      const rawRank = candidate.fields.rank ? parseNumber(getByPath(item, candidate.fields.rank)) : null;
      const rank = rawRank === null ? (page - 1) * pageSize + index + 1 : Math.trunc(rawRank);
      const rawName = candidate.fields.name ? getByPath(item, candidate.fields.name) : "";
      records.push({
        rank,
        position: (page - 1) * pageSize + index + 1,
        micros,
        cents: Math.round(micros / 1000),
        name: typeof rawName === "string" ? rawName : ""
      });
    });
    return {
      records,
      total: totalHint ? Math.max(0, Math.trunc(totalHint.value)) : null,
      page,
      pageSize,
      candidatePath: candidate.path.join(".")
    };
  }

  function deepFindPagination(object) {
    const matches = [];
    const seen = new WeakSet();
    function visit(value, path, depth) {
      if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const normalized = normalizeKey(key);
        let type = null;
        if (PAGE_ALIASES.includes(normalized)) type = "page";
        else if (SIZE_ALIASES.includes(normalized)) type = "size";
        else if (OFFSET_ALIASES.includes(normalized)) type = "offset";
        if (type && parseNumber(child) !== null) matches.push({ type, path: path.concat(key), value: Number(child), key });
        if (child && typeof child === "object") visit(child, path.concat(key), depth + 1);
      }
    }
    visit(object, [], 0);
    return matches;
  }

  function setByPath(object, path, value) {
    let current = object;
    for (let i = 0; i < path.length - 1; i += 1) current = current[path[i]];
    current[path[path.length - 1]] = value;
  }

  function inspectRequest(template, responsePage) {
    let bodyType = null;
    let bodyValue = null;
    let matches = [];
    if (typeof template.body === "string" && template.body.trim()) {
      try {
        bodyValue = JSON.parse(template.body);
        bodyType = "json";
        matches = deepFindPagination(bodyValue);
      } catch (_) {
        const params = new URLSearchParams(template.body);
        if (Array.from(params.keys()).length) {
          bodyValue = params;
          bodyType = "form";
          for (const [key, value] of params.entries()) {
            const normalized = normalizeKey(key);
            const type = PAGE_ALIASES.includes(normalized) ? "page" : SIZE_ALIASES.includes(normalized) ? "size" : OFFSET_ALIASES.includes(normalized) ? "offset" : null;
            if (type && parseNumber(value) !== null) matches.push({ type, key, value: Number(value) });
          }
        }
      }
    }
    const baseUrl = typeof location !== "undefined" ? location.href : "https://localhost/";
    const url = new URL(template.url, baseUrl);
    for (const [key, value] of url.searchParams.entries()) {
      const normalized = normalizeKey(key);
      const type = PAGE_ALIASES.includes(normalized) ? "page" : SIZE_ALIASES.includes(normalized) ? "size" : OFFSET_ALIASES.includes(normalized) ? "offset" : null;
      if (type && parseNumber(value) !== null) matches.push({ type, key, value: Number(value), inUrl: true });
    }
    const pageMatch = matches.find(item => item.type === "page");
    const sizeMatch = matches.find(item => item.type === "size");
    const offsetMatch = matches.find(item => item.type === "offset");
    const pageSize = Math.max(1, Math.trunc((sizeMatch && sizeMatch.value) || (responsePage && responsePage.pageSize) || 10));
    let zeroBased = false;
    if (pageMatch && pageMatch.value === 0) zeroBased = true;
    if (pageMatch && responsePage && responsePage.records.length) {
      const firstRank = responsePage.records[0].rank;
      if (pageMatch.value * pageSize + 1 === firstRank) zeroBased = true;
    }
    return { bodyType, bodyValue, url, matches, pageMatch, sizeMatch, offsetMatch, pageSize, zeroBased, canPaginate: Boolean(pageMatch || offsetMatch) };
  }

  function buildRequest(template, inspection, pageNumber) {
    const baseUrl = typeof location !== "undefined" ? location.href : "https://localhost/";
    const url = new URL(template.url, baseUrl);
    let body = template.body;
    const pageValue = inspection.zeroBased ? pageNumber - 1 : pageNumber;
    const offsetValue = (pageNumber - 1) * inspection.pageSize;
    for (const match of inspection.matches) {
      const nextValue = match.type === "page" ? pageValue : match.type === "offset" ? offsetValue : inspection.pageSize;
      if (match.inUrl) url.searchParams.set(match.key, String(nextValue));
    }
    if (inspection.bodyType === "json") {
      const clone = JSON.parse(JSON.stringify(inspection.bodyValue));
      for (const match of inspection.matches.filter(item => !item.inUrl && item.path)) {
        const nextValue = match.type === "page" ? pageValue : match.type === "offset" ? offsetValue : inspection.pageSize;
        setByPath(clone, match.path, nextValue);
      }
      body = JSON.stringify(clone);
    } else if (inspection.bodyType === "form") {
      const params = new URLSearchParams(inspection.bodyValue.toString());
      for (const match of inspection.matches.filter(item => !item.inUrl)) {
        const nextValue = match.type === "page" ? pageValue : match.type === "offset" ? offsetValue : inspection.pageSize;
        params.set(match.key, String(nextValue));
      }
      body = params.toString();
    }
    return { url: url.toString(), method: template.method || "GET", headers: template.headers || {}, body };
  }

  function summarize(records, excludeTop) {
    const filtered = [];
    for (const record of records || []) {
      if (!record || !Number.isFinite(record.rank) || !Number.isFinite(record.cents)) continue;
      const position = Number.isFinite(record.position) ? Math.trunc(record.position) : Math.trunc(record.rank);
      if (position <= excludeTop) continue;
      const micros = Number.isFinite(record.micros) ? Math.trunc(record.micros) : Math.trunc(record.cents) * 1000;
      filtered.push({ rank: Math.trunc(record.rank), position, micros, cents: Math.round(micros / 1000), name: record.name || "" });
    }
    const sorted = filtered.sort((a, b) => a.position - b.position || a.rank - b.rank);
    let totalMicros = 0;
    let maxMicros = 0;
    let minMicros = Infinity;
    for (const item of sorted) {
      totalMicros += item.micros;
      if (item.micros > maxMicros) maxMicros = item.micros;
      if (item.micros < minMicros) minMicros = item.micros;
    }
    const totalCents = Math.round(totalMicros / 1000);
    return {
      records: sorted,
      count: sorted.length,
      totalMicros,
      totalCents,
      averageCents: sorted.length ? Math.round(totalMicros / sorted.length / 1000) : 0,
      firstRank: sorted.length ? sorted[0].rank : null,
      lastRank: sorted.length ? sorted[sorted.length - 1].rank : null,
      firstPosition: sorted.length ? sorted[0].position : null,
      lastPosition: sorted.length ? sorted[sorted.length - 1].position : null,
      maxCents: sorted.length ? Math.round(maxMicros / 1000) : 0,
      minCents: sorted.length ? Math.round(minMicros / 1000) : 0
    };
  }

  function splitLeaderboard(records, excludeTop) {
    const excluded = Math.max(0, Math.trunc(Number(excludeTop) || 0));
    const source = records || [];
    const allSummary = summarize(source, 0);
    const topSummary = summarize(source.filter(record => {
      const position = Number.isFinite(record.position) ? record.position : record.rank;
      return position <= excluded;
    }), 0);
    const tailSummary = summarize(source, excluded);
    return {
      ...allSummary,
      topCount: topSummary.count,
      topTotalMicros: topSummary.totalMicros,
      topTotalCents: topSummary.totalCents,
      tailCount: tailSummary.count,
      tailTotalMicros: tailSummary.totalMicros,
      tailTotalCents: tailSummary.totalCents,
      totalParticipants: allSummary.count,
      excluded,
      expectedCount: allSummary.count
    };
  }

  function makeHistoryEntry(result, settings = {}) {
    if (!result || !result.finishedAt) return null;
    const rewardAmount = parseNumber(settings.rewardAmount);
    const rewardToken = String(settings.rewardToken || "TOKEN").trim().toUpperCase() || "TOKEN";
    const competitionToken = String(settings.competitionToken || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    const id = settings.id || `${result.finishedAt}::${result.sourceUrl || competitionToken}`;
    return {
      id,
      competitionToken,
      sourceUrl: result.sourceUrl || "",
      excluded: Math.max(0, Math.trunc(result.excluded || 0)),
      totalParticipants: Math.max(0, Math.trunc(result.count || result.totalParticipants || 0)),
      totalMicros: Math.trunc(result.totalMicros || 0),
      totalCents: Math.trunc(result.totalCents || 0),
      topCount: Math.max(0, Math.trunc(result.topCount || 0)),
      topTotalMicros: Math.trunc(result.topTotalMicros || 0),
      topTotalCents: Math.trunc(result.topTotalCents || 0),
      tailCount: Math.max(0, Math.trunc(result.tailCount || 0)),
      tailTotalMicros: Math.trunc(result.tailTotalMicros || 0),
      tailTotalCents: Math.trunc(result.tailTotalCents || 0),
      rewardAmount,
      rewardToken,
      rewardPer10k: rewardPer10k(rewardAmount, result.tailTotalMicros),
      mode: result.mode || "api",
      finishedAt: result.finishedAt
    };
  }

  function mergeHistory(existing, additions) {
    const byId = new Map();
    for (const entry of [...(existing || []), ...(additions || [])]) {
      if (entry && entry.id) byId.set(entry.id, entry);
    }
    return Array.from(byId.values()).sort((a, b) => {
      const timeDifference = new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime();
      return timeDifference || String(b.id).localeCompare(String(a.id));
    });
  }

  function paginate(items, page, pageSize = 5) {
    const size = Math.max(1, Math.trunc(pageSize || 5));
    const totalItems = (items || []).length;
    const totalPages = Math.max(1, Math.ceil(totalItems / size));
    const currentPage = Math.min(totalPages, Math.max(1, Math.trunc(page || 1)));
    const start = (currentPage - 1) * size;
    return { items: (items || []).slice(start, start + size), currentPage, totalPages, totalItems };
  }

  return {
    parseNumber,
    toCents,
    toMicros,
    rewardPer10k,
    findRecordArray,
    extractPage,
    inspectRequest,
    buildRequest,
    summarize,
    splitLeaderboard,
    makeHistoryEntry,
    mergeHistory,
    paginate,
    normalizeKey
  };
});
