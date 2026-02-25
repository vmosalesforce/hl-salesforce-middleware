import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

// =======================
// HEALTH CHECK
// =======================
app.get("/", (req, res) => {
  res.status(200).send("🚀 HL ➜ SF Middleware Running");
});

// =======================
// REFRESH SALESFORCE TOKEN
// =======================
async function refreshAccessToken() {
  const response = await axios.post(
    "https://login.salesforce.com/services/oauth2/token",
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

  console.log("🔄 Salesforce token refreshed");
}

// =======================
// HL ➜ SF
// =======================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 HL ➜ SF received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;

    const hlContactId = hlData.High_Level_ID__c;

    if (!hlContactId) {
      console.log("⚠️ Missing High_Level_ID__c");
      return res.status(200).json({ skipped: "Missing HL ID" });
    }

    const firstName = hlData.FirstName || "";
    const lastName = hlData.LastName || "Unknown";
    const email = hlData.Email || null;
    const phone = hlData.Phone || null;

    // 🔎 Check if contact already exists
    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          q: `SELECT Id FROM Contact WHERE High_Level_ID__c = '${hlContactId}' LIMIT 1`
        }
      }
    );

    if (query.data.records.length > 0) {
      console.log("⏭ Existing SF contact found:", query.data.records[0].Id);
      return res.status(200).json({ success: true });
    }

    // ✅ Create Contact
    const sfResponse = await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      {
        FirstName: firstName,
        LastName: lastName,
        Email: email,
        Phone: phone,
        High_Level_ID__c: hlContactId,
        Origin_From_HL_c__c: true
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Contact created in Salesforce:", sfResponse.data.id);

    res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Salesforce call failed" });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
