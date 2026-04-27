const axios = require("axios");

// In-memory limiter (works until function cold restart)
const RATE_STORE = {};

const FREE_DAILY_LIMIT = 3;
const COOLDOWN_MS = 10 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

function getIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function validInstagramLink(link = "") {
  return (
    link.includes("instagram.com/reel/") ||
    link.includes("instagram.com/p/")
  );
}

function checkLimit(ip) {
  const now = Date.now();

  if (!RATE_STORE[ip]) RATE_STORE[ip] = { uses: [] };

  RATE_STORE[ip].uses = RATE_STORE[ip].uses.filter(
    (t) => now - t < DAILY_WINDOW_MS
  );

  const uses = RATE_STORE[ip].uses;

  if (uses.length >= FREE_DAILY_LIMIT) {
    const oldest = Math.min(...uses);
    return {
      allowed: false,
      limitType: "quota",
      resetSeconds: Math.ceil(
        (oldest + DAILY_WINDOW_MS - now) / 1000
      ),
    };
  }

  if (uses.length > 0) {
    const last = Math.max(...uses);
    const diff = now - last;

    if (diff < COOLDOWN_MS) {
      return {
        allowed: false,
        limitType: "cooldown",
        remainingSeconds: Math.ceil(
          (COOLDOWN_MS - diff) / 1000
        ),
      };
    }
  }

  return { allowed: true };
}

function recordUse(ip) {
  if (!RATE_STORE[ip]) RATE_STORE[ip] = { uses: [] };
  RATE_STORE[ip].uses.push(Date.now());
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    const { link } = req.body || {};

    if (!link || !validInstagramLink(link)) {
      return res.json({
        success: false,
        error: "Invalid Instagram link",
      });
    }

    const ip = getIp(req);

    const limit = checkLimit(ip);

    if (!limit.allowed) {
      return res.json({
        success: false,
        ...limit,
      });
    }

    const response = await axios.post(
      "https://falconsmmpanel.com/api/v2",
      null,
      {
        params: {
          key: process.env.FALCON_API_KEY,
          action: "add",
          service: 3030,
          quantity: 500,
          link: link,
        },
        timeout: 15000,
      }
    );

    recordUse(ip);

    return res.json({
      success: true,
      order: response.data?.order || null,
    });
  } catch (error) {
    return res.json({
      success: false,
      error: "Order failed",
    });
  }
};
