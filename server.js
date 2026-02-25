import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// =======================
// Environment Variables
// =======================
const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  HL_API_KEY,
  HL_LOCATION_ID
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

// =======================
// Health Check
// =======================
app.get("/", (req, res) => {
  res.status(200).send("🚀 HL ↔ SF Middleware Running");
});

// =======================
// Refresh Salesforce Token
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
// HighLevel ➜ Salesforce
// =======================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 HL ➜ SF received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;

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

    let sfContactId;

    // 🔎 Check if already exists by HL ID
    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          q: `SELECT Id FROM Contact WHERE High_Level_ID__c = '${hlData.id}' LIMIT 1`
        }
      }
    );

    if (query.data.records.length > 0) {
      sfContactId = query.data.records[0].Id;
      console.log("⏭ Existing Salesforce contact found:", sfContactId);
    } else {
      const sfResponse = await axios.post(
        `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
        {
          FirstName: firstName,
          LastName: lastName,
          Email: hlData.Email || hlData.email,
          Phone: hlData.Phone || hlData.phone,
          High_Level_ID__c: hlData.id
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          }
        }
      );

      sfContactId = sfResponse.data.id;
      console.log("✅ Contact created in Salesforce:", sfContactId);
    }

    // 🔁 Write Salesforce ID back to HighLevel
    await axios.put(
      `https://services.leadconnectorhq.com/contacts/${hlData.id}`,
      {
        customFields: [
          {
            id: "0w8kYzW7XY8L0rRwxEHA", // Your SF Contact ID field ID in HL
            field_value: sfContactId
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

    console.log("🔁 Salesforce ID written back to HighLevel");

    res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Salesforce call failed" });
  }
});

// =======================
// Salesforce ➜ HighLevel
// =======================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ HL received");

    const sfData = req.body;

    // Prevent infinite loop
    if (sfData.High_Level_ID__c) {
      console.log("⏭ Already synced to HL");
      return res.status(200).json({ skipped: "Already synced" });
    }

    if (!sfData.Email && !sfData.Phone) {
      return res.status(400).json({
        error: "Email or Phone required"
      });
    }

    // 🔁 Send to HighLevel
    const hlResponse = await axios.post(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        locationId: HL_LOCATION_ID,
        firstName: sfData.FirstName,
        lastName: sfData.LastName,
        email: sfData.Email,
        phone: sfData.Phone
      },
      {
        headers: {
          Authorization: `Bearer ${HL_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json"
        }
      }
    );

    const hlContactId = hlResponse.data.contact.id;

    console.log("✅ Sent to HighLevel:", hlContactId);

    // Refresh SF token if needed
    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    // 🔁 Write HL Contact ID back to Salesforce
    await axios.patch(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfData.Id}`,
      {
        High_Level_ID__c: hlContactId
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("🔁 HL ID written back to Salesforce");

    res.status(200).json({
      success: true,
      highlevel: hlResponse.data
    });

  } catch (error) {
    console.error("❌ SF ➜ HL Error:", error.response?.data || error.message);
    res.status(500).json({ error: "HighLevel call failed" });
  }
});

// =======================
app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
