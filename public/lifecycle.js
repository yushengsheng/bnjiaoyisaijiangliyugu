(() => {
  let stream;
  let retry;
  let leaving = false;
  async function connect() {
    clearTimeout(retry);
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      if (!response.ok) throw new Error("session unavailable");
      const session = await response.json();
      if (leaving || !session.desktop) return;
      stream?.close();
      stream = new EventSource(`/api/desktop/page?token=${encodeURIComponent(session.token)}`);
      stream.onerror = () => {
        stream.close();
        if (!leaving) retry = setTimeout(connect, 2000);
      };
    } catch (_) {
      if (!leaving) retry = setTimeout(connect, 2000);
    }
  }
  window.addEventListener("pagehide", () => { leaving = true; clearTimeout(retry); stream?.close(); });
  window.addEventListener("pageshow", () => { leaving = false; connect(); });
})();
