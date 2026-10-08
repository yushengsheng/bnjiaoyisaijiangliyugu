(() => {
  "use strict";

  const state = {
    campaigns: { active: [], history: [] },
    currentTab: "active",
    currentCampaignId: null,
    currentCampaign: null,
    rankingData: null,
    marketData: null,
    historyData: [],
    bnbPrice: null,
    feeRate: 0.00075,
    rebateRate: 0.485,
    sessionToken: null,
    nextRunTime: null,
    autoUpdateEnabled: true,
    detailRequestId: 0,
    marketRequestId: 0,
    detailController: null,
    detailLoading: false,
    feeTimer: null,
    noticeTimer: null,
    crawlProgressHideTimer: null
  };

  const $ = id => document.getElementById(id);
  const hasNumber = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const formatters = {
    money(value, digits = 2) {
      const number = Number(value);
      if (!hasNumber(value)) return "$—";
      return `$${number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    },
    number(value, digits = 0) {
      const number = Number(value);
      if (!hasNumber(value)) return "—";
      return number.toLocaleString("en-US", { maximumFractionDigits: digits });
    },
    token(value, digits = 8) {
      const number = Number(value);
      if (!hasNumber(value)) return "—";
      return number.toLocaleString("en-US", { maximumFractionDigits: digits });
    },
    compact(value) {
      const number = Number(value);
      if (!hasNumber(value)) return "$—";
      if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
      if (number >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
      if (number >= 1e3) return `$${(number / 1e3).toFixed(2)}K`;
      return `$${number.toFixed(2)}`;
    },
    time(value, fallback = "未知") {
      if (!value) return fallback;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : fallback;
    }
  };

  function rewardPriceFor(token) {
    const ranking = state.rankingData;
    const price = ranking?.rewardPricesUsdt?.[token]
      ?? (token === ranking?.otherRewardToken ? ranking?.rewardTokenPrice : null);
    return hasNumber(price) && Number(price) > 0 ? Number(price) : null;
  }

  function rewardStatusText(status) {
    return {
      "available": "可估算",
      "no-tail-pool": "后段奖励池待核对",
      "no-tail-users": "当前人数尚未进入后段",
      "no-tail-volume": "暂无后段交易量数据",
      "ranked-volume": "已达到排名奖励门槛，请查看阶梯奖励",
      "unknown-cutoff": "排名门槛未知，暂不估算后段奖励",
      "rank-tie": "排名边界存在并列，请核对分配规则",
      "rules-unverified": "活动规则待核对，暂不估算奖励",
      "unsupported-distribution": "后段分配方式待核对"
    }[status] || "奖励估算不可用";
  }

  function calculateRoi() {
    const ranking = state.rankingData;
    const reward = ranking?.rewardPer10kUsdtUnrounded ?? ranking?.rewardPer10kUsdt;
    if (!ranking || !hasNumber(ranking.rewardPer10k) || !hasNumber(reward)) return null;
    const best = [...(state.marketData?.markets || [])]
      .filter(pair => hasNumber(pair.totalCostPer10k) && pair.totalCostPer10k >= 0)
      .sort((a, b) => a.totalCostPer10k - b.totalCostPer10k)[0];
    if (!best) return null;
    const net = Number(reward) - best.totalCostPer10k;
    return { best, net, ratio: best.totalCostPer10k > 0 ? net / best.totalCostPer10k * 100 : null };
  }

  async function api(path, options = {}, allowSessionRetry = true) {
    const method = options.method || "GET";
    const isMutation = method !== "GET" && method !== "HEAD";
    const headers = { ...(options.headers || {}) };
    if (isMutation) {
      if (!state.sessionToken) await initializeSession();
      headers["X-EventLens-Token"] = state.sessionToken;
      if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }
    const response = await fetch(path, { ...options, method, headers, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (response.status === 403 && isMutation && allowSessionRetry && /会话令牌无效/.test(data.error || "")) {
      await initializeSession();
      return api(path, options, false);
    }
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function initializeSession() {
    const response = await fetch("/api/session", { cache: "no-store" });
    if (!response.ok) throw new Error("无法建立本地安全会话");
    const data = await response.json();
    if (!data.token) throw new Error("本地安全会话响应异常");
    state.sessionToken = data.token;
  }

  function setDetailStatus(message = "", type = "info") {
    const element = $("detailStatus");
    if (!element) return;
    if (!message) {
      element.className = "detail-status hidden";
      element.textContent = "";
      return;
    }
    element.className = `detail-status ${type}`;
    element.textContent = message;
  }

  async function loadBnbPrice() {
    try {
      const data = await api("/api/prices?symbol=BNBUSDT");
      state.bnbPrice = data.price;
      $("bnbPriceText").textContent = `BNB $${Number(data.price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      $("bnbPriceTag").classList.remove("status-error");
    } catch (_) {
      state.bnbPrice = null;
      $("bnbPriceText").textContent = "BNB 行情不可用";
      $("bnbPriceTag").classList.add("status-error");
    }
  }

  async function loadSchedulerStatus() {
    try {
      const data = await api("/api/scheduler/status");
      state.nextRunTime = data.nextRunTime || null;
      state.autoUpdateEnabled = Boolean(data.enabled);
      const toggle = $("autoUpdateToggle");
      if (toggle) toggle.checked = state.autoUpdateEnabled;
      const text = $("schedulerStatusText");
      text.textContent = data.isRunning
        ? "正在完整抓取排行榜…"
        : state.autoUpdateEnabled ? `排行榜自动更新：每 ${data.intervalMinutes} 分钟` : "排行榜自动更新：已关闭";
      text.style.color = data.isRunning ? "var(--color-orange)" : "inherit";
      const dot = $("schedulerStatusTag")?.querySelector(".pulse-dot");
      if (dot) {
        dot.style.backgroundColor = state.autoUpdateEnabled ? "var(--color-blue)" : "var(--text-muted)";
        dot.style.boxShadow = state.autoUpdateEnabled ? "0 0 8px var(--color-blue)" : "none";
      }
      return data;
    } catch (_) {
      $("schedulerStatusText").textContent = "排行榜调度状态不可用";
      return null;
    }
  }

  function renderCountdown() {
    const element = $("nextCrawlCountdown");
    if (!element) return;
    if (!state.autoUpdateEnabled) {
      element.textContent = "自动更新已关闭，可手动更新";
      return;
    }
    if (!state.nextRunTime) {
      element.textContent = "自动更新倒计时不可用";
      return;
    }
    const difference = Date.parse(state.nextRunTime) - Date.now();
    if (difference <= 0) {
      element.textContent = "正在等待自动检查…";
      return;
    }
    const minutes = Math.floor(difference / 60000);
    const seconds = Math.floor((difference % 60000) / 1000);
    element.textContent = `下次自动检查：${minutes}分${String(seconds).padStart(2, "0")}秒`;
  }

  function clearDetailData() {
    state.rankingData = null;
    state.marketData = null;
    state.historyData = [];
    $("rankingUpdateTime").textContent = "等待排行榜数据";
    $("marketUpdatedTime").textContent = "正在读取行情…";
    $("roiFormulaNote").textContent = "等待完整排行榜和行情";
    $("summaryTotalVolume").textContent = "$—";
    $("summaryParticipantsCount").textContent = "等待排行榜数据";
    $("summaryCutoffVolume").textContent = "$—";
    $("summaryCutoffDetail").textContent = "等待排行榜数据";
    $("marketGrid").innerHTML = '<div class="empty-state">正在读取盘口数据…</div>';
    $("tierGrid").innerHTML = '<div class="empty-state">正在读取奖励结构…</div>';
    $("trendGrid").innerHTML = '<div class="empty-state">正在读取历史快照…</div>';
    for (const id of ["statTotalUsers", "statTotalVolume", "statTopUsers", "statTopVolume", "statTailUsers", "statTailVolume", "rewardPer1kToken", "rewardPer1kUsdt", "rewardPer10kToken", "rewardPer10kUsdt", "netProfitPer10k"]) {
      $(id).textContent = "—";
    }
  }

  function rememberSelection(id, updateUrl) {
    try {
      localStorage.setItem("eventlens_active_campaign", id);
      if (updateUrl && location.hash !== `#${id}`) history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    } catch (_) {}
  }

  async function selectCampaign(id, updateUrl = true) {
    const all = [...state.campaigns.active, ...state.campaigns.history];
    const campaign = all.find(item => item.id === id);
    if (!campaign) return;
    state.detailController?.abort();
    state.detailRequestId++;
    state.marketRequestId++;
    state.detailLoading = false;
    state.currentCampaignId = campaign.id;
    state.currentCampaign = campaign;
    state.currentTab = campaign.status === "history" ? "history" : "active";
    $("tabActive").classList.toggle("active", state.currentTab === "active");
    $("tabHistory").classList.toggle("active", state.currentTab === "history");
    rememberSelection(campaign.id, updateUrl);
    renderCampaignButtons();
    renderCampaignHeader();
    clearDetailData();
    renderSummaryCards();
    await loadCurrentCampaignDetails();
  }

  async function loadCampaigns() {
    const data = await api("/api/campaigns");
    state.campaigns = data.groups || { active: [], history: [] };
    $("countActive").textContent = state.campaigns.active.length;
    $("countHistory").textContent = state.campaigns.history.length;
    const all = [...state.campaigns.active, ...state.campaigns.history];
    let hashId = null;
    let savedId = null;
    try {
      hashId = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
      savedId = localStorage.getItem("eventlens_active_campaign");
    } catch (_) {}
    const targetId = [hashId, savedId, state.currentCampaignId].find(id => id && all.some(item => item.id === id))
      || state.campaigns.active[0]?.id
      || all[0]?.id
      || null;
    if (!targetId) {
      state.currentCampaign = null;
      state.currentCampaignId = null;
      renderCampaignButtons();
      setDetailStatus("当前没有活动，可通过上方链接添加。", "info");
    }
    return targetId;
  }

  async function loadCurrentCampaignDetails({ force = false } = {}) {
    const campaign = state.currentCampaign;
    if (!campaign || (state.detailLoading && !force)) return;
    if (force) {
      state.detailController?.abort();
      state.detailRequestId++;
      state.marketRequestId++;
      state.detailLoading = false;
    }
    const requestId = ++state.detailRequestId;
    const marketRequestId = ++state.marketRequestId;
    state.detailController?.abort();
    const controller = new AbortController();
    state.detailController = controller;
    state.detailLoading = true;
    setDetailStatus("正在同步本地排行榜快照与实时行情…", "loading");

    try {
      const campaignId = encodeURIComponent(campaign.id);
      const results = await Promise.allSettled([
        api(`/api/binance/ranking?campaignId=${campaignId}`, { signal: controller.signal }),
        api(`/api/binance/market?campaignId=${campaignId}&feeRate=${state.feeRate}&rebateRate=${state.rebateRate}`, { signal: controller.signal }),
        api(`/api/ranking/history?campaignId=${campaignId}&limit=50`, { signal: controller.signal })
      ]);
      if (requestId !== state.detailRequestId || campaign.id !== state.currentCampaignId) return;

      const errors = [];
      if (results[0].status === "fulfilled") state.rankingData = results[0].value;
      else errors.push(`排行榜：${results[0].reason.message}`);
      if (results[1].status === "fulfilled" && marketRequestId === state.marketRequestId) state.marketData = results[1].value;
      else if (results[1].status === "rejected") errors.push(`行情：${results[1].reason.message}`);
      if (results[2].status === "fulfilled") state.historyData = results[2].value.entries || [];
      else errors.push(`历史：${results[2].reason.message}`);

      renderSummaryCards();
      renderMarketAnalysis();
      renderRankingAndRoi();
      renderTiers();
      renderHistory();
      if (errors.length) setDetailStatus(errors.join("；"), "warning");
      else if (state.rankingData?.dataStatus !== "available") setDetailStatus("活动规则已载入，但还没有成功的排行榜快照。", "warning");
      else setDetailStatus("", "info");
    } catch (error) {
      if (error.name !== "AbortError" && requestId === state.detailRequestId) setDetailStatus(`加载失败：${error.message}`, "error");
    } finally {
      if (requestId === state.detailRequestId) state.detailLoading = false;
    }
  }

  async function reloadMarketOnly() {
    const campaign = state.currentCampaign;
    if (!campaign) return;
    const requestId = ++state.marketRequestId;
    try {
      const marketData = await api(`/api/binance/market?campaignId=${encodeURIComponent(campaign.id)}&feeRate=${state.feeRate}&rebateRate=${state.rebateRate}`);
      if (requestId !== state.marketRequestId || campaign.id !== state.currentCampaignId) return;
      state.marketData = marketData;
      renderMarketAnalysis();
      renderRankingAndRoi();
    } catch (error) {
      if (requestId !== state.marketRequestId || campaign.id !== state.currentCampaignId) return;
      state.marketData = null;
      renderMarketAnalysis();
      renderRankingAndRoi();
      setDetailStatus(`行情参数更新失败：${error.message}`, "warning");
    }
  }

  function renderCampaignButtons() {
    const container = $("campaignList");
    const list = state.currentTab === "active" ? state.campaigns.active : state.campaigns.history;
    if (!list.length) {
      container.innerHTML = `<div class="empty-state">${state.currentTab === "active" ? "暂无进行中的活动" : "暂无历史活动"}</div>`;
      return;
    }
    container.innerHTML = list.map(item => {
      const statusText = item.needsReview ? "[待核对]" : item.status === "history" ? "[已结束]" : "";
      const title = String(item.name || "").trim() || `${item.token || "未知"} 交易活动`;
      return `<button class="campaign-button ${item.id === state.currentCampaignId ? "selected" : ""}" data-campaign-id="${escapeHtml(item.id)}">
        <span class="campaign-token">${escapeHtml(item.token || "—")}</span>
        <span class="campaign-meta"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(item.market || "现货")}交易活动 ${statusText ? `<em>${escapeHtml(statusText)}</em>` : ""}</small></span>
      </button>`;
    }).join("");
    container.querySelectorAll("[data-campaign-id]").forEach(button => {
      button.addEventListener("click", () => selectCampaign(button.dataset.campaignId, true));
    });
  }

  function renderCampaignHeader() {
    const campaign = state.currentCampaign;
    if (!campaign) return;
    $("currentCampaignName").textContent = campaign.name;
    const badge = $("currentStatusBadge");
    const labels = { active: "进行中", upcoming: "即将开始", history: "已结束", "needs-review": "规则待核对" };
    badge.textContent = labels[campaign.status] || campaign.status;
    badge.className = `status-badge ${campaign.status === "active" ? "active-status" : campaign.status === "needs-review" ? "review-status" : "history-status"}`;
    const link = $("currentLandingLink");
    if (campaign.landingUrl) {
      link.href = campaign.landingUrl;
      link.classList.remove("hidden");
    } else link.classList.add("hidden");
  }

  function parsePool(campaign) {
    if (Number.isFinite(Number(campaign.rewardPoolAmount)) && campaign.rewardPoolAmount > 0) {
      return { amount: Number(campaign.rewardPoolAmount), token: campaign.rewardToken };
    }
    const match = String(campaign.rewardPool || "").match(/([\d,.]+)\s*([A-Z0-9]+)/i);
    return match ? { amount: Number(match[1].replace(/,/g, "")), token: match[2].toUpperCase() } : null;
  }

  function renderSummaryCards() {
    const campaign = state.currentCampaign;
    const ranking = state.rankingData;
    if (!campaign) return;
    const tailCap = ranking ? ranking.otherRewardCap : campaign.otherReward?.capPerUser;
    const tailToken = ranking?.otherRewardToken || campaign.otherReward?.token || campaign.rewardToken || "奖励币";
    const hasTailCap = hasNumber(tailCap) && Number(tailCap) >= 0;
    const tailPrice = rewardPriceFor(tailToken);
    $("statTailCap").textContent = hasTailCap
      ? `${formatters.token(tailCap)} ${tailToken}`
      : campaign.otherReward && !campaign.needsReview ? "未设置上限" : "待核对";
    $("statTailCapUsdt").textContent = hasTailCap
      ? tailPrice === null ? "奖励币价格不可用"
        : `≈ ${(Number(tailCap) * tailPrice).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`
      : "";
    $("summaryRewardPool").textContent = campaign.rewardPool || "待核对";
    const pool = parsePool(campaign);
    const rewardPrice = rewardPriceFor(pool?.token);
    $("summaryRewardUsdt").textContent = pool && rewardPrice
      ? `≈ ${formatters.money(pool.amount * rewardPrice, 0)} USDT`
      : "奖励币价格不可用或奖池待核对";
    $("summaryPeriodText").textContent = campaign.period || "时间待确认";
    $("summaryPeriodDetail").textContent = campaign.startTime && campaign.endTime
      ? `${formatters.time(campaign.startTime)} 至 ${formatters.time(campaign.endTime)}`
      : "活动时间待核对";

    if (ranking?.dataStatus === "available") {
      $("summaryTotalVolume").textContent = formatters.compact(ranking.eligibleTradingVolume);
      $("summaryParticipantsCount").textContent = `${formatters.number(ranking.eligibleUserCount)} 人达标`;
      $("summaryCutoffLabel").textContent = `第 ${formatters.number(ranking.cutoffRank)} 名门槛`;
      $("summaryCutoffVolume").textContent = hasNumber(ranking.cutoff1000Volume) ? formatters.money(ranking.cutoff1000Volume)
        : ranking.eligibleUserCount < ranking.cutoffRank ? "人数未达到门槛" : "排名门槛未知";
      $("summaryCutoffDetail").textContent = ranking.sourceUpdatedAt
        ? `源数据：${formatters.time(ranking.sourceUpdatedAt)}`
        : `采集于：${formatters.time(ranking.collectedAt)}`;
    }
  }

  function renderMarketAnalysis() {
    const data = state.marketData;
    const grid = $("marketGrid");
    if (!data) {
      grid.innerHTML = '<div class="empty-state error-text">盘口行情不可用，已停止成本和 ROI 计算。</div>';
      $("marketUpdatedTime").textContent = "行情不可用";
      return;
    }
    $("displayActualFeeRate").textContent = `${(data.actualFeeRate * 100).toFixed(4)}%`;
    $("feeCostFormula").textContent = `每实际成交 1,000 U 基准手续费：$${data.feeCostPer1000.toFixed(3)}`;
    $("marketUpdatedTime").textContent = data.updatedAt
      ? `行情更新：${formatters.time(data.updatedAt)}${data.status === "partial" ? "（部分币对不可用）" : ""}`
      : "行情不可用";
    const cards = data.markets.map(pair => {
      const multiplier = Number(pair.volumeMultiplier) || 1;
      const countedLabel = "榜单计入量";
      return `<article class="market-card">
      <div class="market-card-head"><span class="market-pair-title">${escapeHtml(pair.pair)}${multiplier !== 1 ? ` <em class="pair-multiplier">${multiplier}x 计入</em>` : ""}</span><span class="market-price-val">$${formatters.number(pair.lastPrice, pair.lastPrice >= 1 ? 4 : 8)}</span></div>
      <div class="market-metrics-row"><span>买一 / 卖一</span><span>${escapeHtml(pair.bidPrice)} / ${escapeHtml(pair.askPrice)}</span></div>
      <div class="market-metrics-row"><span>买卖价差</span><span>$${formatters.number(pair.spread, 8)} (${pair.spreadPercent.toFixed(4)}%)</span></div>
      <div class="market-metrics-row"><span>价差成本估算</span><span>$${pair.spreadLossPer1000.toFixed(3)} / 1k 榜单U</span></div>
      <div class="market-cost-highlight"><span class="label">每 1,000 U ${countedLabel}手续费 + 买卖价差</span><span class="value">$${pair.totalCostPer1000.toFixed(3)} USDT</span></div>
      <div class="market-cost-highlight secondary"><span class="label">每 10,000 U ${countedLabel}手续费 + 买卖价差</span><span class="value">$${pair.totalCostPer10k.toFixed(2)} USDT</span></div>
    </article>`;
    });
    const unavailable = (data.unavailableMarkets || []).map(item => `<article class="market-card unavailable"><strong>${escapeHtml(item.pair)}</strong><span>${escapeHtml(item.error)}</span></article>`);
    grid.innerHTML = [...cards, ...unavailable].join("") || '<div class="empty-state error-text">没有可用的参赛币对盘口。</div>';
  }

  function renderRankingAndRoi() {
    const ranking = state.rankingData;
    const market = state.marketData;
    if (!ranking || ranking.dataStatus !== "available") {
      $("rankingUpdateTime").textContent = "排行榜：暂无成功快照";
      $("roiFormulaNote").textContent = "等待完整排行榜和行情";
      return;
    }
    $("rankingUpdateTime").textContent = ranking.sourceUpdatedAt
      ? `源数据：${formatters.time(ranking.sourceUpdatedAt)} · 本地采集：${formatters.time(ranking.collectedAt)}`
      : `本地完整采集：${formatters.time(ranking.collectedAt)}`;
    $("statTotalUsers").textContent = `${formatters.number(ranking.eligibleUserCount)} 人`;
    $("statTotalVolume").textContent = formatters.money(ranking.eligibleTradingVolume);
    $("statTopTitle").textContent = `前 ${formatters.number(ranking.topRankUserCount)} 名统计`;
    $("statTopUsers").textContent = `${formatters.number(ranking.topRankUserCount)} 人`;
    $("statTopVolume").textContent = formatters.money(ranking.topRankingTradingVolume);
    $("statTailTitle").textContent = `第 ${formatters.number(ranking.cutoffRank + 1)} 名起${ranking.distribution === "equal" ? "按人数均分" : "按比例瓜分"}`;
    $("statTailUsers").textContent = `${formatters.number(ranking.otherEligibleUserCount)} 人`;
    $("statTailVolume").textContent = formatters.money(ranking.otherEligibleTradingVolume);

    const token = ranking.otherRewardToken || "奖励币";
    const unavailable1k = rewardStatusText(ranking.rewardPer1kStatus || ranking.rewardEstimateStatus);
    const unavailable10k = rewardStatusText(ranking.rewardPer10kStatus || ranking.rewardEstimateStatus);
    $("rewardPer1kToken").textContent = ranking.rewardPer1k === null ? "—" : `${formatters.token(ranking.rewardPer1k)} ${token}`;
    $("rewardPer1kUsdt").textContent = ranking.rewardPer1k === null ? unavailable1k : ranking.rewardPer1kUsdt === null ? "奖励币价格不可用" : `≈ ${formatters.money(ranking.rewardPer1kUsdt, 4)} USDT`;
    $("rewardPer10kToken").textContent = ranking.rewardPer10k === null ? "—" : `${formatters.token(ranking.rewardPer10k)} ${token}`;
    $("rewardPer10kUsdt").textContent = ranking.rewardPer10k === null ? unavailable10k : ranking.rewardPer10kUsdt === null ? "奖励币价格不可用" : `≈ ${formatters.money(ranking.rewardPer10kUsdt)} USDT`;
    const capNotes = [];
    if (ranking.rewardPer1kCapApplied || ranking.rewardPer10kCapApplied) capNotes.push(`已应用单人上限 ${formatters.token(ranking.otherRewardCap)} ${token}`);
    if (ranking.capReachedAtVolume !== null) capNotes.push(`约 ${formatters.money(ranking.capReachedAtVolume)} 新增榜单计入量达到上限`);
    capNotes.push(ranking.distribution === "equal"
      ? "按新增一名后段参与者均分估算，增加交易量不提高均分份额"
      : "奖励按新增量加入后段分母估算，未计个人已有交易量");
    capNotes.push("假设其他人交易量不变，仅适用于仍处于后段的场景");

    const roi = $("netProfitPer10k");
    const result = calculateRoi();
    if (result) {
      const { best, net, ratio } = result;
      roi.textContent = `${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}${ratio === null ? "" : ` (${ratio >= 0 ? "+" : ""}${ratio.toFixed(1)}%)`}`;
      roi.style.color = net >= 0 ? "var(--color-green)" : "var(--color-red)";
      const marketScopeNote = market.status === "partial" ? "部分币对盘口不可用，仅比较当前可用币对" : "";
      $("roiFormulaNote").textContent = [`基于 ${best.pair} 成本 $${best.totalCostPer10k.toFixed(2)} / 万U榜单计入量`, marketScopeNote, ...capNotes].filter(Boolean).join(" · ");
    } else {
      roi.textContent = "—";
      $("roiFormulaNote").textContent = [ranking.rewardPer10k === null ? unavailable10k : "行情或奖励价格不可用，未计算 ROI", ...capNotes].join(" · ");
    }
  }

  function renderTiers() {
    const ranking = state.rankingData;
    const campaign = state.currentCampaign;
    const tiers = ranking?.tiers || campaign?.tiers || [];
    const bonusRewards = campaign?.bonusRewards || [];
    const grid = $("tierGrid");
    if (!tiers.length && !bonusRewards.length) {
      grid.innerHTML = `<div class="empty-state warning-text">${campaign?.needsReview ? "奖励规则尚未可靠解析，请核对官方公告。" : "暂无阶梯奖励数据。"}</div>`;
      return;
    }
    const tierCards = tiers.map(tier => `<article class="tier-card">
      <p>${escapeHtml(tier.name)}</p>
      <strong>${hasNumber(tier.thresholdVolumeUsd) ? formatters.money(tier.thresholdVolumeUsd, 0) : "等待排行榜"}</strong>
      <div class="tier-reward"><span>单人奖励</span><b>${formatters.token(tier.rewardPerUser)} ${escapeHtml(tier.rewardToken)}</b></div>
      <small>${tier.rewardUsdt !== null && tier.rewardUsdt !== undefined ? `≈ ${formatters.money(tier.rewardUsdt)} USDT` : "奖励估值不可用"}</small>
    </article>`);
    const bonusCards = bonusRewards.map(item => {
      const price = rewardPriceFor(item.rewardToken);
      return `<article class="tier-card bonus-tier">
        <p>${escapeHtml(item.name)}</p>
        <strong>${formatters.token(item.totalReward)} ${escapeHtml(item.rewardToken)}</strong>
        <div class="tier-reward"><span>独立分轮奖池</span><b>${formatters.number(item.roundCount)} 轮</b></div>
        <small>${price ? `≈ ${formatters.money(item.totalReward * price)} USDT · 不计入主榜门槛` : "不计入主榜门槛"}</small>
      </article>`;
    });
    grid.innerHTML = [...tierCards, ...bonusCards].join("");
  }

  function sparkline(values, color) {
    const numbers = values.filter(hasNumber).map(Number);
    if (numbers.length < 2) return '<span class="trend-empty">需要至少两次成功快照</span>';
    const width = 260, height = 64, padding = 4;
    const min = Math.min(...numbers), max = Math.max(...numbers), range = max - min || 1;
    let connected = false;
    const points = [];
    const path = values.map((value, index) => {
      if (!hasNumber(value)) { connected = false; return ""; }
      const x = (padding + index * (width - padding * 2) / (values.length - 1)).toFixed(1);
      const y = (height - padding - (Number(value) - min) / range * (height - padding * 2)).toFixed(1);
      const command = `${connected ? "L" : "M"}${x},${y}`;
      connected = true;
      points.push(`<circle cx="${x}" cy="${y}" r="2" fill="${color}"/>`);
      return command;
    }).join(" ");
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" role="img"><path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>${points.join("")}</svg>`;
  }

  function renderHistory() {
    const grid = $("trendGrid");
    const entries = state.historyData || [];
    if (!entries.length) {
      grid.innerHTML = '<div class="empty-state">完成两次以上排行榜更新后，将显示本地趋势。</div>';
      return;
    }
    const latest = entries[entries.length - 1];
    const cards = [
      { title: "赛区总交易量", values: entries.map(item => item.eligibleTradingVolume), latest: formatters.compact(latest.eligibleTradingVolume), color: "#10b981" },
      { title: `第 ${state.rankingData?.cutoffRank ?? 1000} 名门槛`, values: entries.map(item => item.cutoff1000Volume), latest: formatters.money(latest.cutoff1000Volume), color: "#3b82f6" },
      { title: "后段总交易量", values: entries.map(item => item.otherEligibleTradingVolume), latest: formatters.compact(latest.otherEligibleTradingVolume), color: "#f59e0b" }
    ];
    grid.innerHTML = cards.map(card => `<article class="trend-card"><span>${escapeHtml(card.title)}</span><strong>${card.latest}</strong>${sparkline(card.values, card.color)}<small>${entries.length} 次成功快照</small></article>`).join("");
  }

  function triggerCardsHighlight() {
    document.querySelectorAll(".summary-card,.breakdown-box,.reward-estimate-card").forEach(card => {
      card.classList.add("data-updated-flash");
      setTimeout(() => card.classList.remove("data-updated-flash"), 1000);
    });
  }

  async function triggerCrawl() {
    if (!state.currentCampaign) return;
    const campaignId = state.currentCampaign.id;
    const feeRate = state.feeRate;
    const rebateRate = state.rebateRate;
    state.detailController?.abort();
    const crawlRequestId = ++state.detailRequestId;
    const crawlMarketRequestId = ++state.marketRequestId;
    state.detailLoading = true;
    const button = $("triggerCrawlBtn");
    const box = $("crawlProgressBarContainer");
    const text = $("crawlProgressText");
    const percent = $("crawlProgressPercent");
    const fill = $("crawlProgressBarFill");
    button.disabled = true;
    button.textContent = "正在完整抓取…";
    clearTimeout(state.crawlProgressHideTimer);
    box.classList.remove("hidden");
    let polling = setInterval(async () => {
      const status = await loadSchedulerStatus();
      if (status?.progress) {
        text.textContent = status.progress.text;
        percent.textContent = `${status.progress.percent}%`;
        fill.style.width = `${status.progress.percent}%`;
      }
    }, 700);
    try {
      const data = await api("/api/scheduler/trigger", {
        method: "POST",
        body: JSON.stringify({ campaignId, feeRate, rebateRate })
      });
      text.textContent = "完整性校验通过，排行榜已更新。";
      percent.textContent = "100%";
      fill.style.width = "100%";
      state.nextRunTime = data.status?.nextRunTime || state.nextRunTime;
      const history = await api(`/api/ranking/history?campaignId=${encodeURIComponent(campaignId)}&limit=50`);
      if (crawlRequestId === state.detailRequestId && campaignId === state.currentCampaignId) {
        state.rankingData = data.rankingData;
        if (crawlMarketRequestId === state.marketRequestId) state.marketData = data.marketData;
        state.historyData = history.entries || [];
        renderSummaryCards(); renderMarketAnalysis(); renderRankingAndRoi(); renderTiers(); renderHistory();
        triggerCardsHighlight();
      }
      showImportNotice(campaignId === state.currentCampaignId ? data.message : "后台活动排行榜已更新，当前页面未被切换覆盖", "success");
      state.crawlProgressHideTimer = setTimeout(() => box.classList.add("hidden"), 1200);
    } catch (error) {
      text.textContent = error.message;
      percent.textContent = "失败";
      fill.style.width = "0%";
      showImportNotice(`排行榜更新失败：${error.message}`, "error");
      state.crawlProgressHideTimer = setTimeout(() => box.classList.add("hidden"), 3500);
    } finally {
      if (crawlRequestId === state.detailRequestId) state.detailLoading = false;
      clearInterval(polling);
      button.disabled = false;
      button.textContent = "⚡ 立即更新排行榜";
      await loadSchedulerStatus();
    }
  }

  async function handleParseAnnouncement() {
    const input = $("announcementInput");
    const value = input.value.trim();
    if (!value) return showImportNotice("请输入币安排行榜或公告链接", "error");
    const button = $("parseAnnouncementBtn");
    button.disabled = true;
    button.textContent = "识别中…";
    try {
      const leaderboard = /\/activity\/trading-competition\//i.test(value);
      const data = await api(leaderboard ? "/api/campaigns/add-by-url" : "/api/announcements/parse", {
        method: "POST",
        body: JSON.stringify(leaderboard ? { url: value } : { urlOrCode: value })
      });
      input.value = "";
      showImportNotice(data.message, data.warning ? "warning" : "success");
      const targetId = data.campaign.id;
      await loadCampaigns();
      await selectCampaign(targetId, true);
    } catch (error) {
      showImportNotice(`录入失败：${error.message}`, "error");
    } finally {
      button.disabled = false;
      button.textContent = "＋ 添加监控";
    }
  }

  async function handleDeleteCampaign() {
    const campaign = state.currentCampaign;
    if (!campaign || !confirm(`确定移除活动“${campaign.name}”及其本地快照吗？`)) return;
    try {
      await api("/api/campaigns/delete", { method: "POST", body: JSON.stringify({ id: campaign.id }) });
      state.currentCampaignId = null;
      state.currentCampaign = null;
      const targetId = await loadCampaigns();
      if (targetId) await selectCampaign(targetId, true);
      showImportNotice("活动及其本地快照已删除", "success");
    } catch (error) {
      showImportNotice(`删除失败：${error.message}`, "error");
    }
  }

  async function openAnnouncementModal() {
    const modal = $("announcementModal");
    const container = $("announcementListContainer");
    modal.classList.remove("hidden");
    container.innerHTML = '<div class="loading-spinner">正在读取官方活动公告…</div>';
    try {
      const data = await api("/api/announcements/list");
      const list = (data.articles || []).filter(item => /联赛|锦标赛|竞赛|tournament|competition|交易.*瓜分/i.test(item.title || ""));
      container.innerHTML = list.length ? list.map(item => `<div class="announcement-item"><span class="announcement-title">${escapeHtml(item.title)}</span><button class="btn-secondary small" data-code="${escapeHtml(item.code)}">录入</button></div>`).join("") : '<div class="empty-state">当前列表中没有识别到交易赛公告。</div>';
      container.querySelectorAll("[data-code]").forEach(button => button.addEventListener("click", () => {
        $("announcementInput").value = button.dataset.code;
        modal.classList.add("hidden");
        handleParseAnnouncement();
      }));
    } catch (error) {
      container.innerHTML = `<div class="empty-state error-text">${escapeHtml(error.message)}</div>`;
    }
  }

  function showImportNotice(message, type = "info") {
    const notice = $("importNotice");
    clearTimeout(state.noticeTimer);
    notice.textContent = message;
    notice.className = `import-hint ${type}`;
    state.noticeTimer = setTimeout(() => notice.classList.add("hidden"), 7000);
  }

  function exportAnalysisCsv() {
    const campaign = state.currentCampaign;
    const ranking = state.rankingData;
    const market = state.marketData;
    if (!campaign || ranking?.dataStatus !== "available") return showImportNotice("暂无可导出的成功排行榜快照", "warning");
    const cutoff = ranking.cutoffRank;
    const rows = [
      ["EventLens 本地交易赛分析报告"],
      ["活动名称", campaign.name], ["活动 ID", campaign.id], ["导出时间", new Date().toLocaleString("zh-CN")],
      ["源数据时间", ranking.sourceUpdatedAt || "源接口未提供"], ["本地采集时间", ranking.collectedAt || ""], ["Resource ID", ranking.resourceId || ""], [""],
      ["核心指标"], ["全部参与人数", ranking.eligibleUserCount], ["赛区交易量(USD)", ranking.eligibleTradingVolume],
      [`前${cutoff}名交易量(USD)`, ranking.topRankingTradingVolume], [`第${cutoff + 1}名起交易量(USD)`, ranking.otherEligibleTradingVolume],
      [`第${cutoff}名门槛(USD)`, ranking.cutoff1000Volume ?? "N/A"], ["后段奖池", `${ranking.otherRewardPool} ${ranking.otherRewardToken}`],
      ["单人奖励上限", ranking.otherRewardCap ?? "无"], ["每1000U榜单计入量预计奖励", `${ranking.rewardPer1k ?? "N/A"} ${ranking.otherRewardToken}`],
      ["每10000U榜单计入量预计奖励", `${ranking.rewardPer10k ?? "N/A"} ${ranking.otherRewardToken}`], [""],
      ["每1000U估算状态", rewardStatusText(ranking.rewardPer1kStatus || ranking.rewardEstimateStatus)],
      ["每10000U估算状态", rewardStatusText(ranking.rewardPer10kStatus || ranking.rewardEstimateStatus)],
      ["后段分配方式", ranking.distribution === "equal" ? "按人数均分" : ranking.distribution === "proportional" ? "按交易量比例" : "待核对"],
      ["估算说明", $("roiFormulaNote").textContent],
      ["基础费率", market?.feeRate ?? state.feeRate], ["返佣比例", market?.rebateRate ?? state.rebateRate],
      ["奖励币价格(USDT)", ranking.rewardTokenPrice ?? "N/A"],
      ["每1000U奖励估值(USDT)", ranking.rewardPer1kUsdt ?? "N/A"],
      ["每10000U奖励估值(USDT)", ranking.rewardPer10kUsdt ?? "N/A"],
      ["行情时间", market?.updatedAt || "N/A"], ["总奖池", campaign.rewardPool], [""],
      ["参赛币对成本", "计入倍数", "买一", "卖一", "价差率%", "每千U榜单计入量手续费", "每千U榜单计入量价差成本", "每千U榜单计入量总成本", "每万U榜单计入量总成本"]
    ];
    for (const pair of market?.markets || []) rows.push([pair.pair, pair.volumeMultiplier || 1, pair.bidPrice, pair.askPrice, pair.spreadPercent, pair.feeCostPer1000, pair.spreadLossPer1000, pair.totalCostPer1000, pair.totalCostPer10k]);
    rows.push([""], ["阶梯奖励", "当前门槛", "单人奖励", "USDT估值"]);
    for (const tier of ranking.tiers || []) rows.push([tier.name, tier.thresholdVolumeUsd ?? "N/A", `${tier.rewardPerUser} ${tier.rewardToken}`, tier.rewardUsdt ?? "N/A"]);
    rows.push([""], ["独立分轮奖池", "轮数", "奖池", "USDT估值"]);
    for (const bonus of campaign.bonusRewards || []) {
      const price = rewardPriceFor(bonus.rewardToken);
      rows.push([bonus.name, bonus.roundCount, `${bonus.totalReward} ${bonus.rewardToken}`, price === null ? "N/A" : bonus.totalReward * price]);
    }
    const roi = calculateRoi();
    rows.push([""], ["万U最优币对", roi?.best.pair ?? "N/A"],
      ["万U净收益(USDT)", roi ? roi.net.toFixed(2) : "N/A"],
      ["净收益/成本(%)", roi?.ratio === null || !roi ? "N/A" : roi.ratio.toFixed(1)]);
    const csv = "\ufeff" + rows.map(row => row.map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `EventLens_${campaign.token || "campaign"}_${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function scheduleFeeRefresh() {
    clearTimeout(state.feeTimer);
    state.feeTimer = setTimeout(reloadMarketOnly, 350);
  }

  function bindEvents() {
    $("tabActive").addEventListener("click", async () => {
      state.currentTab = "active";
      $("tabActive").classList.add("active"); $("tabHistory").classList.remove("active");
      const list = state.campaigns.active;
      if (list.length && !list.some(item => item.id === state.currentCampaignId)) await selectCampaign(list[0].id, true);
      else renderCampaignButtons();
    });
    $("tabHistory").addEventListener("click", async () => {
      state.currentTab = "history";
      $("tabHistory").classList.add("active"); $("tabActive").classList.remove("active");
      const list = state.campaigns.history;
      if (list.length && !list.some(item => item.id === state.currentCampaignId)) await selectCampaign(list[0].id, true);
      else renderCampaignButtons();
    });
    $("inputFeeRate").addEventListener("input", event => {
      const value = Number(event.target.value);
      if (Number.isFinite(value) && value >= 0 && value <= 0.02) { state.feeRate = value; scheduleFeeRefresh(); }
    });
    $("inputRebateRate").addEventListener("input", event => {
      const value = Number(event.target.value);
      if (Number.isFinite(value) && value >= 0 && value <= 1) { state.rebateRate = value; scheduleFeeRefresh(); }
    });
    $("refreshBtn").addEventListener("click", async () => {
      await Promise.all([loadBnbPrice(), loadSchedulerStatus(), loadCurrentCampaignDetails({ force: true })]);
      triggerCardsHighlight();
    });
    $("autoUpdateToggle").addEventListener("change", async event => {
      const toggle = event.currentTarget;
      const requested = toggle.checked;
      toggle.disabled = true;
      try {
        await api("/api/scheduler/config", {
          method: "POST",
          body: JSON.stringify({ autoUpdateEnabled: requested })
        });
        await loadSchedulerStatus();
        renderCountdown();
        showImportNotice(requested ? "已开启排行榜自动更新" : "已关闭自动更新，仅保留手动更新", "success");
      } catch (error) {
        toggle.checked = !requested;
        showImportNotice(`保存自动更新设置失败：${error.message}`, "error");
      } finally {
        toggle.disabled = false;
      }
    });
    $("parseAnnouncementBtn").addEventListener("click", handleParseAnnouncement);
    $("announcementInput").addEventListener("keydown", event => { if (event.key === "Enter") handleParseAnnouncement(); });
    $("fetchLatestListBtn").addEventListener("click", openAnnouncementModal);
    $("closeModalBtn").addEventListener("click", () => $("announcementModal").classList.add("hidden"));
    $("announcementModal").addEventListener("click", event => { if (event.target === $("announcementModal")) $("announcementModal").classList.add("hidden"); });
    $("deleteCampaignBtn").addEventListener("click", handleDeleteCampaign);
    $("triggerCrawlBtn").addEventListener("click", triggerCrawl);
    $("exportCsvBtn").addEventListener("click", exportAnalysisCsv);
  }

  async function init() {
    try {
      await initializeSession();
      bindEvents();
      await Promise.all([loadBnbPrice(), loadSchedulerStatus()]);
      const targetId = await loadCampaigns();
      if (targetId) await selectCampaign(targetId, false);
      renderCountdown();
      setInterval(renderCountdown, 1000);
      setInterval(async () => {
        if (document.hidden || state.detailLoading) return;
        const tasks = [loadBnbPrice(), loadSchedulerStatus()];
        if (state.currentCampaign?.status !== "history") tasks.push(loadCurrentCampaignDetails());
        await Promise.all(tasks);
      }, 15000);
    } catch (error) {
      setDetailStatus(`初始化失败：${error.message}`, "error");
    }
  }

  init();
})();
