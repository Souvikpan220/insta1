const axios = require("axios");

let store = {};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ success:false });
  }

  const { link } = req.body || {};

  if (!link) {
    return res.json({ success:false, error:"Missing link" });
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
          quantity: 500,
          link: link
        }
      }
    );

    return res.json({
      success: true,
      order: response.data.order || null
    });

  } catch (e) {
    return res.json({
      success:false,
      error:"API failed"
    });
  }
};
