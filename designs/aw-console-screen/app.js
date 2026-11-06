// clipped guard: content scrolled fully/partly out of its port is removed from
// the a11y/focus tree (aria-hidden + inert); restored when scrolled back in
const guard = (scroller, kids, axis) => {
  const s = scroller.getBoundingClientRect();
  kids.forEach((k) => {
    const r = k.getBoundingClientRect();
    const out =
      axis === "x"
        ? r.left > s.right - 30 || r.right < s.left + 30
        : r.bottom > s.bottom - 4 || r.top < s.top + 4;
    k.toggleAttribute("inert", out);
    if (out) k.setAttribute("aria-hidden", "true");
    else k.removeAttribute("aria-hidden");
  });
};
const board = document.querySelector(".board");
const cols = [...board.querySelectorAll(".col")];
const tlog = document.querySelector(".tlog");
const clipAll = () => {
  guard(board, cols, "x");
  cols.forEach((c) => guard(c, [...c.querySelectorAll(".card, .col-add")], "y"));
  guard(tlog, [...tlog.children], "y");
};
clipAll();
if (document.fonts?.ready) document.fonts.ready.then(clipAll);
window.addEventListener("load", clipAll);
board.addEventListener("scroll", clipAll, { passive: true });
tlog.addEventListener("scroll", clipAll, { passive: true });
cols.forEach((c) => c.addEventListener("scroll", clipAll, { passive: true }));
new ResizeObserver(clipAll).observe(board);
new ResizeObserver(clipAll).observe(tlog);

// panel tabs
const tabs = document.querySelectorAll(".ptab");
const panels = document.querySelectorAll(".panel");
tabs.forEach((t) =>
  t.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.toggle("on", x === t));
    panels.forEach((p) => {
      const on = p.id === t.dataset.panel;
      p.classList.toggle("on", on);
      p.hidden = !on;
    });
  })
);

// inbox popover
const inboxBtn = document.getElementById("inboxBtn");
const inboxPop = document.getElementById("inboxPop");
inboxBtn.addEventListener("click", () => {
  const open = inboxPop.hidden;
  inboxPop.hidden = !open;
  inboxBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (!inboxPop.hidden && !e.target.closest(".inbox-wrap")) {
    inboxPop.hidden = true;
    inboxBtn.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !inboxPop.hidden) {
    inboxPop.hidden = true;
    inboxBtn.setAttribute("aria-expanded", "false");
    inboxBtn.focus();
  }
});

// conclusion card
const conclBtn = document.getElementById("conclBtn");
const conclBody = document.getElementById("conclBody");
conclBtn.addEventListener("click", () => {
  const open = conclBody.hidden;
  conclBody.hidden = !open;
  conclBtn.setAttribute("aria-expanded", String(open));
  conclBtn.querySelector(".measured").textContent = open
    ? "4 条消息 · 收起"
    : "4 条消息 · 展开";
});

// command confirm — local mock state only
const confirmBox = document.getElementById("confirmBox");
document.getElementById("approveBtn").addEventListener("click", () => {
  confirmBox.classList.add("done");
  confirmBox.querySelector(".c-cmd").textContent = "已批准 · pnpm test 将于 tr-31 后排队 · 10:02";
  confirmBox.querySelector(".c-acts").remove();
});
document.getElementById("rejectBtn").addEventListener("click", () => {
  confirmBox.classList.add("done");
  confirmBox.querySelector(".c-cmd").textContent = "已拒绝 · 任务回报给派发方 · 10:02";
  confirmBox.querySelector(".c-acts").remove();
});
