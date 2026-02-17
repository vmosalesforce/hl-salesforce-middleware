import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

let accessToken = null;
let tokenExpiry = 0;

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL
} = process.env;

async function refreshAccessToken() {
  const tokenUrl = `${SF_INSTANCE_URL}/services/oauth2/token`;

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      refresh_token: SF_REFRESH_TOKEN
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }
  );

  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + 1000 * 60 * 90;
  console.log("🔄 Refreshed Salesforce token");
}

app.post("/webhook", async (req, res) => {
  try {
    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;

    const sfResponse = await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      {
        FirstName: hlData.firstName,
        LastName: hlData.lastName,
        Email: hlData.email
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({ success: true, salesforce: sfResponse.data });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Salesforce call failed" });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
