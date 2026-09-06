(() => {
  "use strict";

  const DEFAULT_URL = "https://www.icnguxncf.com/activity/trading-competition/spot-altcoin-festival-wave-ENSO1/Main-Reward";
  const core = window.VolumeCore;
  const $ = selector => document.querySelector(selector);
  const elements = {
    sourceUrl: $("#sourceUrl"), excludeTop: $("#excludeTop"), concurrency: $("#concurrency"), competitionToken: $("#competitionToken"),
    rewardAmount: $("#rewardAmount"), rewardToken: $("#rewardToken"), rewardPer10k: $("#rewardPer10k"), rewardFormula: $("#rewardFormula"),
    openButton: $("#openButton"), connectButton: $("#connectButton"), startButton: $("#startButton"), domButton: $("#domButton"),
    stopButton: $("#stopButton"), exportButton: $("#exportButton"), clearButton: $("#clearButton"),
    badge: $("#connectionBadge"), capture: $("#captureStatus"), hint: $("#hint"), rankPreview: $("#rankPreview"),
    totalVolume: $("#totalVolume"), participantCount: $("#participantCount"), participantDetail: $("#participantDetail"),
    averageVolume: $("#averageVolume"), rankRange: $("#rankRange"), historyList: $("#historyList"),
    historyCount: $("#historyCount"), historyPagination: $("#historyPagination"), historyPrev: $("#historyPrev"),
    historyNext: $("#historyNext"), historyPageInfo: $("#historyPageInfo"),
    progressTitle: $("#progressTitle"), progressPercent: $("#progressPercent"), progressBar: $("#progressBar"),
    progressPages: $("#progressPages"), progressRecords: $("#progressRecords"), progressFailed: $("#progressFailed"),
    completeLabel: $("#completeLabel"), errors: $("#errors")
  };

  let targetTabId = null;
  let candidates = [];
  let currentResult = null;
  let running = false;
  let historyRecords = [];
  let historyPage = 1;
  const HISTORY_PAGE_SIZE = 5;
  const TARGET_SCRIPT_IDS = ["volume-target-main", "volume-target-bridge"];
  let activeScriptOrigin = "";
  let registrationQueue = Promise.resolve();

  function setHint(text, error = false) {
    elements.hint.textContent = text;
    elements.hint.classList.toggle("error", error);
  }

  function setConnected(connected, text) {
    elements.badge.classList.toggle("connected", connected);
    elements.badge.innerHTML = `<span></span>${text || (connected ? "已连接" : "未连接")}`;
    elements.domButton.disabled = !connected || running;
    elements.startButton.disabled = !connected || !candidates.some(item => item.canPaginate) || running;
  }

  function setRunning(value) {
    running = value;
    elements.openButton.disabled = value;
    elements.connectButton.disabled = value;
    elements.startButton.disabled = value || !targetTabId || !candidates.some(item => item.canPaginate);
    elements.domButton.disabled = value || !targetTabId;
    elements.stopButton.disabled = !value;
  }

  function money(cents) {
    if (!Number.isFinite(cents)) return "$—";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  }

  function integer(value) {
    return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "—";
  }

  function tokenName() {
    return elements.rewardToken.value.trim().toUpperCase() || "TOKEN";
  }

  function tokenAmount(value) {
    if (!Number.isFinite(value)) return "—";
    if (value !== 0 && Math.abs(value) < 0.00000001) return value.toExponential(4);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
  }

  function renderReward() {
    const token = tokenName();
    const reward = core.parseNumber(elements.rewardAmount.value);
    const per10k = core.rewardPer10k(reward, currentResult && currentResult.tailTotalMicros);
    elements.rewardPer10k.textContent = `${tokenAmount(per10k)} ${token}`;
    if (!currentResult) {
      elements.rewardFormula.textContent = "完成排行榜统计后自动计算";
    } else if (reward === null || reward < 0) {
      elements.rewardFormula.textContent = "请输入有效的 N+1 名起奖励池数量";
    } else if (per10k === null) {
      elements.rewardFormula.textContent = "N+1 名起交易额为 0，暂时无法计算";
    } else {
      elements.rewardFormula.textContent = `${tokenAmount(reward)} ${token} ÷（${money(currentResult.tailTotalCents)} ÷ 10,000 U）`;
    }
  }

  function competitionName() {
    return elements.competitionToken.value.trim().toUpperCase() || "UNKNOWN";
  }

  function inferCompetitionToken(url) {
    try {
      const path = decodeURIComponent(new URL(url).pathname);
      const waveMatch = path.match(/wave-([a-z0-9_-]+)/i);
      if (waveMatch) return waveMatch[1].replace(/\d+$/, "").toUpperCase();
      const segment = path.split("/").filter(Boolean).find(part => /[a-z]/i.test(part) && /reward|competition/i.test(path) && !/main|reward|competition|trading|spot|activity/i.test(part));
      return segment ? segment.replace(/\d+$/, "").toUpperCase() : "";
    } catch (_) {
      return "";
    }
  }

  function saveRewardSettings() {
    chrome.storage.local.set({
      competitionToken: competitionName(),
      tailRewardAmount: elements.rewardAmount.value.trim(),
      tailRewardToken: tokenName()
    }).catch(() => {});
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
    })[character]);
  }

  function renderHistory() {
    const page = core.paginate(historyRecords, historyPage, HISTORY_PAGE_SIZE);
    historyPage = page.currentPage;
    elements.historyCount.textContent = `${integer(page.totalItems)} 条记录`;
    elements.historyPagination.classList.toggle("hidden", page.totalItems <= HISTORY_PAGE_SIZE);
    elements.historyPageInfo.textContent = `第 ${page.currentPage} / ${page.totalPages} 页`;
    elements.historyPrev.disabled = page.currentPage <= 1;
    elements.historyNext.disabled = page.currentPage >= page.totalPages;

    if (!page.items.length) {
      elements.historyList.innerHTML = '<div class="history-empty">完成一次统计后，摘要会永久保存在这里。</div>';
      return;
    }

    elements.historyList.innerHTML = page.items.map(entry => {
      const rewardText = Number.isFinite(entry.rewardPer10k)
        ? `${tokenAmount(entry.rewardPer10k)} ${escapeHtml(entry.rewardToken)}`
        : `— ${escapeHtml(entry.rewardToken)}`;
      const finished = new Date(entry.finishedAt).toLocaleString("zh-CN", { hour12: false });
      return `
        <article class="history-card">
          <div class="history-card-head">
            <div><strong class="coin-tag">${escapeHtml(entry.competitionToken)}</strong><span>${escapeHtml(finished)}</span></div>
            <button class="history-delete" data-history-id="${escapeHtml(entry.id)}" title="永久删除这条记录">删除</button>
          </div>
          <div class="history-metrics">
            <div><span>全榜人数 / 交易量</span><strong>${integer(entry.totalParticipants)} 人</strong><small>${money(entry.totalCents)}</small></div>
            <div><span>前 ${integer(entry.excluded)} 名交易量</span><strong>${money(entry.topTotalCents)}</strong><small>${integer(entry.topCount)} 人</small></div>
            <div><span>后段人数 / 交易量</span><strong>${integer(entry.tailCount)} 人</strong><small>${money(entry.tailTotalCents)}</small></div>
            <div><span>每交易 10,000 U 预计奖励</span><strong class="reward-value">${rewardText}</strong><small>奖励池 ${tokenAmount(entry.rewardAmount)} ${escapeHtml(entry.rewardToken)}</small></div>
            <div><span>完成时间</span><strong>${escapeHtml(finished)}</strong><small>${entry.mode === "api" ? "接口直采" : "页面翻页"}</small></div>
          </div>
        </article>`;
    }).join("");
  }

  async function addHistoryRecord(result) {
    const entry = core.makeHistoryEntry(result, {
      competitionToken: competitionName(),
      rewardAmount: elements.rewardAmount.value,
      rewardToken: tokenName()
    });
    if (!entry) return;
    const stored = await chrome.storage.local.get("summaryHistoryV1");
    historyRecords = core.mergeHistory(stored.summaryHistoryV1 || [], [entry]);
    await chrome.storage.local.set({ summaryHistoryV1: historyRecords });
    historyPage = 1;
    renderHistory();
  }

  async function deleteHistoryRecord(id) {
    const entry = historyRecords.find(item => item.id === id);
    if (!entry) return;
    if (!confirm(`确定永久删除 ${entry.competitionToken} 的这条统计记录吗？`)) return;
    historyRecords = historyRecords.filter(item => item.id !== id);
    await chrome.storage.local.set({ summaryHistoryV1: historyRecords });
    renderHistory();
  }

  async function loadHistory(stored) {
    historyRecords = core.mergeHistory(stored.summaryHistoryV1 || [], []);
    if (!stored.historyMigratedV1 && stored.latestResult) {
      const migrated = core.makeHistoryEntry(stored.latestResult, {
        competitionToken: stored.competitionToken || inferCompetitionToken(stored.latestResult.sourceUrl) || "UNKNOWN",
        rewardAmount: stored.tailRewardAmount ?? "80",
        rewardToken: stored.tailRewardToken || "BNB"
      });
      historyRecords = core.mergeHistory(historyRecords, migrated ? [migrated] : []);
      await chrome.storage.local.set({ summaryHistoryV1: historyRecords, historyMigratedV1: true });
    } else if (!stored.historyMigratedV1) {
      await chrome.storage.local.set({ historyMigratedV1: true });
    }
    renderHistory();
  }

  function activityPathKey(url) {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean).filter(part => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(part));
      return parts.slice(-3).join("/").toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function tabConnectionScore(tab, wantedUrl) {
    let score = 0;
    try {
      const current = new URL(tab.url || "");
      const wanted = new URL(wantedUrl || "");
      const currentKey = activityPathKey(current.href);
      const wantedKey = activityPathKey(wanted.href);
      if (wantedKey && currentKey === wantedKey) score += 4000;
      if (/trading-competition|leaderboard|main-reward/i.test(`${current.pathname}${current.search}`)) score += 2000;
      if (current.hostname === wanted.hostname) score += 1000;
    } catch (_) { /* invalid candidate URL */ }
    if (tab.active) score += 500;
    score += Math.min(499, Math.max(0, ((tab.lastAccessed || 0) / 1_000_000_000_000)));
    return score;
  }

  function scriptMatchPattern(url) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("只支持 HTTP 或 HTTPS 排行榜网址。");
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  function registerTargetScripts(url) {
    const origin = new URL(url).origin;
    if (origin === activeScriptOrigin) return registrationQueue;
    registrationQueue = registrationQueue.then(async () => {
      if (origin === activeScriptOrigin) return;
      await chrome.scripting.unregisterContentScripts({ ids: TARGET_SCRIPT_IDS }).catch(() => {});
      await chrome.scripting.registerContentScripts([
        {
          id: TARGET_SCRIPT_IDS[0], matches: [scriptMatchPattern(url)],
          js: ["core.js", "page-hook.js"], runAt: "document_start", world: "MAIN", persistAcrossSessions: false
        },
        {
          id: TARGET_SCRIPT_IDS[1], matches: [scriptMatchPattern(url)],
          js: ["bridge.js"], runAt: "document_start", persistAcrossSessions: false
        }
      ]);
      activeScriptOrigin = origin;
    });
    return registrationQueue;
  }

  async function prepareTargetTab(tabId, url, reload = true) {
    targetTabId = tabId;
    await registerTargetScripts(url);
    if (reload) await chrome.tabs.reload(tabId, { bypassCache: false });
  }

  async function deactivateRegisteredScripts() {
    await chrome.scripting.unregisterContentScripts({ ids: TARGET_SCRIPT_IDS }).catch(() => {});
    activeScriptOrigin = "";
  }

  async function sendCommand(command, options = {}) {
    if (!targetTabId) throw new Error("请先连接排行榜网页。");
    try {
      return await chrome.tabs.sendMessage(targetTabId, { channel: "collector-command", command, options });
    } catch (_) {
      let tabStillExists = true;
      try { await chrome.tabs.get(targetTabId); } catch (_) { tabStillExists = false; }
      if (tabStillExists) throw new Error("排行榜网页仍在加载，请稍候。");
      targetTabId = null;
      candidates = [];
      deactivateRegisteredScripts();
      setConnected(false);
      throw new Error("连接已断开，请重新打开排行榜网页。");
    }
  }

  function updateCandidates(next) {
    candidates = Array.isArray(next) ? next : [];
    const pageable = candidates.filter(item => item.canPaginate);
    if (pageable.length) {
      const best = pageable[0];
      elements.capture.textContent = `已识别 · ${best.pageSize || "?"} 条/页${best.total ? ` · 共 ${integer(best.total)} 人` : ""}`;
      elements.capture.classList.add("ready");
      setHint("接口已就绪。点击“开始自动统计”，工具会获取全榜并自动拆分三组结果。", false);
    } else if (candidates.length) {
      elements.capture.textContent = "识别到数据，未找到页码";
      elements.capture.classList.remove("ready");
      setHint("可使用“页面翻页模式”。请先在排行榜中手动切到第 1 页，再开始。", false);
    } else {
      elements.capture.textContent = "等待排行榜数据";
      elements.capture.classList.remove("ready");
      setHint("请让排行榜页面完整加载；若已加载，刷新一次页面即可捕获数据接口。", false);
    }
    setConnected(Boolean(targetTabId), targetTabId ? "已连接 Brave" : "未连接");
  }

  async function pingTarget() {
    if (!targetTabId || running) return;
    try { await sendCommand("PING"); } catch (_) { /* status already updated */ }
  }

  async function findExistingTarget() {
    const url = elements.sourceUrl.value.trim();
    if (!url) return;
    let wanted;
    try { wanted = new URL(url); } catch (_) { return; }
    const pathKey = activityPathKey(url);
    const tabs = (await chrome.tabs.query({})).filter(tab => /^https?:/i.test(tab.url || ""));
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const match = tabs.find(tab => pathKey && activityPathKey(tab.url) === pathKey) || tabs.find(tab => {
      try {
        const current = new URL(tab.url);
        return current.origin === wanted.origin && current.pathname === wanted.pathname;
      } catch (_) { return false; }
    });
    if (match) {
      setConnected(true, "正在激活目标网页");
      await prepareTargetTab(match.id, match.url, true);
    }
  }

  async function connectCurrentPage() {
    const wantedUrl = elements.sourceUrl.value.trim();
    const tabs = (await chrome.tabs.query({ currentWindow: true }))
      .filter(tab => /^https?:/i.test(tab.url || ""))
      .sort((a, b) => tabConnectionScore(b, wantedUrl) - tabConnectionScore(a, wantedUrl)
        || (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const tab = tabs[0];
    if (!tab) return setHint("没有找到可连接的网页，请先打开排行榜页面。", true);
    elements.sourceUrl.value = tab.url;
    const inferredToken = inferCompetitionToken(tab.url);
    if (inferredToken) elements.competitionToken.value = inferredToken;
    await chrome.storage.local.set({ sourceUrl: tab.url, competitionToken: competitionName() });
    candidates = [];
    setConnected(true, "正在连接当前网页");
    updateCandidates([]);
    try {
      await prepareTargetTab(tab.id, tab.url, true);
    } catch (error) {
      targetTabId = null;
      setConnected(false);
      setHint(`连接当前网页失败：${error.message}`, true);
    }
  }

  async function openSource() {
    const url = elements.sourceUrl.value.trim();
    try { scriptMatchPattern(url); } catch (error) { return setHint(error.message || "请输入完整有效的网址。", true); }
    const inferredToken = inferCompetitionToken(url);
    if (inferredToken) elements.competitionToken.value = inferredToken;
    await chrome.storage.local.set({ sourceUrl: url, competitionToken: competitionName() });
    const tab = await chrome.tabs.create({ url: "about:blank", active: true });
    targetTabId = tab.id;
    candidates = [];
    setConnected(true, "准备目标网页");
    updateCandidates([]);
    try {
      await registerTargetScripts(url);
      await chrome.tabs.update(tab.id, { url, active: true });
    } catch (error) {
      targetTabId = null;
      setConnected(false);
      setHint(`无法激活目标网页：${error.message}`, true);
    }
  }

  async function start(mode) {
    const excludeTop = Math.max(0, Math.trunc(Number(elements.excludeTop.value) || 0));
    const concurrency = Math.max(1, Math.trunc(Number(elements.concurrency.value) || 2));
    await chrome.storage.local.set({
      sourceUrl: elements.sourceUrl.value.trim(), excludeTop, concurrency,
      competitionToken: competitionName(), tailRewardAmount: elements.rewardAmount.value.trim(), tailRewardToken: tokenName()
    });
    setRunning(true);
    resetProgress();
    elements.progressTitle.textContent = mode === "api" ? "准备批量采集接口" : "准备读取当前页面";
    setHint(mode === "api" ? "采集中请保持排行榜标签页打开。你可以切回本页面查看进度。" : "页面翻页模式会操作排行榜的“下一页”按钮，请不要手动切页。", false);
    try {
      await sendCommand(mode === "api" ? "START_API" : "START_DOM", { excludeTop, concurrency });
    } catch (error) {
      setRunning(false);
      setHint(error.message, true);
    }
  }

  function resetProgress() {
    elements.progressPercent.textContent = "0%";
    elements.progressBar.style.width = "0%";
    elements.progressPages.textContent = "页面 — / —";
    elements.progressRecords.textContent = "记录 0 条";
    elements.progressFailed.textContent = "失败 0 页";
  }

  function updateProgress(payload) {
    const knownTotal = Number.isFinite(payload.pages);
    const percent = knownTotal && payload.pages ? Math.min(100, Math.round(payload.completed / payload.pages * 100)) : 0;
    elements.progressTitle.textContent = payload.phase === "refill"
      ? `正在补采失败页 ${integer((payload.refillCompleted || 0) + 1)} / ${integer(payload.refillTotal)}`
      : payload.phase === "extend"
        ? "检测到新增参与者，正在读取新尾页"
        : payload.mode === "api" ? "正在批量读取排行榜" : `正在翻页，已到排名 ${integer(payload.currentPage)}`;
    elements.progressPercent.textContent = knownTotal ? `${percent}%` : `${payload.completed} 页`;
    elements.progressBar.style.width = knownTotal ? `${percent}%` : `${Math.min(95, payload.completed % 100)}%`;
    elements.progressPages.textContent = knownTotal ? `页面 ${integer(payload.completed)} / ${integer(payload.pages)}` : `已翻 ${integer(payload.completed)} 页`;
    elements.progressRecords.textContent = `记录 ${integer(payload.records)} 条`;
    elements.progressFailed.textContent = `失败 ${integer(payload.failed || 0)} 页`;
  }

  function compactResult(result) {
    const { records: _records, ...summary } = result;
    return summary;
  }

  function recalculateCurrentResult(excludeTop) {
    if (!currentResult || !Array.isArray(currentResult.records) || !currentResult.records.length) return false;
    const split = core.splitLeaderboard(currentResult.records, excludeTop);
    renderResult({
      ...currentResult,
      ...split,
      complete: (currentResult.failedPages || 0) === 0 && split.topCount + split.tailCount === split.count
    });
    return true;
  }

  function renderResult(result) {
    currentResult = result;
    elements.totalVolume.textContent = money(result.totalCents);
    elements.participantCount.textContent = money(result.topTotalCents);
    elements.averageVolume.textContent = money(result.tailTotalCents);
    elements.rankRange.textContent = `第 ${integer(result.excluded + 1)} 位起 · ${integer(result.tailCount)} 人`;
    elements.participantDetail.textContent = `前 ${integer(result.excluded)} 位 · ${integer(result.topCount)} 人`;
    elements.completeLabel.textContent = result.complete ? "数据完整，人数校验通过" : "请检查人数与失败页";
    elements.completeLabel.style.color = result.complete ? "var(--green)" : "var(--yellow)";
    elements.exportButton.disabled = !result.records || !result.records.length;
    elements.errors.classList.toggle("hidden", !result.errors || !result.errors.length);
    elements.errors.textContent = result.errors && result.errors.length ? `以下页面采集失败：\n${result.errors.join("\n")}` : "";
    renderReward();
    chrome.storage.local.set({ latestResult: compactResult(result) }).catch(() => {});
  }

  function clearResult() {
    currentResult = null;
    elements.totalVolume.textContent = "$—";
    elements.participantCount.textContent = "$—";
    elements.averageVolume.textContent = "$—";
    elements.participantDetail.textContent = `前 ${integer(Number(elements.excludeTop.value) || 1000)} 位`;
    elements.rankRange.textContent = `第 ${integer((Number(elements.excludeTop.value) || 1000) + 1)} 位起`;
    elements.completeLabel.textContent = "等待统计";
    elements.errors.classList.add("hidden");
    elements.exportButton.disabled = true;
    renderReward();
    resetProgress();
    chrome.storage.local.remove("latestResult").catch(() => {});
  }

  function exportCsv() {
    if (!currentResult || !currentResult.records) return;
    const lines = ["position,rank,name,volume_usd"];
    for (const row of currentResult.records) {
      const name = `"${String(row.name || "").replace(/"/g, '""')}"`;
      const volume = Number.isFinite(row.micros) ? (row.micros / 100000).toFixed(5) : (row.cents / 100).toFixed(2);
      lines.push(`${row.position || row.rank},${row.rank},${name},${volume}`);
    }
    lines.push("");
    lines.push(`competition_token,,,${competitionName()}`);
    const precise = (micros, cents) => Number.isFinite(micros) ? (micros / 100000).toFixed(5) : (cents / 100).toFixed(2);
    lines.push(`all_total,,,${precise(currentResult.totalMicros, currentResult.totalCents)}`);
    lines.push(`top_${currentResult.excluded}_total,,,${precise(currentResult.topTotalMicros, currentResult.topTotalCents)}`);
    lines.push(`after_${currentResult.excluded}_total,,,${precise(currentResult.tailTotalMicros, currentResult.tailTotalCents)}`);
    const reward = core.parseNumber(elements.rewardAmount.value);
    const per10k = core.rewardPer10k(reward, currentResult.tailTotalMicros);
    if (reward !== null && per10k !== null) {
      lines.push(`tail_reward_pool_${tokenName()},,,${reward}`);
      lines.push(`tail_reward_per_10000u_${tokenName()},,,${per10k.toFixed(8)}`);
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `交易量统计_${currentResult.firstPosition || currentResult.firstRank || "start"}-${currentResult.lastPosition || currentResult.totalParticipants || "end"}_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.channel !== "collector" || !sender.tab) return;
    const payload = message.payload || {};
    if (!targetTabId || sender.tab.id !== targetTabId) return;

    if (payload.type === "READY") {
      setConnected(true, "已连接 Brave");
      setTimeout(pingTarget, 300);
    } else if (payload.type === "STATUS" || payload.type === "CAPTURE_STATUS") {
      updateCandidates(payload.candidates);
    } else if (payload.type === "COLLECT_START") {
      elements.progressTitle.textContent = payload.mode === "api"
        ? payload.totalPages ? `开始获取全榜 · 共 ${integer(payload.totalPages)} 页` : "开始获取全榜 · 自动检测最后一页"
        : "页面读取已开始";
    } else if (payload.type === "COLLECT_PROGRESS") {
      updateProgress(payload);
    } else if (payload.type === "COLLECT_DONE") {
      setRunning(false);
      elements.progressPercent.textContent = "100%";
      elements.progressBar.style.width = "100%";
      elements.progressTitle.textContent = payload.result.complete ? "统计完成，校验通过" : "统计完成，需要复核";
      renderResult(payload.result);
      addHistoryRecord(payload.result).catch(error => setHint(`统计完成，但历史记录保存失败：${error.message}`, true));
      setHint(payload.result.complete ? "统计完成。总人数与目标人数一致，可导出 CSV 留档。" : "统计已结束，但存在缺页或页面模式无法自动校验，请查看结果说明。", !payload.result.complete);
    } else if (payload.type === "COLLECT_ERROR") {
      setRunning(false);
      elements.progressTitle.textContent = "统计失败";
      setHint(payload.message || "采集失败，请重试。", true);
    } else if (payload.type === "COLLECT_STOPPED") {
      setRunning(false);
      elements.progressTitle.textContent = "已停止";
      setHint("统计已停止，现有临时数据未保存。", false);
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== targetTabId || !changeInfo.url || !/^https?:/i.test(changeInfo.url)) return;
    let redirectedOrigin;
    try { redirectedOrigin = new URL(changeInfo.url).origin; } catch (_) { return; }
    if (redirectedOrigin === activeScriptOrigin) return;
    setConnected(true, "检测到域名跳转，正在重新连接");
    prepareTargetTab(tabId, changeInfo.url, true).catch(error => {
      setConnected(false);
      setHint(`重定向后连接失败：${error.message}`, true);
    });
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    if (tabId !== targetTabId) return;
    targetTabId = null;
    candidates = [];
    deactivateRegisteredScripts();
    setConnected(false);
    updateCandidates([]);
  });

  elements.openButton.addEventListener("click", openSource);
  elements.connectButton.addEventListener("click", connectCurrentPage);
  elements.startButton.addEventListener("click", () => start("api"));
  elements.domButton.addEventListener("click", () => start("dom"));
  elements.stopButton.addEventListener("click", async () => {
    try { await sendCommand("STOP"); } catch (_) { /* disconnected */ }
    setRunning(false);
  });
  elements.exportButton.addEventListener("click", exportCsv);
  elements.clearButton.addEventListener("click", clearResult);
  elements.excludeTop.addEventListener("input", () => {
    const excluded = Math.max(0, Math.trunc(Number(elements.excludeTop.value) || 0));
    elements.rankPreview.textContent = integer(excluded);
    if (!currentResult) {
      elements.participantDetail.textContent = `前 ${integer(excluded)} 位`;
      elements.rankRange.textContent = `第 ${integer(excluded + 1)} 位起`;
    }
  });
  elements.excludeTop.addEventListener("change", () => {
    const excluded = Math.max(0, Math.trunc(Number(elements.excludeTop.value) || 0));
    if (recalculateCurrentResult(excluded)) setHint("已使用内存中的全榜数据完成本地重算，无需重新请求。", false);
  });
  elements.rewardAmount.addEventListener("input", () => { renderReward(); saveRewardSettings(); });
  elements.rewardToken.addEventListener("input", () => { renderReward(); saveRewardSettings(); });
  elements.rewardToken.addEventListener("blur", () => { elements.rewardToken.value = tokenName(); renderReward(); saveRewardSettings(); });
  elements.competitionToken.addEventListener("input", saveRewardSettings);
  elements.competitionToken.addEventListener("blur", () => { elements.competitionToken.value = competitionName(); saveRewardSettings(); });
  elements.historyPrev.addEventListener("click", () => { historyPage -= 1; renderHistory(); });
  elements.historyNext.addEventListener("click", () => { historyPage += 1; renderHistory(); });
  elements.historyList.addEventListener("click", event => {
    const button = event.target.closest("[data-history-id]");
    if (button) deleteHistoryRecord(button.dataset.historyId).catch(error => setHint(error.message, true));
  });
  elements.sourceUrl.addEventListener("keydown", event => { if (event.key === "Enter") openSource(); });

  async function init() {
    const stored = await chrome.storage.local.get([
      "sourceUrl", "excludeTop", "concurrency", "competitionToken", "tailRewardAmount", "tailRewardToken",
      "latestResult", "summaryHistoryV1", "historyMigratedV1"
    ]);
    elements.sourceUrl.value = stored.sourceUrl || DEFAULT_URL;
    elements.excludeTop.value = Number.isFinite(stored.excludeTop) ? stored.excludeTop : 1000;
    elements.concurrency.value = String(stored.concurrency || 2);
    elements.competitionToken.value = stored.competitionToken || inferCompetitionToken(elements.sourceUrl.value) || "ENSO";
    elements.rewardAmount.value = stored.tailRewardAmount ?? "80";
    elements.rewardToken.value = stored.tailRewardToken || "BNB";
    elements.rankPreview.textContent = integer(Number(elements.excludeTop.value));
    if (stored.latestResult) renderResult(stored.latestResult);
    else renderReward();
    await loadHistory(stored);
    await findExistingTarget();
    setInterval(pingTarget, 3500);
  }

  init().catch(error => setHint(error.message, true));
})();
