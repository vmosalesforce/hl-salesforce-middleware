import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,

  HL_MARKETING_API_KEY,
  HL_MARKETING_LOCATION_ID,

  HL_MARRIAGE_API_KEY,
  HL_MARRIAGE_LOCATION_ID
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

// =======================
// HEALTH CHECK
// =======================
app.get("/", (req, res) => {
  res.status(200).send("🚀 HL ↔ SF Middleware Running (Dual Location)");
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
// HL ➜ SF
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
      return res.status(200).json({ skipped: true });
    }

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

    await axios.post(
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

    console.log("✅ Contact created in Salesforce");
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

// ======================================================
// SF ➜ BOTH XO LOCATIONS
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ Both HL Locations received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const sfData = req.body;

    if (!sfData.Email) {
      return res.status(200).json({ skipped: true });
    }

    // Get full Salesforce contact
    const sfContactResponse = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfData.Id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const contact = sfContactResponse.data;

    async function pushToHL(apiKey, locationId, sfFieldId, locationLabel) {
      console.log(`📤 Sending to ${locationLabel}`);

      // UPSERT CONTACT
      const upsert = await axios.post(
        "https://services.leadconnectorhq.com/contacts/upsert",
        {
          locationId: locationId,
          email: contact.Email,
          firstName: contact.FirstName || "",
          lastName: contact.LastName || "Unknown",
          phone: contact.Phone || contact.HomePhone || null
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Version: "2021-04-15",
            "Content-Type": "application/json"
          }
        }
      );

      const hlContactId = upsert.data.contact?.id;
      console.log(`✅ ${locationLabel} HL Contact ID:`, hlContactId);

      if (!hlContactId) return null;

      // WRITE SALESFORCE ID INTO HL
      await axios.put(
        `https://services.leadconnectorhq.com/contacts/${hlContactId}`,
        {
          customFields: [
            {
              id: sfFieldId,
              value: contact.Id
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Version: "2021-04-15",
            "Content-Type": "application/json"
          }
        }
      );

      console.log(`✅ Salesforce ID written to ${locationLabel}`);
      return hlContactId;
    }

    // 🔹 Push to XO Marketing
    const marketingHLId = await pushToHL(
      HL_MARKETING_API_KEY,
      HL_MARKETING_LOCATION_ID,
      "0w8kYzW7XY8L0rRwxEHA", // Marketing SF ID field
      "XO Marketing"
    );

    // 🔹 Push to XO Marriage
    const marriageHLId = await pushToHL(
      HL_MARRIAGE_API_KEY,
      HL_MARRIAGE_LOCATION_ID,
      "OgA23wE1DwCjXitTl41d", // Marriage SF ID field
      "XO Marriage"
    );

    // WRITE BOTH HL IDS BACK TO SALESFORCE
    await axios.patch(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${contact.Id}`,
      {
        XO_Marketing_High_Level_ID__c: marketingHLId,
        XO_Marriage_High_Level_ID__c: marriageHLId
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Both HL IDs written back to Salesforce");

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ SF ➜ HL Dual Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
