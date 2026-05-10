const API_BASE = "https://nvh9k4xn.us-west.insforge.app";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "FACT_CHECK") return false;

  factCheck(message.payload, message.token)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        body: { error: error.message || "Fact check request failed" }
      });
    });

  return true;
});

async function factCheck(payload, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/functions/fact-check-word`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }

  return {
    ok: res.ok,
    status: res.status,
    body
  };
}
