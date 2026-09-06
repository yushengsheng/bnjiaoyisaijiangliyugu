(() => {
  "use strict";
  if (window.__volumeStatsPageHookInstalled) return;
  Object.defineProperty(window, "__volumeStatsPageHookInstalled", { value: true, configurable: false });

  const CHANNEL = "volume-stats-page";
  const COMMAND_CHANNEL = "volume-stats-extension";
  const core = window.VolumeCore;
  const originalFetch = window.fetch.bind(window);
  const XHR = window.XMLHttpRequest;
  const captures = [];
  let stopped = false;

  function post(type, data = {}) {
    window.postMessage({ channel: CHANNEL, type, ...data }, location.origin);
  }

  function serializeHeaders(headers) {
    try {
      if (!headers) return {};
      if (headers instanceof Headers) return Object.fromEntries(headers.entries());
      if (Array.isArray(headers)) return Object.fromEntries(headers);
      return { ...headers };
    } catch (_) {
      return {};
    }
  }

  function serializeBody(body) {
    if (body == null || typeof body === "string") return body || null;
    if (body instanceof URLSearchParams) return body.toString();
    try { return JSON.stringify(body); } catch (_) { return null; }
  }

  function remember(template, payload) {
    const page = core.extractPage(payload, 1, 10);
    if (!page || !page.records.length) return;
    const key = [template.method, template.url, template.body || ""].join("|");
    const existing = captures.find(item => item.key === key);
    const entry = { key, template, payload, page, capturedAt: Date.now() };
    if (existing) Object.assign(existing, entry);
    else captures.push(entry);
    captures.sort((a, b) => {
      const aScore = a.page.records.length + (a.page.total ? 100 : 0);
      const bScore = b.page.records.length + (b.page.total ? 100 : 0);
      return bScore - aScore;
    });
    if (captures.length > 40) captures.length = 40;
    post("CAPTURE_STATUS", { candidates: captureSummaries() });
  }

  function captureSummaries() {
    return captures.map((item, index) => {
      const inspection = core.inspectRequest(item.template, item.page);
      return {
        index,
        url: item.template.url,
        method: item.template.method,
        records: item.page.records.length,
        total: item.page.total,
        pageSize: inspection.pageSize,
        canPaginate: inspection.canPaginate
      };
    });
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const method = String(init.method || (request && request.method) || "GET").toUpperCase();
    let bodyPromise = Promise.resolve(serializeBody(init.body));
    if (init.body === undefined && request && !/^(GET|HEAD)$/i.test(method)) {
      try { bodyPromise = request.clone().text().then(text => text || null).catch(() => null); } catch (_) { /* unreadable body */ }
    }
    const template = {
      url: request ? request.url : String(input),
      method,
      headers: serializeHeaders(init.headers || (request && request.headers)),
      body: null
    };
    const response = await originalFetch(input, init);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") || "";
      if (/json|text|javascript/i.test(contentType)) {
        Promise.all([clone.text(), bodyPromise]).then(([text, body]) => {
          if (!text || text.length > 5_000_000) return;
          template.body = body;
          try { remember(template, JSON.parse(text)); } catch (_) { /* not JSON */ }
        }).catch(() => {});
      }
    } catch (_) { /* response cannot be cloned */ }
    return response;
  };

  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  const originalSetHeader = XHR.prototype.setRequestHeader;
  XHR.prototype.open = function patchedOpen(method, url) {
    this.__volumeStats = { method: String(method || "GET").toUpperCase(), url: new URL(String(url), location.href).toString(), headers: {}, body: null };
    return originalOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function patchedSetHeader(key, value) {
    if (this.__volumeStats) this.__volumeStats.headers[key] = value;
    return originalSetHeader.apply(this, arguments);
  };
  XHR.prototype.send = function patchedSend(body) {
    if (this.__volumeStats) {
      this.__volumeStats.body = serializeBody(body);
      this.addEventListener("load", () => {
        try {
          const payload = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          remember(this.__volumeStats, payload);
        } catch (_) { /* not JSON */ }
      }, { once: true });
    }
    return originalSend.apply(this, arguments);
  };

  function cleanHeaders(headers) {
    const result = {};
    const forbidden = /^(host|cookie|content-length|origin|referer|connection|sec-|accept-encoding)/i;
    for (const [key, value] of Object.entries(headers || {})) {
      if (!forbidden.test(key)) result[key] = value;
    }
    return result;
  }

  async function fetchJson(request, retryOptions = {}, attempt = 0) {
    const { maxRetries = 2, baseDelay = 900 } = retryOptions;
    const headers = cleanHeaders(request.headers);
    const hasContentType = Object.keys(headers).some(key => key.toLowerCase() === "content-type");
    if (!hasContentType && typeof request.body === "string" && /^[\s]*[\[{]/.test(request.body)) {
      headers["content-type"] = "application/json";
    }
    const init = {
      method: request.method,
      headers,
      credentials: "include",
      cache: "no-store"
    };
    if (!/^(GET|HEAD)$/i.test(request.method) && request.body != null) init.body = request.body;
    try {
      const response = await originalFetch(request.url, init);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter)) error.retryAfter = retryAfter * 1000;
        throw error;
      }
      const text = await response.text();
      return JSON.parse(text);
    } catch (error) {
      if (attempt >= maxRetries || stopped) throw error;
      const jitter = Math.floor(Math.random() * 250);
      const delay = error.retryAfter || baseDelay * Math.pow(2, attempt) + jitter;
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchJson(request, retryOptions, attempt + 1);
    }
  }

  function selectCapture(index) {
    if (Number.isInteger(index) && captures[index]) return captures[index];
    const pageable = captures.filter(item => core.inspectRequest(item.template, item.page).canPaginate);
    pageable.sort((a, b) => core.inspectRequest(b.template, b.page).pageSize - core.inspectRequest(a.template, a.page).pageSize);
    return pageable[0] || captures[0] || null;
  }

  async function collectApi(options) {
    stopped = false;
    const excludeTop = Math.max(0, Math.trunc(Number(options.excludeTop) || 1000));
    const concurrency = Math.min(6, Math.max(1, Math.trunc(Number(options.concurrency) || 2)));
    const selected = selectCapture(options.candidateIndex);
    if (!selected) throw new Error("还没有捕获到排行榜接口。请刷新排行榜网页，等待数据出现后再试。");
    let inspection = core.inspectRequest(selected.template, selected.page);
    if (!inspection.canPaginate) throw new Error("已识别排行榜数据，但没有识别到页码参数。请使用“页面翻页模式”。");

    const reportedTotal = selected.page.total || null;
    const originalPageSize = inspection.pageSize || selected.page.pageSize || 10;
    const desiredPageSize = Math.min(100, reportedTotal || 100);
    if (originalPageSize < desiredPageSize) {
      try {
        const probeInspection = { ...inspection, pageSize: desiredPageSize };
        const probePayload = await fetchJson(core.buildRequest(selected.template, probeInspection, 1));
        const probePage = core.extractPage(probePayload, 1, desiredPageSize);
        if (probePage && probePage.records.length === desiredPageSize) inspection = probeInspection;
      } catch (_) { /* 保持网页原始分页大小 */ }
    }

    const pageSize = inspection.pageSize;
    const totalPages = reportedTotal ? Math.ceil(reportedTotal / pageSize) : null;
    const pageRecords = new Map();
    const failedPages = new Set();
    const errorByPage = new Map();
    let completed = 0;
    let collectedCount = 0;
    let reachedEnd = false;
    post("COLLECT_START", { mode: "api", total: reportedTotal, pageSize, startPage: 1, totalPages, excludeTop });

    async function loadPage(pageNumber, retryOptions = {}, allowEmpty = false) {
      const request = core.buildRequest(selected.template, inspection, pageNumber);
      const payload = await fetchJson(request, retryOptions);
      const parsed = core.extractPage(payload, pageNumber, pageSize);
      if (!parsed || !parsed.records.length) {
        if (allowEmpty) return null;
        throw new Error("返回内容中没有排行榜记录");
      }
      if (reportedTotal && pageNumber < totalPages && parsed.records.length !== pageSize) {
        throw new Error(`记录数异常：应为 ${pageSize}，实际 ${parsed.records.length}`);
      }
      if (parsed.records.length > pageSize) throw new Error(`记录数异常：超过单页上限 ${pageSize}`);
      return parsed.records;
    }

    if (totalPages) {
      let nextPage = 1;
      async function worker() {
        while (!stopped) {
          const pageNumber = nextPage++;
          if (pageNumber > totalPages) return;
          try {
            const rows = await loadPage(pageNumber, {}, pageNumber === totalPages);
            if (rows) {
              pageRecords.set(pageNumber, rows);
              collectedCount += rows.length;
              if (pageNumber === totalPages && rows.length < pageSize) reachedEnd = true;
            } else if (pageNumber === totalPages) {
              reachedEnd = true;
            }
          } catch (error) {
            failedPages.add(pageNumber);
            errorByPage.set(pageNumber, error.message);
          }
          completed += 1;
          if (completed === 1 || completed % 5 === 0 || completed === totalPages) {
            post("COLLECT_PROGRESS", {
              mode: "api", completed, pages: totalPages, records: collectedCount,
              failed: failedPages.size, currentPage: pageNumber, phase: "collect"
            });
          }
          await new Promise(resolve => setTimeout(resolve, 220));
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      if (!stopped && failedPages.size) {
        const refillPages = Array.from(failedPages).sort((a, b) => a - b);
        for (let index = 0; index < refillPages.length && !stopped; index += 1) {
          const pageNumber = refillPages[index];
          post("COLLECT_PROGRESS", {
            mode: "api", completed, pages: totalPages, records: collectedCount,
            failed: failedPages.size, currentPage: pageNumber, phase: "refill",
            refillCompleted: index, refillTotal: refillPages.length
          });
          await new Promise(resolve => setTimeout(resolve, 1200));
          try {
            const rows = await loadPage(pageNumber, { maxRetries: 4, baseDelay: 1500 }, pageNumber === totalPages);
            if (rows) {
              pageRecords.set(pageNumber, rows);
              collectedCount += rows.length;
              if (pageNumber === totalPages && rows.length < pageSize) reachedEnd = true;
            } else if (pageNumber === totalPages) {
              reachedEnd = true;
            }
            failedPages.delete(pageNumber);
            errorByPage.delete(pageNumber);
          } catch (error) {
            errorByPage.set(pageNumber, error.message);
          }
        }
      }

      // 如果初始尾页已满，赛事期间可能新增了参与者；继续探测直到空页或不足一页。
      if (!stopped && failedPages.size === 0 && !reachedEnd) {
        const maxExtraPages = 100;
        for (let pageNumber = totalPages + 1; pageNumber <= totalPages + maxExtraPages; pageNumber += 1) {
          try {
            const rows = await loadPage(pageNumber, { maxRetries: 3, baseDelay: 1200 }, true);
            if (!rows) {
              reachedEnd = true;
              break;
            }
            pageRecords.set(pageNumber, rows);
            collectedCount += rows.length;
            completed += 1;
            post("COLLECT_PROGRESS", {
              mode: "api", completed, pages: null, records: collectedCount,
              failed: 0, currentPage: pageNumber, phase: "extend"
            });
            if (rows.length < pageSize) {
              reachedEnd = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 260));
          } catch (error) {
            failedPages.add(pageNumber);
            errorByPage.set(pageNumber, error.message);
            break;
          }
        }
      }
    } else {
      const maxPages = 5000;
      for (let pageNumber = 1; pageNumber <= maxPages && !stopped; pageNumber += 1) {
        try {
          const rows = await loadPage(pageNumber, { maxRetries: 4, baseDelay: 1200 }, true);
          if (!rows) {
            reachedEnd = true;
            break;
          }
          pageRecords.set(pageNumber, rows);
          collectedCount += rows.length;
          completed += 1;
          post("COLLECT_PROGRESS", {
            mode: "api", completed, pages: null, records: collectedCount,
            failed: 0, currentPage: pageNumber, phase: "collect"
          });
          if (rows.length < pageSize) {
            reachedEnd = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 260));
        } catch (error) {
          failedPages.add(pageNumber);
          errorByPage.set(pageNumber, error.message);
          break;
        }
      }
    }

    if (stopped) {
      post("COLLECT_STOPPED", {});
      return;
    }
    const records = Array.from(pageRecords.entries()).sort((a, b) => a[0] - b[0]).flatMap(([, rows]) => rows);
    const split = core.splitLeaderboard(records, excludeTop);
    const actualTotal = split.count;
    const errors = Array.from(errorByPage.entries()).sort((a, b) => a[0] - b[0]).map(([page, message]) => `第 ${page} 页：${message}`);
    const complete = reachedEnd && split.topCount + split.tailCount === actualTotal && failedPages.size === 0;
    post("COLLECT_DONE", {
      result: {
        ...split,
        complete,
        failedPages: failedPages.size,
        errors: errors.slice(0, 20),
        sourceUrl: location.href,
        finishedAt: new Date().toISOString(),
        mode: "api"
      }
    });
  }

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function parseDomRows() {
    const moneyPattern = /[$＄]\s*([\d,.]+(?:\.\d+)?\s*[KMBT万亿]?)/i;
    const map = new Map();
    const moneyElements = Array.from(document.querySelectorAll("body *")).filter(element => {
      if (!visible(element) || element.children.length > 3) return false;
      return moneyPattern.test((element.textContent || "").trim());
    });
    for (const moneyElement of moneyElements) {
      let row = moneyElement;
      for (let level = 0; level < 7 && row && row !== document.body; level += 1, row = row.parentElement) {
        const text = (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 500) continue;
        const money = text.match(moneyPattern);
        if (!money) continue;
        const beforeMoney = text.slice(0, money.index).trim();
        let rankMatch = beforeMoney.match(/^(\d{1,7})(?:\s|$)/);
        if (!rankMatch) {
          const moneyRect = moneyElement.getBoundingClientRect();
          const rankElement = Array.from(row.querySelectorAll("*")).filter(element => {
            const value = (element.textContent || "").trim();
            const rect = element.getBoundingClientRect();
            return element.children.length === 0 && /^\d{1,7}$/.test(value) && rect.right <= moneyRect.left;
          }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
          if (rankElement) rankMatch = [rankElement.textContent.trim(), rankElement.textContent.trim()];
        }
        if (!rankMatch) continue;
        const rank = Number(rankMatch[1]);
        const micros = core.toMicros(money[1]);
        if (!Number.isFinite(rank) || micros === null) continue;
        const name = beforeMoney.replace(new RegExp(`^${rank}\\s*`), "").trim();
        const key = `${rank}|${name}|${micros}`;
        if (!map.has(key)) map.set(key, { rank, micros, cents: Math.round(micros / 1000), name });
        break;
      }
    }
    return Array.from(map.values()).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  function findNextButton() {
    const candidates = Array.from(document.querySelectorAll("button, a, [role='button']")).filter(visible);
    const explicit = candidates.find(element => {
      const text = (element.innerText || element.textContent || "").trim().toLowerCase();
      const aria = (element.getAttribute("aria-label") || element.getAttribute("title") || "").toLowerCase();
      return /^(>|›|»|→)$/.test(text) || /next|下一页|后页/.test(`${text} ${aria}`);
    });
    if (explicit) return explicit;
    const current = document.querySelector("[aria-current='page'], .pagination .active, [class*='pagination'] [class*='active']");
    if (current && current.parentElement) {
      const siblings = Array.from(current.parentElement.children);
      const index = siblings.indexOf(current);
      if (index >= 0 && siblings[index + 1]) return siblings[index + 1];
    }
    return null;
  }

  function domFingerprint(rows) {
    return rows.map(row => `${row.rank}|${row.name}|${row.micros}`).join(";");
  }

  function waitForRows(previousFingerprint, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const rows = parseDomRows();
        if (rows.length && domFingerprint(rows) !== previousFingerprint) {
          clearInterval(timer);
          resolve(rows);
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          reject(new Error("等待下一页超时"));
        }
      }, 300);
    });
  }

  async function collectDom(options) {
    stopped = false;
    const excludeTop = Math.max(0, Math.trunc(Number(options.excludeTop) || 1000));
    const recordMap = new Map();
    let pages = 0;
    post("COLLECT_START", { mode: "dom", excludeTop });
    while (!stopped) {
      const rows = parseDomRows();
      if (!rows.length) throw new Error("当前页面没有识别到“排名 + $交易量”数据。");
      for (const row of rows) recordMap.set(`${row.rank}|${row.name}|${row.micros}`, row);
      pages += 1;
      const lastRank = rows[rows.length - 1].rank;
      const fingerprint = domFingerprint(rows);
      post("COLLECT_PROGRESS", { mode: "dom", completed: pages, pages: null, records: recordMap.size, failed: 0, currentPage: lastRank });
      const next = findNextButton();
      const disabledParent = next && next.closest(".disabled, [aria-disabled='true'], [disabled]");
      const disabled = !next || next.disabled || next.getAttribute("aria-disabled") === "true"
        || /disabled/i.test(String(next.className || "")) || Boolean(disabledParent);
      if (disabled) break;
      next.click();
      await waitForRows(fingerprint);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (stopped) return post("COLLECT_STOPPED", {});
    const records = Array.from(recordMap.values());
    const split = core.splitLeaderboard(records, excludeTop);
    post("COLLECT_DONE", {
      result: {
        ...split,
        complete: false,
        failedPages: 0,
        errors: [],
        sourceUrl: location.href,
        finishedAt: new Date().toISOString(),
        mode: "dom"
      }
    });
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || !event.data || event.data.channel !== COMMAND_CHANNEL) return;
    const { command, options } = event.data;
    if (command === "PING") post("STATUS", { candidates: captureSummaries(), url: location.href, title: document.title });
    else if (command === "CLEAR") {
      captures.length = 0;
      post("CAPTURE_STATUS", { candidates: [] });
    } else if (command === "STOP") stopped = true;
    else if (command === "START_API") collectApi(options || {}).catch(error => post("COLLECT_ERROR", { message: error.message }));
    else if (command === "START_DOM") collectDom(options || {}).catch(error => post("COLLECT_ERROR", { message: error.message }));
  });

  post("READY", { url: location.href });
})();
