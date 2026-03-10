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
  res.status(200).send("🚀 HL ↔ SF Middleware Running");
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
// SF ➜ HL (MARKETING OR MARRIAGE)
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ HL received");

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

    // 🔎 Decide destination
    // You can control this using a Salesforce field
    const destination = contact.Send_to_HL_Location__c; 
    // Example values: "Marketing" or "Marriage"

    let apiKey;
    let locationId;
    let sfFieldId;

    if (destination === "Marriage") {
      apiKey = HL_MARRIAGE_API_KEY;
      locationId = HL_MARRIAGE_LOCATION_ID;
      sfFieldId = "OgA23wE1DwCjXitTl41d"; // Marriage SF ID field
      console.log("➡ Sending to XO Marriage");
    } else {
      apiKey = HL_MARKETING_API_KEY;
      locationId = HL_MARKETING_LOCATION_ID;
      sfFieldId = "0w8kYzW7XY8L0rRwxEHA"; // Marketing SF ID field
      console.log("➡ Sending to XO Marketing");
    }

    // =======================
    // UPSERT CONTACT IN HL
    // =======================
    const hlUpsertResponse = await axios.post(
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

    const hlContactId = hlUpsertResponse.data.contact?.id;

    console.log("✅ HL Contact ID:", hlContactId);

    // =======================
    // WRITE SF ID INTO HL
    // =======================
    if (hlContactId) {
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

      console.log("✅ Salesforce ID written to correct HL location");
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ SF ➜ HL Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
