// Poll widget: the capability token in the URL identifies (poll, member); it was sent only in that
// member's own DM. Options post their id; "Other" text is mapped to the closest option by the agent.
(() => {
  // Skips ngrok's free-tier browser warning on API calls (harmless behind any other tunnel).
  const SKIP_WARNING = { "ngrok-skip-browser-warning": "1" };
  const token = location.pathname.split("/").filter(Boolean)[1] ?? "";
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  async function load() {
    const res = await fetch(`/api/polls/${encodeURIComponent(token)}`, { cache: "no-store", headers: SKIP_WARNING });
    if (!res.ok) {
      $("question").textContent = "This vote link isn't valid.";
      $("submit").disabled = true;
      return;
    }
    const poll = await res.json();
    $("question").textContent = poll.question;
    $("options").innerHTML = poll.options
      .map(
        (o, i) =>
          `<label class="choice"><input type="radio" name="choice" value="${esc(o.id)}" ${
            o.id === poll.myOptionId ? "checked" : ""
          }> <span>${i + 1}. ${esc(o.label)}</span></label>`,
      )
      .join("");
    const closed = poll.status !== "open";
    $("submit").disabled = closed;
    $("status").textContent = closed
      ? "This vote is closed."
      : `${poll.votesCast}/${poll.voters} votes in${poll.myOptionId ? " · you've voted (you can change it)" : ""}`;
  }

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const other = $("other").value.trim();
    const picked = document.querySelector("input[name=choice]:checked");
    const body = other ? { otherText: other } : picked ? { optionId: picked.value } : null;
    if (!body) {
      $("status").textContent = "Pick an option or type your own.";
      return;
    }
    $("submit").disabled = true;
    $("status").textContent = "Sending…";
    try {
      const res = await fetch(`/api/polls/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...SKIP_WARNING },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (res.ok) {
        $("other").value = "";
        await load();
        $("status").textContent = `✅ Counted: ${result.label}`;
      } else {
        $("status").textContent =
          result.error === "no_matching_option"
            ? "I couldn't match that to an option — pick one above."
            : result.error === "poll_closed"
              ? "This vote is closed."
              : "Couldn't record your vote. Try again.";
      }
    } catch {
      $("status").textContent = "Network error — try again.";
    } finally {
      $("submit").disabled = false;
    }
  });

  load();
})();
