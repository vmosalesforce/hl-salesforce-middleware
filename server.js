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

// =======================
// Salesforce Token Refresh
// =======================
async function refreshAccessToken() {
  const response = await axios.post(
    "https://login.salesforce.com/services/oauth2/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      refresh_token: process.env.SF_REFRESH_TOKEN
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }
  );

  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + 1000 * 60 * 90;

  if (response.data.refresh_token) {
    process.env.SF_REFRESH_TOKEN = response.data.refresh_token;
  }

  console.log("🔄 Refreshed Salesforce token");
}

// =======================
// HighLevel ➜ Salesforce
// =======================
app.post("/webhook", async (req, res) => {
  try {
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

    const sfResponse = await axios.post(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact`,
      {
        FirstName: firstName,
        LastName: lastName,
        Email: hlData.Email || hlData.email,
        Phone: hlData.Phone || hlData.phone,
        High_Level_ID__c: hlData.High_Level_ID__c,
        High_Level__c: true
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

// =======================
// Salesforce ➜ HighLevel
// =======================
app.post("/sf-webhook", async (req, res) => {
  try {
    const sfData = req.body;

    // Ensure at least email or phone exists
    if (!sfData.Email && !sfData.Phone) {
      return res.status(400).json({
        error: "Email or Phone required for HighLevel upsert"
      });
    }

    const hlResponse = await axios.post(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        locationId: process.env.HL_LOCATION_ID,
        firstName: sfData.FirstName,
        lastName: sfData.LastName,
        email: sfData.Email,
        phone: sfData.Phone,
        customFields: [
          {
            key: "salesforce_contact_id",
            value: sfData.Id
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HL_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json"
        }
      }
    );

    res.status(200).json({ success: true, highlevel: hlResponse.data });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "HighLevel call failed" });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
