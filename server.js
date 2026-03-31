import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  HL_API_KEY
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
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + 1000 * 60 * 90;

  console.log("🔄 Salesforce token refreshed");
}

// ======================================================
// HL ➜ SF (ONLY direction allowed)
// ======================================================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 HL ➜ SF received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;
    const hlContactId = hlData.High_Level_ID__c;

    if (!hlContactId) {
      console.log("⚠ No HL Contact ID provided");
      return res.status(200).json({ skipped: true });
    }

    // Check if Contact already exists in Salesforce
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
      console.log("⏭ Existing SF contact found");
      return res.status(200).json({ success: true });
    }

    // Create Contact in Salesforce
    const sfCreateResponse = await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      {
        FirstName: hlData.FirstName || "",
        LastName: hlData.LastName || "Unknown",
        Email: hlData.Email || null,
        Phone: hlData.Phone || null,
        HomePhone: hlData.HomePhone || null,
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

    const sfId = sfCreateResponse.data.id;

    console.log("✅ Contact created in Salesforce:", sfId);

    // ======================================================
    // WRITE SF ID BACK TO HL
    // ======================================================
    await axios.put(
      `https://services.leadconnectorhq.com/contacts/${hlContactId}`,
      {
        customFields: [
          {
            id: "0w8kYzW7XY8L0rRwxEHA", // Your Salesforce ID custom field in HL
            value: sfId
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HL_API_KEY}`,
          Version: "2021-04-15",
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ SF ID written back to HL");

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

// ======================================================
// SF ➜ HL DISABLED
// ======================================================
// We intentionally do NOT allow Salesforce-created contacts
// to be pushed into HighLevel anymore.

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
