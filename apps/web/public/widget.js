(function () {
  var script = document.currentScript;
  if (!script) return;
  var token = script.getAttribute("data-chaste");
  if (!token) return;
  var origin = new URL(script.src).origin;

  var wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:system-ui";

  var frame = document.createElement("iframe");
  frame.src = origin + "/widget/" + encodeURIComponent(token);
  frame.title = "Chat with us";
  frame.style.cssText =
    "display:none;width:372px;height:560px;max-height:calc(100vh - 100px);max-width:calc(100vw - 40px);border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);background:#fff";

  var btn = document.createElement("button");
  btn.setAttribute("aria-label", "Open chat");
  btn.style.cssText =
    "display:flex;align-items:center;gap:8px;margin-left:auto;padding:12px 18px;border:0;border-radius:999px;background:#38000a;color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(56,0,10,.35)";
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Chat with us';
  var open = false;
  btn.onclick = function () {
    open = !open;
    frame.style.display = open ? "block" : "none";
    btn.setAttribute("aria-label", open ? "Close chat" : "Open chat");
  };

  wrap.appendChild(frame);
  wrap.appendChild(btn);
  document.body.appendChild(wrap);
})();
