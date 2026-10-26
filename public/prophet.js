(() => {
  const el = id => document.getElementById(id);
  let sessionToken;
  let snapshot = null;
  let busy = false;
  let initialization;
  const detailPages = { season: null, weekly: null };
  const kinds = ["season", "weekly"];
  function formatPoints(value) {
    if (value === null) return "暂无该名次";
    const [integer, fraction = ""] = String(value).split(".");
    const tail = fraction.replace(/0+$/, "");
    return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (tail ? `.${tail}` : "");
  }
  const date = value => new Date(value).toLocaleString("zh-CN", { hour12: false });
  function status(message, error = false) {
    el("prophetStatus").textContent = message;
    el("prophetStatus").dataset.error = String(error);
  }
  function renderBoard(kind, board) {
    el(`${kind}Unit`).textContent = `奖励（${board.unit}）`;
    const body = el(`${kind}Rows`);
    body.replaceChildren();
    for (const tier of board.thresholds) {
      const row = document.createElement("tr");
      const rank = tier.rankFrom === tier.rankTo ? `${tier.rankTo}` : `${tier.rankFrom.toLocaleString()}–${tier.rankTo.toLocaleString()}`;
      for (const text of [rank, formatPoints(tier.points), formatPoints(tier.rewardAmount)]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "prophet-rank-toggle prophet-data-action";
      toggle.textContent = `${rank} ▾`;
      toggle.setAttribute("aria-controls", `${kind}Details`);
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const previous = detailPages[kind];
        if (!el(`${kind}Details`).hidden && previous?.from === tier.rankFrom && previous?.to === tier.rankTo) {
          el(`${kind}Details`).hidden = true;
          updateControls();
        } else return loadRange(kind, tier.rankFrom, tier.rankTo, tier.rankFrom);
      });
      row.children[0].replaceChildren(toggle);
      body.append(row);
    }
    detailPages[kind] = null;
    el(`${kind}Details`).hidden = true;
    el(`${kind}DetailStatus`).textContent = "";
    el(`${kind}RankSearch`).max = board.thresholds.at(-1).rankTo;
    updateControls();
  }
  function updateControls() {
    document.querySelectorAll("#prophetPanel .prophet-data-action").forEach(button => { button.disabled = busy || !snapshot; });
    el("weeklySelect").disabled = busy || !snapshot;
    for (const kind of kinds) {
      const page = detailPages[kind];
      el(`${kind}Prev`).disabled = busy || !page || page.start <= page.from;
      el(`${kind}Next`).disabled = busy || !page || page.start + 50 > page.to || page.rows.length < 50;
      document.querySelectorAll(`#${kind}Rows .prophet-rank-toggle`).forEach((button, index) => {
        const tier = snapshot?.[kind]?.thresholds[index];
        button.setAttribute("aria-expanded", String(!el(`${kind}Details`).hidden && page?.from === tier?.rankFrom && page?.to === tier?.rankTo));
      });
    }
  }
  async function loadRange(kind, from, to, start) {
    if (busy || !snapshot) return;
    const max = snapshot[kind].thresholds.at(-1).rankTo;
    if (![from, to, start].every(Number.isSafeInteger) || from < 1 || to < from || to > max || start < from || start > to) {
      el(`${kind}DetailStatus`).textContent = `请输入 1 至 ${max.toLocaleString()} 的整数名次。`;
      return;
    }
    busy = true;
    el("prophetRefresh").disabled = true;
    updateControls();
    el(`${kind}DetailStatus`).textContent = "正在读取逐名明细；必要时逐页采集，请稍候…";
    try {
      const end = Math.min(start + 49, to);
      const data = await api("/api/prophet/ranks", { method: "POST", body: JSON.stringify({ board: kind, rankFrom: start, rankTo: end,
        ...(kind === "weekly" ? { weekIndex: snapshot.week.weekIndex } : {}) }) });
      const body = el(`${kind}DetailRows`);
      body.replaceChildren();
      for (const entry of data.rows) {
        const row = document.createElement("tr");
        for (const value of [entry.rank.toLocaleString(), formatPoints(entry.points), `${formatPoints(entry.estimateReward)} ${data.unit}`]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        body.append(row);
      }
      detailPages[kind] = { from, to, start, rows: data.rows };
      el(`${kind}Details`).hidden = false;
      el(`${kind}DetailTitle`).textContent = from === to ? `第 ${from.toLocaleString()} 名` : `第 ${from.toLocaleString()}–${to.toLocaleString()} 名明细`;
      el(`${kind}DetailTime`).textContent = `明细采集 · ${date(data.collectedAt)}（不代表官方更新时间）`;
      el(`${kind}PageInfo`).textContent = `${start.toLocaleString()}–${end.toLocaleString()}`;
      el(`${kind}DetailStatus`).textContent = data.rows.length ? "分数保留官方完整精度；明细与上方门槛的采集时间可能不同。" : "当前榜单暂无该名次。";
    } catch (error) {
      el(`${kind}DetailStatus`).textContent = `${error.message}。${detailPages[kind] ? "仍保留上次成功明细。" : "可稍后重试。"}`;
    } finally {
      busy = false;
      el("prophetRefresh").disabled = false;
      updateControls();
    }
  }
  function updateWeekState() {
    if (!snapshot) return;
    const week = snapshot.week;
    const now = Date.now();
    const state = now < week.startMs ? "未开始" : now >= week.endMs ? "已结束" : "本周";
    el("weeklyTitle").textContent = `第 ${week.weekIndex} 周 · ${state}`;
    el("weeklyPeriod").textContent = `${date(week.startMs)} — ${date(week.endMs)}`;
    // 本地校时只更新选项标签，不改变正在查看的周次或重新采集。
    for (const option of el("weeklySelect").children) {
      const entry = (snapshot.weeks || [week]).find(item => String(item.weekIndex) === option.value);
      if (!entry) continue;
      const label = now < entry.startMs ? "未开始" : now >= entry.endMs ? "已结束" : "本周";
      option.textContent = `第 ${entry.weekIndex} 周 · ${label}`;
      option.disabled = now < entry.startMs && entry.weekIndex !== week.weekIndex;
    }
  }
  function render(data) {
    snapshot = data;
    if (!snapshot) return;
    el("prophetTime").textContent = `采集时间 · ${date(snapshot.collectedAt)}`;
    el("seasonPeriod").textContent = snapshot.seasonId;
    const select = el("weeklySelect");
    select.replaceChildren();
    for (const week of snapshot.weeks || [snapshot.week]) {
      const option = document.createElement("option");
      option.value = String(week.weekIndex);
      select.append(option);
    }
    select.value = String(snapshot.week.weekIndex);
    updateWeekState();
    renderBoard("season", snapshot.season);
    renderBoard("weekly", snapshot.weekly);
  }
  async function api(path, options = {}, retry = true) {
    if (options.method === "POST" && !sessionToken) {
      const response = await fetch("/api/session", { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取本地会话，请刷新页面");
      sessionToken = (await response.json()).token;
    }
    const response = await fetch(path, { cache: "no-store", ...options,
      headers: { "Content-Type": "application/json", "X-EventLens-Token": sessionToken || "", ...options.headers } });
    const data = await response.json();
    if (response.status === 403 && retry) {
      const session = await fetch("/api/session", { cache: "no-store" });
      if (!session.ok) throw new Error("无法读取本地会话，请刷新页面");
      sessionToken = (await session.json()).token;
      return api(path, options, false);
    }
    if (!response.ok) throw new Error(data.error || "读取失败，请稍后重试");
    return data;
  }
  async function refresh(weekIndex = snapshot?.week?.weekIndex) {
    if (busy) return;
    busy = true;
    el("prophetRefresh").disabled = true;
    el("prophetRefresh").textContent = "正在刷新…";
    updateControls();
    status(snapshot ? "正在更新，当前仍显示上次成功数据；必要时逐页采集，可能需要约 2 分钟。" : "正在获取官方榜单，必要时逐页采集，可能需要约 2 分钟。" );
    try {
      const data = await api("/api/prophet/refresh", { method: "POST", body: JSON.stringify(weekIndex === undefined ? {} : { weekIndex }) });
      render(data.snapshot);
      status("已更新。分数保留官方精度，奖励以官方最终结果为准。");
      document.dispatchEvent(new Event("eventlens:prophet-updated"));
    } catch (error) {
      if (snapshot) el("weeklySelect").value = String(snapshot.week.weekIndex);
      status(`${error.message}。${snapshot ? "当前显示上次成功数据，未被覆盖。" : "尚无成功数据，可稍后重试。"}`, true);
    } finally {
      busy = false;
      el("prophetRefresh").disabled = false;
      el("prophetRefresh").textContent = "刷新榜单";
      updateControls();
    }
  }
  async function init() {
    el("prophetRefresh").addEventListener("click", () => refresh());
    el("weeklySelect").addEventListener("change", () => {
      const weekIndex = Number(el("weeklySelect").value);
      if (!snapshot || busy || weekIndex === snapshot.week.weekIndex) return;
      if (!(snapshot.weeks || [snapshot.week]).some(week => week.weekIndex === weekIndex)) return;
      return refresh(weekIndex);
    });
    for (const kind of kinds) {
      el(`${kind}SearchForm`).addEventListener("submit", event => {
        event.preventDefault();
        const value = el(`${kind}RankSearch`).value.trim();
        if (!/^[1-9]\d*$/.test(value)) {
          el(`${kind}DetailStatus`).textContent = "请输入有效的整数名次。";
          return;
        }
        const rank = Number(value);
        return loadRange(kind, rank, rank, rank);
      });
      for (const [suffix, direction] of [["Prev", -1], ["Next", 1]]) {
        el(`${kind}${suffix}`).addEventListener("click", () => {
          const page = detailPages[kind];
          if (page) return loadRange(kind, page.from, page.to, page.start + direction * 50);
        });
      }
    }
    try {
      const data = await api("/api/prophet");
      render(data.snapshot);
      status(data.refreshing ? "另一个页面正在刷新，完成后点击刷新榜单获取最新结果。" : snapshot ? "当前显示本机保存的数据；可选择历史周次，点击刷新榜单更新所选周。" : "尚未采集。点击刷新榜单获取赛季与本周门槛，之后可选择历史周次。");
    } catch (error) { status(error.message, true); }
    finally { el("prophetRefresh").disabled = false; }
  }
  function open(event) {
    const activity = event.detail;
    el("prophetActivityName").textContent = activity.name;
    el("prophetPeriod").textContent = `${date(activity.startTime)} — ${date(activity.endTime)}`;
    el("prophetActivityState").textContent = activity.status === "history" ? "已过期 · 仅手动更新" : activity.status === "upcoming" ? "即将开始" : "进行中 · 仅手动更新";
    el("prophetActivityState").className = `status-badge ${activity.status === "active" ? "active-status" : "history-status"}`;
    updateWeekState();
    if (!initialization) initialization = init();
    return initialization;
  }
  document.addEventListener("eventlens:prophet-open", open);
  // 只校正本地时间标签，断网也不把旧周当作本周；不触发任何数据采集。
  document.addEventListener("visibilitychange", updateWeekState);
  setInterval(updateWeekState, 60_000);
})();
