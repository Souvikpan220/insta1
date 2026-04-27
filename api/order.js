const axios = require("axios");

let RATE_STORE = {};

const FREE_DAILY_LIMIT = 3;
const COOLDOWN_MS = 10 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();

  if (!RATE_STORE[ip]) RATE_STORE[ip] = { uses: [] };

  RATE_STORE[ip].uses = RATE_STORE[ip].uses.filter(
    t => now - t < DAILY_WINDOW_MS
  );

  if (RATE_STORE[ip].uses.length >= FREE_DAILY_LIMIT) {
    const oldest = Math.min(...RATE_STORE[ip].uses);
    return {
      allowed: false,
      limitType: "quota",
      resetSeconds: Math.ceil((oldest + DAILY_WINDOW_MS - now) / 1000)
    };
  }

  if (RATE_STORE[ip].uses.length > 0) {
    const last = Math.max(...RATE_STORE[ip].uses);
    const elapsed = now - last;

    if (elapsed < COOLDOWN_MS) {
      return {
        allowed: false,
        limitType: "cooldown",
        remainingSeconds: Math.ceil((COOLDOWN_MS - elapsed) / 1000)
      };
    }
  }

  return { allowed: true };
}

function recordUse(ip) {
  RATE_STORE[ip].uses.push(Date.now());
}

module.exports = async function(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { link } = req.body;

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";

  const limit = checkRateLimit(ip);

  if (!limit.allowed) {
    return res.json({ success: false, ...limit });
  }

  try {
    const response = await axios.post(
      "https://falconsmmpanel.com/api/v2",
      null,
      {
        params: {
          key: process.env.FALCON_API_KEY,
          action: "add",
          service: 3030,
          link,
          quantity: 500
        }
      }
    );

    recordUse(ip);

    return res.json({
      success: true,
      order: response.data.order
    });

  } catch (err) {
    return res.json({
      success: false,
      error: "Order failed"
    });
  }
};
