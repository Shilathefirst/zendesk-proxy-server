require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ZENDESK_DOMAIN = process.env.ZENDESK_DOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

//proxy endpoint
app.post("/proxy", async (req, res) => {
  try {
    const { method, url, data } = req.body;

      if (!url.startsWith("/api/v2/")) {
      return res.status(400).json({ error: "Invalid Zendesk API path" });
    }

    const response = await axios({
      method,
      url: `https://${ZENDESK_DOMAIN}.zendesk.com${url}`,
      data,
      auth: {
        username: `${ZENDESK_EMAIL}/token`,
        password: ZENDESK_API_TOKEN,
      },
    });

    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      details: error.response?.data,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
