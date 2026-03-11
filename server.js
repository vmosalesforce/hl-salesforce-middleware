import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

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
// HL ➜ SF
// ======================================================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 HL ➜ SF received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const hlData = req.body;
    const hlContactId = hlData.contact?.id || hlData.id;

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
        FirstName: hlData.firstName || "",
        LastName: hlData.lastName || "Unknown",
        Email: hlData.email || null,
        Phone: hlData.phone || null,
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

    console.log("✅ Created in Salesforce");
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

// ======================================================
// SF ➜ XO MARKETING (WITH SF ID WRITE BACK TO HL)
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ XO Marketing received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const sfData = req.body;

    if (!sfData.Id) {
      return res.status(200).json({ skipped: true });
    }

    const sfContactResponse = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfData.Id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const contact = sfContactResponse.data;

    if (!contact.Email) {
      return res.status(200).json({ skipped: true });
    }

    console.log("📤 Upserting contact in HL");

    // 1️⃣ UPSERT CONTACT
    const hlUpsertResponse = await axios.post(
      "https://services.leadconnectorhq.com/contacts/upsert",
      {
        locationId: HL_LOCATION_ID,
        email: contact.Email,
        firstName: contact.FirstName || "",
        lastName: contact.LastName || "Unknown",
        phone: contact.Phone || contact.HomePhone || null
      },
      {
        headers: {
          Authorization: `Bearer ${HL_API_KEY}`,
          Version: "2021-04-15",
          "Content-Type": "application/json"
        }
      }
    );

    const hlContactId = hlUpsertResponse.data.contact?.id;

    console.log("✅ HL Contact ID:", hlContactId);

    if (!hlContactId) {
      return res.status(200).json({ success: true });
    }

    // 2️⃣ WRITE SF ID INTO HL (THIS IS WHAT YOU WANTED)
    await axios.put(
      `https://services.leadconnectorhq.com/contacts/${hlContactId}`,
      {
        customFields: [
          {
            id: "OgA23wE1DwCjXitTl41d", // Salesforce Contact ID field
            value: contact.Id
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

    console.log("✅ Salesforce ID written to XO HL");

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ SF ➜ HL Error:", error.response?.data || error.message);
    return res.status(200).json({ handled: true });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
