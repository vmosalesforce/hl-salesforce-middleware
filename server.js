import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// =====================================
// Health Check Route (Required)
// =====================================
app.get("/", (req, res) => {
  res.status(200).send("Middleware is running");
});

let accessToken = null;
let tokenExpiry = 0;

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  HL_API_KEY,
  HL_LOCATION_ID
} = process.env;

// =====================================
// Salesforce Token Refresh
// =====================================
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

  console.log("🔄 Refreshed Salesforce token");
}

// =====================================
// HighLevel ➜ Salesforce (UPSERT SAFE)
// =====================================
app.post("/webhook", async (req, res) => {
  try {
    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;

    const hlId = hlData.id || hlData.High_Level_ID__c;

    if (!hlId) {
      return res.status(400).json({
        error: "HighLevel ID missing"
      });
    }

    const firstName =
      hlData.FirstName ||
      hlData.firstName ||
      hlData.first_name ||
      "";

    let lastName =
      hlData.LastName ||
      hlData.lastName ||
      hlData.last_name ||
      "";

    if (!lastName || lastName.includes("{{")) {
      lastName = "Unknown";
    }

    // 🔥 UPSERT by External ID (Prevents duplicates)
    await axios.patch(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/High_Level_ID__c/${hlId}`,
      {
        FirstName: firstName,
        LastName: lastName,
        Email: hlData.Email || hlData.email,
        Phone: hlData.Phone || hlData.phone,
        High_Level_ID__c: hlId,
        High_Level__c: true
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({ success: true });

  } catch (error) {
    console.error("HL ➜ SF Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Salesforce upsert failed" });
  }
});

// =====================================
// Salesforce ➜ HighLevel
// =====================================
app.post("/sf-webhook", async (req, res) => {
  try {
    const sfData = req.body;

    // Prevent loop
    if (sfData.High_Level__c === true) {
      return res.status(200).json({
        skipped: "Originated from HighLevel"
      });
    }

    if (!sfData.Email && !sfData.Phone) {
      return res.status(400).json({
        error: "Email or Phone required"
      });
    }

    const hlResponse = await axios.post(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        locationId: HL_LOCATION_ID,
        firstName: sfData.FirstName,
        lastName: sfData.LastName,
        email: sfData.Email,
        phone: sfData.Phone,
        customFields: [
          {
            id: "0w8kYzW7XY8L0rRwxEHA",
            field_value: sfData.Id
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HL_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({ success: true, highlevel: hlResponse.data });

  } catch (error) {
    console.error("SF ➜ HL Error:", error.response?.data || error.message);
    res.status(500).json({ error: "HighLevel upsert failed" });
  }
});

// =====================================
// Start Server
// =====================================
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
