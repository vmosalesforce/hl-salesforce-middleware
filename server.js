import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const {
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_REFRESH_TOKEN,
  SF_INSTANCE_URL,
  HL_API_KEY,                     // XO Marriage HL token
  HL_LOCATION_ID,                 // XO Marriage HL location
  HL_MARKETING_API_KEY,           // XO Marketing token
  HL_MARKETING_LOCATION_ID        // XO Marketing location
} = process.env;

let accessToken = null;
let tokenExpiry = 0;

// =======================
// HEALTH CHECK
// =======================
app.get("/", (req, res) => {
  res.status(200).send("🚀 HL ↔ SF ↔ XO Marketing Middleware Running");
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
// ROUTE A: HL ➜ SF ➜ XO MARKETING
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
      return res.status(200).json({ skipped: "Missing HL ID" });
    }

    const firstName = hlData.FirstName || "";
    const lastName = hlData.LastName || "Unknown";
    const email = hlData.Email || null;
    const phone = hlData.Phone || null;

    // Check if SF contact exists
    const query = await axios.get(
      `${SF_INSTANCE_URL}/services/data/v60.0/query`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          q: `SELECT Id, XO_Marketing_High_Level_ID__c
              FROM Contact
              WHERE High_Level_ID__c = '${hlContactId}'
              LIMIT 1`
        }
      }
    );

    let sfContactId;
    let marketingAlreadyLinked = false;

    if (query.data.records.length > 0) {
      sfContactId = query.data.records[0].Id;
      marketingAlreadyLinked =
        !!query.data.records[0].XO_Marketing_High_Level_ID__c;
      console.log("⏭ Existing SF contact found:", sfContactId);
    } else {
      const create = await axios.post(
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
      sfContactId = create.data.id;
      console.log("✅ Created in Salesforce:", sfContactId);
    }

    if (!marketingAlreadyLinked) {
      await sendToMarketing(
        firstName,
        lastName,
        email,
        phone,
        sfContactId
      );
    }

    res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ HL ➜ SF Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Middleware failed" });
  }
});

// ======================================================
// ROUTE B: ORGANIC SF ➜ XO MARKETING
// ======================================================
app.post("/sf-webhook", async (req, res) => {
  try {
    console.log("📩 SF ➜ XO Marketing received");

    if (!accessToken || Date.now() > tokenExpiry) {
      await refreshAccessToken();
    }

    const sfData = req.body;

    // 🔒 Skip HL-originated contacts
    if (sfData.Origin_From_HL_c__c === true) {
      console.log("⏭ Skipping HL-originated record");
      return res.status(200).json({ skipped: "HL origin" });
    }

    if (!sfData.Email && !sfData.Phone) {
      return res.status(400).json({ error: "Email or Phone required" });
    }

    // Skip if already linked
    if (sfData.XO_Marketing_High_Level_ID__c) {
      console.log("⏭ Already linked to Marketing");
      return res.status(200).json({ skipped: "Already linked" });
    }

    await sendToMarketing(
      sfData.FirstName,
      sfData.LastName,
      sfData.Email,
      sfData.Phone,
      sfData.Id
    );

    res.status(200).json({ success: true });

  } catch (error) {
    console.error("❌ SF ➜ Marketing Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Middleware failed" });
  }
});

// ======================================================
// SHARED FUNCTION: SEND TO XO MARKETING + WRITEBACK
// ======================================================
async function sendToMarketing(firstName, lastName, email, phone, sfContactId) {

  console.log("📤 Sending to XO Marketing");

  const marketingResponse = await axios.post(
    "https://services.leadconnectorhq.com/contacts/upsert",
    {
      locationId: HL_MARKETING_LOCATION_ID,
      firstName,
      lastName,
      email,
      phone,
      customFields: [
        {
          key: "salesforce_contact_id",
          field_value: sfContactId
        }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${HL_MARKETING_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json"
      }
    }
  );

  const marketingId = marketingResponse.data.contact.id;

  console.log("✅ XO Marketing ID:", marketingId);

  await axios.patch(
    `${SF_INSTANCE_URL}/services/data/v60.0/sobjects/Contact/${sfContactId}`,
    {
      XO_Marketing_High_Level_ID__c: marketingId
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("🔁 Marketing ID written back to Salesforce");
}

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
