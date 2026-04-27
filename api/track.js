const axios = require("axios");

module.exports = async function(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await axios.post(process.env.VISITOR_WEBHOOK, {
      content: "New visitor on website"
    });

    res.json({ success: true });

  } catch {
    res.json({ success: false });
  }
};
